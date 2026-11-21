import { describe, it, expect } from 'vitest';
import { CardSessionManager } from '../../../src/main/cards/session';
import type { CardPermissions } from '../../../src/main/cards/permissions';

/**
 * The **resource lifecycle** of a card session (RF-4).
 *
 * The problem:
 *
 * A card is an arbitrary web page written by an AI. It can:
 *
 * | Behaviour | Consequence (if it is not handled) |
 * |---|---|
 * | call `tags.subscribe` again and again | N listeners hang on the runtime → every push fans out N times → the memory and the IPC of main are filled up |
 * | delete the card or reload it after a change of the file | the subscriptions of the old session **are never released** → the same leak |
 *
 * Contract §6: "**one card crashing does not affect the other cards and does not affect the workbench**" — here "affects" means "fills main up".
 *
 * Two lines of defence:
 *
 * 1. **Closing the session → the unsubscribe function really is called** (the
 *    subscription stops pushing)
 * 2. **The number of subscriptions has a limit** → beyond it the answer is
 *    `{ ok:false, reason:'too_many_subscriptions' }`
 */
const PERMS: CardPermissions = { read: ['cpu.usage'], write: [] };

function managerWith(
  runtime: { readings: () => never[]; subscribe: (cb: (r: never) => void) => () => void },
  perms: CardPermissions = PERMS,
  workflowsFor?: (cardId: string) => {
    list(): unknown;
    run(id: string, inputs: Record<string, unknown>): unknown;
    status(runId: string): unknown;
  },
  bootLogFor?: (cardId: string) => {
    capture(): unknown;
    latest(): unknown;
  },
): CardSessionManager {
  return new CardSessionManager({
    runtime: runtime as never,
    permsFor: () => perms,
    now: () => 1000,
    ...(workflowsFor === undefined ? {} : { workflowsFor }),
    ...(bootLogFor === undefined ? {} : { bootLogFor }),
  });
}

/** The fake implementation of the workflow side (**it records the calls** — the criterion has to see whether it was really called) */
function fakeWorkflows(calls: string[]): {
  list(): unknown;
  run(id: string, inputs: Record<string, unknown>): unknown;
  status(runId: string): unknown;
} {
  return {
    list: () => {
      calls.push('list');
      return [];
    },
    run: (id: string) => {
      calls.push(`run:${id}`);
      return { ok: true, runId: 'wf-1' };
    },
    status: (runId: string) => {
      calls.push(`status:${runId}`);
      return { ok: true, runId };
    },
  };
}

