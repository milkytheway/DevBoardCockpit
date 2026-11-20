import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowRegistry } from '../../../src/main/workflows/registry';
import { WorkflowService } from '../../../src/main/workflows/service';
import type { WorkflowRunDeps } from '../../../src/main/workflows/runner';
import type { ConnectionProfile } from '../../../src/main/profiles/schema';
import type { Connection, ExecResult } from '../../../src/main/hal/connection';
import type { AuditRow } from '../../../src/main/actions/audit';

/**
 * The **host service of a workflow** — the layer in which a card and an agent
 * trigger a workflow.
 *
 * Three criteria, the C1 / C2 / C3 of two independent reviews:
 *
 * 1. **It knows the id, not the path**, so an agent cannot write a pack of
 *    its own and run it.
 * 2. **The approved ledger is gone** (changed on 2026-11-16):
 *    **the existence of a workflow pack is the statement**, and the gate is
 *    the unified permission area in the settings.
 * 3. **A long task = run_id + polling**, because a compile takes a minute and
 *    a synchronous answer does not hold.
 */
let dir: string;
let userDir: string;

interface TestPack {
  apiVersion: string;
  kind: string;
  id: string;
  name: string;
  version: string;
  inputs: Record<string, { type: string; required?: boolean; maxLength?: number; default?: unknown }>;
  roles: Record<string, { purpose: string; profile: string }>;
  steps: { id: string; kind: string; role: string; cmd: string; danger?: string }[];
}

const PACK: TestPack = {
  apiVersion: 'devboard/v1',
  kind: 'Workflow',
  id: 'demo.run',
  name: 'demo workflow',
  version: '1.0.0',
  inputs: { project: { type: 'string', required: true, maxLength: 50 } },
  roles: { build: { purpose: 'the guest', profile: 'guest' } },
  steps: [{ id: 'hello', kind: 'exec', role: 'build', cmd: 'echo {input:project}' }],
};

/** A workflow of two steps (**it is used to look at the moment "half way through"**) */
const TWO_STEP_PACK: TestPack = {
  ...PACK,
  steps: [
    { id: 'one', kind: 'exec', role: 'build', cmd: 'echo {input:project}' },
    { id: 'two', kind: 'exec', role: 'build', cmd: 'echo second' },
  ],
};

/** A workflow with a destructive step (the danger level is informational — nobody is asked) */
const DANGEROUS_PACK = {
  ...PACK,
  id: 'demo.danger',
  steps: [
    {
      id: 'danger',
      kind: 'exec',
      role: 'build',
      danger: 'destructive',
      cmd: 'echo {input:project}',
    },
  ],
} as TestPack;

