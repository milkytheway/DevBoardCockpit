import { describe, it, expect } from 'vitest';
import { TagsService } from '../../../src/main/cards/tags-service';
import { CardSessionManager } from '../../../src/main/cards/session';
import { apiByName } from '../../../src/main/cards/api-registry';
import type { CardPermissions } from '../../../src/main/cards/permissions';
import type { TagReading } from '../../../src/shared/tag-reading';

/**
 * The read-side API and the **permission filter**.
 *
 * This is the most important piece of code of the whole product:
 *
 * A card is an arbitrary web page written by an AI and it can call
 * `cockpit.*`. The permission filter is applied **on this layer only** (in
 * the main process), neither the page nor the bridge decides anything.
 *
 * Two iron rules:
 *
 * 1. **A tag that is not permitted cannot be read**, and **it is not visible
 *    whether it exists** (the answer is `unavailable` + `not_found`, **exactly
 *    the same** as for one that does not exist) — otherwise a card could use
 *    "readable / not readable" as a **probe channel** and try out every tag
 *    name of the board one by one.
 * 2. **A wildcard subscription is judged again on every push** — judging it
 *    once at the time of the subscription is not enough: the permission set
 *    is fixed **when the card is created**, but the push happens **every
 *    time**.
 */

function reading(tag: string, over: Partial<TagReading> = {}): TagReading {
  return {
    tag,
    value: 12.5,
    unit: 'percent',
    status: 'ok',
    at: 1,
    seq: 1,
    ...over,
  };
}

const READINGS: TagReading[] = [
  reading('cpu.usage', { value: 37.2 }),
  reading('cpu.core.3.usage', { value: 40 }),
  reading('mem.usage', { value: 62 }),
  reading('npu.usage', { status: 'unavailable', value: null, reason: 'device_absent' }),
];

function service(perms: CardPermissions): TagsService {
  return new TagsService(perms, {
    readings: () => READINGS,
    subscribe: () => () => undefined,
    now: () => 1000,
  });
}

describe('the read side · the permission filter', () => {
  it('a tag that is permitted → the real value can be read', () => {
    const svc = service({ read: ['cpu.usage'], write: [] });
    expect(svc.get('cpu.usage').value).toBe(37.2);
    expect(svc.get('cpu.usage').status).toBe('ok');
  });

  it('**a tag that is not permitted → it cannot be read, and it is not visible whether it exists**', () => {
    const svc = service({ read: ['cpu.usage'], write: [] });
    const hidden = svc.get('mem.usage');
    expect(hidden.value).toBeNull();
    expect(hidden.status).toBe('unavailable');
    expect(hidden.reason).toBe('not_found');
  });

  it('a tag that does not exist → **it looks exactly like one that is not permitted**', () => {
    const svc = service({ read: ['cpu.usage'], write: [] });
    const missing = svc.get('nope.not.here');
    const hidden = svc.get('mem.usage');
    expect(missing.status).toBe(hidden.status);
    expect(missing.reason).toBe(hidden.reason);
  });

  it('list() only gives the permitted ones', () => {
    const svc = service({ read: ['cpu.usage'], write: [] });
    expect(svc.list().map((r) => r.tag)).toEqual(['cpu.usage']);
  });

  it('a wildcard permission covers a concrete tag', () => {
    const svc = service({ read: ['cpu.core.*.usage'], write: [] });
    expect(svc.get('cpu.core.3.usage').value).toBe(40);
  });

  it('the subscription: not a single one that is not permitted is pushed', () => {
    // **The fake store has to really push** — otherwise the assertion "not a
// single one is pushed" is empty,
    // and it stays green even though it was filtered out (the mutation test M42
// caught it with this one)
    const pushed: TagReading[] = [];
    const svc = new TagsService(
      { read: ['cpu.usage'], write: [] },
      {
        readings: () => READINGS,
        subscribe: (cb) => {
          cb(reading('cpu.core.3.usage', { value: 40 }));
          return () => undefined;
        },
        now: () => 1000,
      },
    );
    svc.subscribePattern('cpu.core.*.usage', (r) => pushed.push(r));
    expect(pushed).toEqual([]);
  });

  it('the subscription: the permitted ones are pushed with the period', () => {
    const pushed: TagReading[] = [];
    const svc = new TagsService(
      { read: ['cpu.core.*.usage'], write: [] },
      {
        readings: () => READINGS,
        subscribe: (cb) => {
          // It pushes once right away (it simulates a change)
          cb(reading('cpu.core.3.usage', { value: 41 }));
          return () => undefined;
        },
        now: () => 1000,
      },
    );
    svc.subscribePattern('cpu.core.*.usage', (r) => pushed.push(r));
    expect(pushed.map((r) => r.tag)).toEqual(['cpu.core.3.usage']);
  });

  it('the degradation information: it lists the readings that are unavailable and their reason', () => {
    const svc = service({ read: ['cpu.usage', 'npu.usage'], write: [] });
    const degraded = svc.degradation();
    expect(degraded.length).toBeGreaterThan(0);
    expect(degraded.some((d) => d.tag === 'npu.usage')).toBe(true);
  });
});

