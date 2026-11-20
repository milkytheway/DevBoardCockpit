import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeAction, agentGrants } from '../../../src/main/mcp/action-tools';
import type { ActionDef } from '../../../src/main/tags/schema';
import type { AgentActionDeps } from '../../../src/main/mcp/action-tools';
import type { TagReading } from '../../../src/shared/tag-reading';
import { PermissionStore } from '../../../src/main/permissions/policy';

/**
 * Action execution for an agent (contract `spec/04` §2.4 / §2.4.1).
 *
 * What these criteria guard:
 *
 * | Criterion | Why |
 * |---|---|
 * | **the action is not in the pack → `not_found`** (**not `denied`**) | the order of contract §2.4 |
 * | **the parameters are invalid → `invalid_params`** | the order of contract §2.4 |
 * | **it is in the granted set → it runs directly** | contract §2.4.1 |
 * | **`destructive` → it runs directly as well** (no prompt) — **when the permission area allows it** | the danger level is informational — the gate is the permission area in the settings, and **the dangerous ones are off by default** ✓ |
 * | **outside the guard range → `denied`** (**not "ask for confirmation"**) | the guard is the boundary the pack author drew |
 * | **`dry_run` executes nothing and writes no audit row** | "it is not an attempt" |
 *
 * The `confirm_action` family is gone.
 */

const BACKLIGHT: ActionDef = {
  id: 'backlight.set',
  label: 'set the backlight brightness',
  danger: 'reversible',
  params: { value: { type: 'integer', min: 16, max: 255 } },
  guard: { value: { min: 16, max: 255 } },
  command: 'echo {value} > /sys/class/backlight/backlight/brightness',
  readback: { kind: 'tag', tag: 'custom.demo.brightness' },
};

/**
 * An action whose **declared range is wide and whose `guard` is narrow**.
 *
 * The difference between the two (from the behaviour table of contract §2.4):
 *
 * | What was crossed | Returned |
 * |---|---|
 * | **the range the action declares itself** (`params.value.min/max`) | `invalid_params` |
 * | **the `guard`** (the narrower band that was approved when the card was installed) | **`denied`** |
 */
const DIMMER: ActionDef = {
  id: 'backlight.dim',
  label: 'dim the backlight',
  danger: 'reversible',
  // **the declared range is 0..255**
  params: { value: { type: 'integer', min: 0, max: 255 } },
  // **but the guard was only granted for 16..200**
  guard: { value: { min: 16, max: 200 } },
  command: 'echo {value} > /sys/class/backlight/backlight/brightness',
  readback: { kind: 'tag', tag: 'custom.demo.brightness' },
};

const REBOOT: ActionDef = {
  id: 'system.reboot',
  label: 'reboot the board',
  danger: 'destructive',
  command: 'reboot',
  readback: { kind: 'verify', command: 'true' },
};

let executed: string[];
let audits: number;
let deps: AgentActionDeps;
let permissions: PermissionStore;
let storeSeq = 0;

beforeEach(() => {
  executed = [];
  audits = 0;
  // **The unified permission area** ✓ (the gate of the agent side ✓)
  // → **one file per store** ✓ (the store persists ✓ — a shared file would
  //   leak the settings of one case into the next one ✗)
  permissions = new PermissionStore(
    join(tmpdir(), `cockpit-perm-${process.pid}-${storeSeq++}.json`),
  );
  deps = {
    // **the packId is a string** (the shape the executor expects)
    packId: 'demo-pack',
    packIdOf: () => 'demo-pack',
    contractVersion: 'devboard/v1',
    // **the current board**
    deviceKey: () => 'atk-01',
    hasExitCode: true,
    runTransaction: async (fn: (c: unknown) => Promise<unknown>) =>
      fn({
        exec: async (command: string) => {
          executed.push(command);
          return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
        },
        // **a readback of the form verify runs one more verification command** — that
// is **not** a repeated execution
      } as never),
    // **the readback has to be able to read** — otherwise it answers `not_found`
// (which is right: if it cannot be read, it says so)
    readTag: async (tag: string): Promise<TagReading | undefined> => ({
      tag,
      value: 100,
      unit: '',
      status: 'ok',
      at: 1_700_000_000_000,
      seq: 1,
    }),
    audit: () => {
      audits += 1;
      return 'audit-1';
    },
    now: () => 1_700_000_000_000,
    actions: () => [BACKLIGHT, DIMMER, REBOOT],
    permissions,
  } as unknown as AgentActionDeps;
});