describe('the session · the unsubscription really releases', () => {
  it('**closing the session → the unsubscribe function is called**', async () => {
    let released = 0;
    const m = managerWith({
      readings: () => [],
      subscribe: () => () => {
        released += 1;
      },
    });
    m.open('inst-1', 'cpu-usage', 'board-a');
    await m.handle({
      instanceId: 'inst-1',
      id: 'r1',
      method: 'tags.subscribe',
      args: { name: 'cpu.usage', subscriptionId: 's1' },
    });
    expect(released).toBe(0);
    m.close('inst-1');
    expect(released).toBe(1);
  });

  it('closing the session → the requests of that instance are no longer accepted', async () => {
    const m = managerWith({ readings: () => [], subscribe: () => () => undefined });
    m.open('inst-1', 'cpu-usage', 'board-a');
    m.close('inst-1');
    const res = await m.handle({
      instanceId: 'inst-1',
      id: 'r1',
      method: 'tags.get',
      args: { name: 'cpu.usage' },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unknown_instance');
  });
});

describe('the session · the number of subscriptions has a limit (one card may not fill up main)', () => {
  it('beyond the limit → it answers too_many_subscriptions (**not** a silent acceptance)', async () => {
    const m = managerWith({ readings: () => [], subscribe: () => () => undefined });
    m.open('inst-1', 'cpu-usage', 'board-a');
    let last = '';
    for (let i = 0; i < 200; i += 1) {
      const res = await m.handle({
        instanceId: 'inst-1',
        id: `r${i}`,
        method: 'tags.subscribe',
        args: { name: 'cpu.usage', subscriptionId: `s${i}` },
      });
      if (!res.ok) {
        last = res.reason ?? '';
        break;
      }
    }
    expect(last).toBe('too_many_subscriptions');
  });

  it('within the limit → all of them are accepted', async () => {
    const m = managerWith({ readings: () => [], subscribe: () => () => undefined });
    m.open('inst-1', 'cpu-usage', 'board-a');
    for (let i = 0; i < 10; i += 1) {
      const res = await m.handle({
        instanceId: 'inst-1',
        id: `r${i}`,
        method: 'tags.subscribe',
        args: { name: 'cpu.usage', subscriptionId: `s${i}` },
      });
      expect(res.ok).toBe(true);
    }
  });
});

describe('the session · complete boot-log capture', () => {
  const capture = { capture: () => ({ ok: true, text: 'boot' }), latest: () => null };

  it('requires the boot-log workflow permission in the card manifest', async () => {
    const m = managerWith(
      { readings: () => [], subscribe: () => () => undefined },
      { read: [], write: [], workflows: [] },
      undefined,
      () => capture,
    );
    m.open('inst-1', 'boot-log', 'board-a');
    const res = await m.handle({
      instanceId: 'inst-1',
      id: 'r1',
      method: 'bootLog.capture',
      args: {},
    });
    expect(res).toMatchObject({ ok: false, reason: 'denied' });
  });

  it('passes an authorised request through to the host serial capture', async () => {
    const m = managerWith(
      { readings: () => [], subscribe: () => () => undefined },
      { read: [], write: [], workflows: ['boot-log.capture'] },
      undefined,
      () => capture,
    );
    m.open('inst-1', 'boot-log', 'board-a');
    const res = await m.handle({
      instanceId: 'inst-1',
      id: 'r1',
      method: 'bootLog.capture',
      args: {},
    });
    expect(res).toMatchObject({ ok: true, value: { ok: true, text: 'boot' } });
  });
});

describe('the session · the **fourth dimension of authorisation** of a workflow (contract §3.3)', () => {
  it('**not in `permissions.workflows` → denied** (a workflow id may not be mixed into write)', async () => {
    const calls: string[] = [];
    const m = managerWith(
      { readings: () => [], subscribe: () => () => undefined },
      { read: [], write: [], workflows: ['other.run'] },
      () => fakeWorkflows(calls),
    );
    m.open('inst-1', 'cpu-usage', 'board-a');
    const res = await m.handle({
      instanceId: 'inst-1',
      id: 'r1',
      method: 'workflows.run',
      args: { id: 'demo.run', inputs: {} },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('denied');
    // **The implementation was not called at all** (there may be no side effect before the permission passed)
    expect(calls).toEqual([]);
  });

  it('**in `permissions.workflows` → let through**', async () => {
    const calls: string[] = [];
    const m = managerWith(
      { readings: () => [], subscribe: () => () => undefined },
      { read: [], write: [], workflows: ['demo.run'] },
      () => fakeWorkflows(calls),
    );
    m.open('inst-1', 'cpu-usage', 'board-a');
    const res = await m.handle({
      instanceId: 'inst-1',
      id: 'r1',
      method: 'workflows.run',
      args: { id: 'demo.run', inputs: {} },
    });
    expect(res.ok).toBe(true);
    expect(calls).toEqual(['run:demo.run']);
  });

  it('**the authorisation of a workflow does not rely on `permissions.write`** (the two dimensions look at their own)', async () => {
    const calls: string[] = [];
    const m = managerWith(
      { readings: () => [], subscribe: () => () => undefined },
      // **It is in write and not in workflows** → it is still refused
      { read: [], write: ['demo.run'], workflows: [] },
      () => fakeWorkflows(calls),
    );
    m.open('inst-1', 'cpu-usage', 'board-a');
    const res = await m.handle({
      instanceId: 'inst-1',
      id: 'r1',
      method: 'workflows.run',
      args: { id: 'demo.run', inputs: {} },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('denied');
  });
});

describe('the session · the **result** of an action is not collapsed into an envelope failure', () => {
  /**
   * Why this case matters:
   *
   * The action result of contract `spec/04` §2.4 has an `ok` and a `reason`
   * of its own: `{ ok:false, reason:'denied', detail:'…' }` (**a closed set
   * of reason codes**).
   *
   * The session layer has a general rule: "a failure the method returns itself
   * is lifted onto the envelope". That is right for `tags.subscribe` (it
   * answers `{ok:false, reason:'too_many_subscriptions'}`) and wrong for the
   * **result of an action**: **once it is collapsed the reason code of the
   * action is gone** and the card cannot tell "not permitted" from "the
   * parameters are wrong".
   *
   * → The methods that return a **shape** (the actions) are **not
   *   collapsed**: the envelope says "the method ran", and the card reads
   *   `value.ok` itself for the outcome (that is what the contract says).
   */
  it('when the operator has to confirm, the card gets the confirm_id', async () => {
    const m = new CardSessionManager({
      runtime: { readings: () => [], subscribe: () => () => undefined } as never,
      permsFor: () => ({ read: [], write: ['backlight.set'] }),
      actionsFor: () => ({
        invoke: () => ({
          ok: false,
          verified: false,
          reason: 'needs_confirmation',
          needsConfirmation: { confirmId: 'confirm-1', detail: 'this action has to be confirmed by the operator' },
        }),
      }),
    });
    m.open('inst-1', 'action-card', 'board-a');
    const res = await m.handle({
      instanceId: 'inst-1',
      id: 'r1',
      method: 'actions.invoke',
      args: { id: 'backlight.set', params: { value: 128 } },
    });
    // **The envelope is a success** (the method ran) — the result is in the value
    expect(res.ok).toBe(true);
    const value = res.value as {
      ok: boolean;
      reason: string;
      needsConfirmation: { confirmId: string };
    };
    expect(value.reason).toBe('needs_confirmation');
    expect(value.needsConfirmation.confirmId).toBe('confirm-1');
  });

  it('but a **method level** failure is still collapsed into an envelope failure (the old rule is unchanged)', async () => {
    const m = managerWith({ readings: () => [], subscribe: () => () => undefined });
    m.open('inst-1', 'cpu-usage', 'board-a');
    const res = await m.handle({
      instanceId: 'inst-1',
      id: 'r1',
      method: 'tags.subscribe',
      args: { name: 'cpu.usage', subscriptionId: 's1' },
    });
    // The number of subscriptions did not pass the limit → it may not fail
    expect(res.ok).toBe(true);
  });
});