describe('the card session · the dispatch and the authorisation', () => {
  function manager(perms: CardPermissions): CardSessionManager {
    return new CardSessionManager({
      runtime: {
        readings: () => READINGS,
        subscribe: () => () => undefined,
      } as unknown as ConstructorParameters<typeof CardSessionManager>[0]['runtime'],
      permsFor: () => perms,
      now: () => 1000,
    });
  }

  it('an unknown method → unknown_method', async () => {
    const m = manager({ read: ['cpu.usage'], write: [] });
    m.open('inst-1', 'cpu-usage', 'board-adb');
    const res = await m.handle({
      instanceId: 'inst-1',
      id: 'r1',
      method: 'no.such.method',
      args: {},
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unknown_method');
  });

  it('**the write side exists since M6**: the action is not in permissions.write → denied', async () => {
    const m = manager({ read: ['cpu.usage'], write: [] });
    m.open('inst-1', 'cpu-usage', 'board-adb');
    const res = await m.handle({
      instanceId: 'inst-1',
      id: 'r1',
      method: 'actions.invoke',
      args: { id: 'cpu.governor.set' },
    });
    expect(res.ok).toBe(false);
    // **denied (not permitted)**, not unknown_method (no such method)
    expect(res.reason).toBe('denied');
  });

  it('the action is in permissions.write → **it is let through to the executor** (there is no executor here → unknown_action)', async () => {
    const m = manager({ read: ['cpu.usage'], write: ['cpu.governor.set'] });
    m.open('inst-1', 'cpu-usage', 'board-adb');
    const res = await m.handle({
      instanceId: 'inst-1',
      id: 'r1',
      method: 'actions.invoke',
      args: { id: 'cpu.governor.set' },
    });
    // It passed the gate of the **permission** (it is not denied) and died on
// "there is no executor"
    expect(res.reason).toBe('unknown_action');
    expect(apiByName().has('actions.invoke')).toBe(true);
  });

  it('a tag that is not permitted → not_found (it does not leak the existence)', async () => {
    const m = manager({ read: ['cpu.usage'], write: [] });
    m.open('inst-1', 'cpu-usage', 'board-adb');
    const res = await m.handle({
      instanceId: 'inst-1',
      id: 'r1',
      method: 'tags.get',
      args: { name: 'mem.usage' },
    });
    expect(res.ok).toBe(true);
    expect((res.value as TagReading).status).toBe('unavailable');
    expect((res.value as TagReading).reason).toBe('not_found');
  });

  it('a tag that is permitted → the real value can be obtained', async () => {
    const m = manager({ read: ['cpu.usage'], write: [] });
    m.open('inst-1', 'cpu-usage', 'board-adb');
    const res = await m.handle({
      instanceId: 'inst-1',
      id: 'r1',
      method: 'tags.get',
      args: { name: 'cpu.usage' },
    });
    expect(res.ok).toBe(true);
    expect((res.value as TagReading).value).toBe(37.2);
  });

  it('an instance that is not registered → it is refused (it does not guess)', async () => {
    const m = manager({ read: ['cpu.usage'], write: [] });
    const res = await m.handle({
      instanceId: 'nope',
      id: 'r1',
      method: 'tags.get',
      args: { name: 'cpu.usage' },
    });
    expect(res.ok).toBe(false);
  });
});