function yamlOf(pack: TestPack): string {
  const steps = pack.steps
    .map((s) =>
      [
        `  - id: ${s.id}`,
        `    kind: ${s.kind}`,
        `    role: ${s.role}`,
        ...(s.danger === undefined ? [] : [`    danger: ${s.danger}`]),
        `    cmd: "${s.cmd}"`,
      ].join('\n'),
    )
    .join('\n');
  return [
    'apiVersion: devboard/v1',
    'kind: Workflow',
    `id: ${pack.id}`,
    `name: ${pack.name}`,
    `version: ${pack.version}`,
    'inputs:',
    '  project: { type: string, required: true, maxLength: 50 }',
    // **An input that has a default also has to be written out** (contract §2)
    ...Object.entries(pack.inputs)
      .filter(([, def]) => def.default !== undefined)
      .map(([name, def]) => `  ${name}: { type: ${def.type}, default: ${def.default} }`),
    'roles:',
    '  build: { purpose: the guest, profile: guest }',
    'steps:',
    steps,
    '',
  ].join('\n');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cockpit-service-'));
  userDir = join(dir, 'workflows');
  mkdirSync(userDir, { recursive: true });
  writeFileSync(join(userDir, 'demo.yaml'), yamlOf(PACK), 'utf8');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function service(
  pack: TestPack = PACK,
  harnessOpts: { gate?: boolean; throwOnAudit?: boolean } = {},
): {
  svc: WorkflowService;
  reg: WorkflowRegistry;
  audits: AuditRow[];
  deps: WorkflowRunDeps;
  /** Hands over one command that gets stuck */
  releaseOne: () => void;
  /** Waits until n commands are stuck */
  untilWaiting: (n: number) => Promise<void>;
  /** How often the audit was called (it waits for "that step really finished") */
  auditCount: () => number;
} {
  // **Another pack** (the test has to be able to build the destructive kind)
  writeFileSync(join(userDir, 'demo.yaml'), yamlOf(pack), 'utf8');
  const reg = new WorkflowRegistry({ dirs: [userDir] });
  reg.scan();
  const audits: AuditRow[] = [];
  const throwOnAudit = harnessOpts.throwOnAudit === true;
  let auditCalls = 0;
  const profiles = new Map<string, ConnectionProfile>([
    ['guest', { id: 'guest', label: 'the guest', transport: 'ssh', options: { host: '10.0.0.2' } }],
  ]);
  // **The gate**: the command gets stuck until the test lets it through
  // → "half way through" **has to be visible** (otherwise it could only be guessed with a sleep)
  const waiting: (() => void)[] = [];
  const conn = {
    id: 'guest',
    transport: 'ssh',
    capabilities: () => ({ exec: true, files: true, exitCode: true, pty: false }),
    open: async () => undefined,
    close: async () => undefined,
    // **It recognises the cancel signal** (a real HAL recognises it — if the fake device did not,
    // the criterion "the step in flight really stops" **could never be tested**)
    // → and **it gets a window of 20ms** (otherwise the cancellation is always one step too late)
    exec: async (_command: string, opts?: { signal?: AbortSignal }): Promise<ExecResult> => {
      if (harnessOpts.gate === true) {
        await new Promise<void>((r) => waiting.push(r));
      } else {
        await new Promise((r) => setTimeout(r, 20));
      }
      const cancelled = opts?.signal?.aborted === true;
      return {
        exitCode: cancelled ? null : 0,
        stdout: 'hi',
        stderr: '',
        durationMs: 20,
        timedOut: false,
        ...(cancelled ? { cancelled: true } : {}),
      };
    },
    pull: async () => undefined,
    push: async () => undefined,
    list: async () => [],
    openSession: async () => {
      throw new Error('no session');
    },
  } as unknown as Connection;
  const deps: WorkflowRunDeps = {
    // (the connection stand-in: every target goes through the same fake connection — the unit tests of the workflow layer do not test the transport)
    targets: {
      connectionFor: async () => conn,
      runOn: async <T>(_id: string, fn: (c: Connection) => Promise<T>): Promise<T> => fn(conn),
      closeAll: async () => undefined,
      openCount: 0,
    } as never,
    profileFor: (id: string) => profiles.get(id),
    audit: (row: AuditRow) => {
      // **The audit throws** → it reaches the **catch path of the service layer**
      // ⚠️ **It throws only the second time** — the first one is the audit row of `cancel()` itself (it may not blow up)
      auditCalls += 1;
      if (throwOnAudit && auditCalls > 1) throw new Error('the audit blew up');
      audits.push(row);
      return `audit-${audits.length}`;
    },
    now: () => 1_700_000_000_000,
  };
  const svc = new WorkflowService({
    registry: reg,
    runDeps: deps,
  });
  return {
    svc,
    reg,
    audits,
    deps,
    releaseOne: () => waiting.shift()?.(),
    auditCount: () => auditCalls,
    untilWaiting: async (n: number): Promise<void> => {
      for (let i = 0; i < 200 && waiting.length < n; i += 1) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(waiting.length).toBeGreaterThanOrEqual(n);
    },
  };
}

describe('the workflow service · it knows the id, not the path', () => {
  it('**a workflow pack that was never approved can run** (**its existence is the statement**)', () => {
    const { svc } = service();
    // **There is no "was it approved" question any more** (the gate is the unified permission area in the settings)
    expect(() => svc.start('demo.run', { project: 'x' })).not.toThrow();
  });

  it('**the list holds every pack** (**there is no "unapproved packs are not listed" any more**)', () => {
    const { svc } = service();
    expect(svc.list().map((w) => w.id)).toEqual(['demo.run']);
    expect(svc.list()[0]?.name).toBe('demo workflow');
  });

  it('the input declarations in the list **carry the default** (the card has to be able to prefill it)', () => {
    const h = service({
      ...PACK,
      inputs: { project: { type: 'string', required: true, maxLength: 50 }, count: { type: 'integer', default: 5 } },
    });
    const first = h.svc.list()[0];
    expect(first?.inputs['count']).toEqual({ type: 'integer', default: 5 });
  });

  it('the list carries the **input declarations** (the card renders the form by them)', () => {
    const { svc } = service();
    const first = svc.list()[0];
    expect(first?.inputs['project']).toEqual({
      type: 'string',
      required: true,
    });
  });

  it('**there is no such workflow** → it reports an error (and says so clearly)', () => {
    const { svc } = service();
    expect(() => svc.start('nobody', {})).toThrow(/no such workflow pack/);
  });
});

describe('the workflow service · the gate of a workflow pack (**its existence is the statement**)', () => {
  it('a destructive step → **it runs to the end** (**it no longer stops to wait for a confirmation** — the danger level is informational)', async () => {
    const { svc } = service(DANGEROUS_PACK);
    const { runId } = svc.start('demo.danger', { project: 'x' });
    for (let i = 0; i < 50 && svc.status(runId).state === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const status = svc.status(runId);
    // **It ran to the end** (**not "waiting for a confirmation"** — that outcome is gone)
    expect(status.state).toBe('done');
    expect(status.ok).toBe(true);
    // **That step really is on the timeline**
    expect(status.stages.map((s) => s.stepId)).toEqual(['danger']);
  });

  it('**the card-level authorisation is gone**: **a workflow pack in the directory can be run by anyone**', () => {
    const h = service();
    // **A card triggers it** — **there is no "was this card granted" question any more**
    expect(() => h.svc.start('demo.run', { project: 'x' })).not.toThrow();
  });

  it('**there is no "approved ledger" question any more** (**the existence of the workflow pack is the statement**)', () => {
    const h = service();
    // **The same pack runs twice and both are let through** (**there is no difference between approved and not approved**)
    expect(() => h.svc.start('demo.run', { project: 'x' })).not.toThrow();
  });

  it('**the same workflow may only run once at a time** (two workflows fighting over one serial port would cross the wires)', async () => {
    const h = service();
    const { runId } = h.svc.start('demo.run', { project: 'x' });
    // **It is still running** → the second one has to be refused
    expect(() => h.svc.start('demo.run', { project: 'x' })).toThrow(/is running/);
    // Wait for it to finish → it can run again
    for (let i = 0; i < 50 && h.svc.status(runId).state === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(() => h.svc.start('demo.run', { project: 'x' })).not.toThrow();
  });

  it('**cancelling**: the state becomes cancelled (**not failed**)', async () => {
    const h = service();
    const { runId } = h.svc.start('demo.run', { project: 'x' });
    // **Cancelling**
    h.svc.cancel(runId);
    const status = h.svc.status(runId);
    // **A cancellation is not a failure** (the state machine of contract §8·3)
    expect(status.state).toBe('cancelled');
    expect(status.reason).toBe('cancelled');
  });

  it('**when it finishes on its own after the cancellation, it may not turn the state back** (after the unwind of the await it is still cancelled)', async () => {
    const h = service();
    const { runId } = h.svc.start('demo.run', { project: 'x' });
    h.svc.cancel(runId);

    // **Wait for it to finish on its own** (the timeline appearing means the finishing ran)
    for (let i = 0; i < 50 && h.svc.status(runId).stages.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(h.svc.status(runId).stages.length).toBeGreaterThan(0);

    // ⚠️ **This is the C-1 of the independent review 40**:
    // the cancellation is set **synchronously**, but the run **writes the state once more when it unwinds by itself** —
    // → the state "cancelled" **has to survive until the end** (otherwise the interface turns "the operator stopped it" into "something went wrong")
    expect(h.svc.status(runId).state).toBe('cancelled');
    expect(h.svc.status(runId).reason).toBe('cancelled');
  });

  it('**the cancelled step gets the reason cancelled** (not "the readback did not match" — the operator stopped it, the board did not disobey)', async () => {
    const h = service();
    const { runId } = h.svc.start('demo.run', { project: 'x' });
    h.svc.cancel(runId);
    for (let i = 0; i < 50 && h.svc.status(runId).stages.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const stage = h.svc.status(runId).stages[0];
    expect(stage?.ok).toBe(false);
    // ⚠️ The exit code of a cancelled command is `null` → without the `cancelled` flag it falls into the "returned non-zero" branch
    expect(stage?.reason).toBe('cancelled');
  });

  it('**cancelling a run that already finished → the state does not change** (idempotent — it may not turn done into cancelled)', async () => {
    const h = service();
    const { runId } = h.svc.start('demo.run', { project: 'x' });
    // **Wait for it to finish**
    for (let i = 0; i < 50 && h.svc.status(runId).state === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const before = h.svc.status(runId).state;
    expect(before).toBe('done');

    // **Cancelling a run that already ended** → its state may not change
    h.svc.cancel(runId);
    expect(h.svc.status(runId).state).toBe(before);
  });

  it('**an exception after the cancellation → the state is still cancelled** (not failed)', async () => {
    // ⚠️ **The independent review 40, I-1**: the success path has a guard, **the catch path has none**
    // → if any exception reaches the execute after the cancellation, the "the operator stopped it" of the interface is turned into "something went wrong"
    const h = service(PACK, { gate: true, throwOnAudit: true });
    const { runId } = h.svc.start('demo.run', { project: 'x' });
    await h.untilWaiting(1);

    // **Cancelling**
    h.svc.cancel(runId);
    expect(h.svc.status(runId).state).toBe('cancelled');

    // **Let it through** → that step finishes → the audit throws → the catch path of the service layer
    h.releaseOne();
    // ⚠️ **It may not wait for the state to change** — after the cancellation it is already `cancelled` (not `running`)
    // → the loop would simply be skipped and the assertion would run **before** the exception, so **the criterion would be empty**
    // → changed to waiting for "the audit really was called the second time" (that is the signal that the step finished)
    for (let i = 0; i < 50 && h.auditCount() < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(h.auditCount()).toBeGreaterThanOrEqual(2);
    // **Look at the state after the exception was handled**
    await new Promise((r) => setTimeout(r, 20));
    // **"The operator stopped it" has to survive until the end** (contract §8·A·A2)
    expect(h.svc.status(runId).state).toBe('cancelled');
  });

  it('**a cancellation records one audit row** (who stopped it can be looked up)', async () => {
    const h = service();
    const { runId } = h.svc.start('demo.run', { project: 'x' });
    h.svc.cancel(runId);
    const cancelRows = h.audits.filter((r) => r.actionId.endsWith(':cancel'));
    expect(cancelRows).toHaveLength(1);
    expect(cancelRows[0]?.params['runId']).toBe(runId);
  });

  it('**half way through, `status` states "which step it is at and since when"** (the interface may not be dead silent)', async () => {
    const h = service(TWO_STEP_PACK, { gate: true });
    const { runId } = h.svc.start('demo.run', { project: 'x' });
    await h.untilWaiting(1);

    // **That step is still running** → "which step it is at" has to be answerable
    const running = h.svc.status(runId);
    expect(running.current?.stepId).toBe('one');
    expect(running.current?.at).toBeGreaterThan(0);

    // **After it ran → current becomes null** (a finished run has no "current" any more)
    h.releaseOne();
    await h.untilWaiting(1); // The second step is stuck
    h.releaseOne();
    for (let i = 0; i < 50 && h.svc.status(runId).state === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(h.svc.status(runId).current).toBeNull();
  });

  it('**the timeline is filled while it runs** (not only when it is over)', async () => {
    const h = service(TWO_STEP_PACK, { gate: true });
    const { runId } = h.svc.start('demo.run', { project: 'x' });
    await h.untilWaiting(1);

    // **The first step has not finished → the timeline is empty**
    expect(h.svc.status(runId).stages).toHaveLength(0);

    // **Let the first step through** → the second step is stuck
    h.releaseOne();
    await h.untilWaiting(1);

    // **The timeline already has its first row** (it is not only there once the whole run is over)
    expect(h.svc.status(runId).stages.map((s) => s.stepId)).toEqual(['one']);
    // **"Which step it is at" moves on to the second step as well**
    expect(h.svc.status(runId).current?.stepId).toBe('two');
  });

  it('**cancelling a run that does not exist → it reports an error**', () => {
    const { svc } = service();
    expect(() => svc.cancel('wf-nope')).toThrow(/no such run/);
  });
});

describe('the workflow service · a long task = run_id + polling', () => {
  it('`start` **gives the runId right away** (it does not wait for the end)', () => {
    const { svc } = service();
    const started = svc.start('demo.run', { project: 'x' });
    expect(started.runId).toMatch(/^wf-/);
  });

  it('after it ran, `status` **has the complete timeline**', async () => {
    const { svc } = service();
    const { runId } = svc.start('demo.run', { project: 'x' });
    // **Wait for it to finish** (the test polls)
    for (let i = 0; i < 50 && svc.status(runId).state === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const status = svc.status(runId);
    expect(status.state).toBe('done');
    expect(status.ok).toBe(true);
    expect(status.stages).toHaveLength(1);
    expect(status.stages[0]?.audit_id).toBeTruthy();
  });

  it('**there is no such run** → it reports an error', () => {
    const { svc } = service();
    expect(() => svc.status('wf-nope')).toThrow(/no such run/);
  });

  it('every run produces **one audit row** (for the accountability)', async () => {
    const { svc, audits } = service();
    const { runId } = svc.start('demo.run', { project: 'x' });
    for (let i = 0; i < 50 && svc.status(runId).state === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(audits.length).toBeGreaterThan(0);
    expect(audits[0]?.actor).toMatch(/^workflow:/);
  });
});