describe('MCP · execute_action · existence and authorisation', () => {
  it('**the action is not in the pack → `not_found`** (**not `denied`** — the order matters)', async () => {
    const res = await executeAction(deps, 'nope.nope', {});
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not_found');
  });

  it('**the parameters are invalid → `invalid_params`** (**not an execution failure**)', async () => {
    const res = await executeAction(deps, 'backlight.set', { value: 9999 });
    expect(res.reason).toBe('invalid_params');
  });

  it('**the agent may not run a `destructive` action while the permission area says no** ✓ (ADR-D48: **the dangerous ones are off by default** ✓ — **turning one on is the informed consent** ✓)', async () => {
    const res = await executeAction(deps, 'system.reboot', {});
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('denied');
    // **it did not run** ✓
    expect(executed).toEqual([]);
  });

  it('**turning the switch on is the informed consent** ✓ → the agent may run it ✓', async () => {
    permissions.set('agent', 'action:system.reboot', true);
    const res = await executeAction(deps, 'system.reboot', {});
    expect(res.ok).toBe(true);
    expect(executed.length).toBeGreaterThan(0);
  });

  it('**the granted set of the agent is every action of the pack** (contract §2.4.1)', () => {
    const grants = agentGrants([BACKLIGHT, DIMMER, REBOOT]);
    expect(Object.keys(grants.actions).sort()).toEqual([
      'backlight.dim',
      'backlight.set',
      'system.reboot',
    ]);
    // **`undefined` means it was granted without narrowing the parameter range** →
// the range falls back to the guard of the action itself
    expect(grants.actions['backlight.set']).toBeUndefined();
  });
});

describe('MCP · execute_action · the two authorisation criteria', () => {
  it('**`reversible` + the parameters are inside the guard range → it runs directly**, and it is audited', async () => {
    const res = await executeAction(deps, 'backlight.set', { value: 100 });
    expect(res.ok).toBe(true);
    expect(executed.length).toBe(1);
    expect(audits).toBe(1);
    expect(res.audit_id).toBe('audit-1');
  });

  it('**`destructive` → it runs directly** (no prompt) — **the permission area allows it** ✓', async () => {
    // **the switch is on** ✓ (turning it on is the informed consent ✓ — ADR-D48 ✓)
    permissions.set('agent', 'action:system.reboot', true);
    const res = await executeAction(deps, 'system.reboot', {});
    expect(res.ok).toBe(true);
    // **the command really went out** (**what is counted are the commands of the
// action** — the verification command of the readback does not count)
    expect(executed.filter((c) => c === 'reboot').length).toBe(1);
  });

  it('**the parameters are outside the guard range → `denied`** (**not "ask for confirmation"** — the guard is the boundary the pack author drew)', async () => {
    // **the declared range is 0..255, the guard is 16..200** → 220 is inside the
// declared range but outside the guard
    const res = await executeAction(deps, 'backlight.dim', { value: 220 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('denied');
    // **the command did not go out**
    expect(executed.length).toBe(0);
  });

  it('**the parameters are outside the range the action declares itself → `invalid_params`** (**that is not "outside the guard"**)', async () => {
    const res = await executeAction(deps, 'backlight.dim', { value: 999 });
    expect(res.reason).toBe('invalid_params');
  });

  it('**a denial is audited as well** (one row per attempt, so the chain of accountability is unbroken)', async () => {
    const res = await executeAction(deps, 'backlight.dim', { value: 220 });
    expect(res.reason).toBe('denied');
    expect(audits).toBe(1);
  });
});

describe('MCP · execute_action · dry_run', () => {
  it('**the encoded final command is returned** (**not the template**)', async () => {
    const res = await executeAction(deps, 'backlight.set', { value: 100 }, { dryRun: true });
    expect(res.ok).toBe(true);
    expect(res.dry_run).toBe(true);
    expect(res.command).toBe("echo 100 > /sys/class/backlight/backlight/brightness");
  });

  it('**`destructive` can be previewed as well** (the permission area allows it ✓)', async () => {
    permissions.set('agent', 'action:system.reboot', true);
    const res = await executeAction(deps, 'system.reboot', {}, { dryRun: true });
    expect(res.ok).toBe(true);
    expect(res.command).toBe('reboot');
    // **the preview does not execute**
    expect(executed.length).toBe(0);
  });

  it('**it does not run** · **it writes no audit row** ("it is not an attempt")', async () => {
    await executeAction(deps, 'backlight.set', { value: 100 }, { dryRun: true });
    expect(executed.length).toBe(0);
    expect(audits).toBe(0);
  });

  it('**the parameters are invalid → it is still `invalid_params`** (**otherwise the preview is not "what is going to be executed"**)', async () => {
    const res = await executeAction(deps, 'backlight.set', { value: 9999 }, { dryRun: true });
    expect(res.reason).toBe('invalid_params');
  });

  it('**`readback_tag` is the tag this action reads**', async () => {
    const res = await executeAction(deps, 'backlight.set', { value: 100 }, { dryRun: true });
    expect(res.readback_tag).toBe('custom.demo.brightness');
  });
});
