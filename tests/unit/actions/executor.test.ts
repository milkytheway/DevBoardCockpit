import { describe, it, expect } from 'vitest';
import { invokeAction, type ActionExecutorDeps } from '../../../src/main/actions/executor';
import type { ActionDef } from '../../../src/main/tags/schema';
import type { Connection, ExecResult } from '../../../src/main/hal/connection';
import type { TagReading } from '../../../src/shared/tag-reading';
import type { AuditRow } from '../../../src/main/actions/audit';

/**
 * Action executor — contract `docs/spec/02-board-pack.md` §5.2. The chain has
 * seven steps:
 *
 * ```
 * encode -> authorise -> execute -> read back -> audit
 * ```
 *
 * There is no "ask the operator" step any more:
 *
 * - `destructive` runs directly (the danger level is informational — the gate
 *   is the permission area in the settings);
 * - a param outside the guard range is denied (never "ask or not");
 * - the executor does not re-check the danger floor (the floor is for
 *   validation and display; the gate is not on this layer).
 *
 * Execution and readback form one indivisible, exclusive transaction. If a
 * sample were allowed to interleave, the readback could pick up the output of
 * a different command, the mismatch would become a false negative, and the
 * cockpit would display a wrong state as the real one.
 */
const ACTION: ActionDef = {
  id: 'backlight.set',
  label: 'set backlight',
  danger: 'reversible',
  params: { value: { type: 'integer', min: 0, max: 255 } },
  guard: { value: { min: 16, max: 255 } },
  command: 'echo {value} > /sys/class/backlight/backlight/brightness',
  readback: { kind: 'file_equals', path: '/sys/class/backlight/backlight/brightness', expect: '{value}' },
};

interface Harness {
  deps: ActionExecutorDeps;
  executed: string[];
  audits: AuditRow[];
}

function harness(
  over: {
    action?: ActionDef;
    fileContent?: string | null;
    execResult?: ExecResult;
    granted?: Record<string, unknown>;
    hasExitCode?: boolean;
  } = {},
): Harness {
  const executed: string[] = [];
  const audits: AuditRow[] = [];
  const action = over.action ?? ACTION;
  const fakeConn = {
    exec: async (command: string): Promise<ExecResult> => {
      executed.push(command);
      // Readback form 2 (file_equals) runs `cat` on **the same connection**, so it has to answer with the content
      if (command.startsWith('cat -- ')) {
        return { exitCode: 0, stdout: over.fileContent ?? '128', stderr: '', durationMs: 1, timedOut: false };
      }
      return (
        over.execResult ?? {
          exitCode: 0,
          stdout: '',
          stderr: '',
          durationMs: 1,
          timedOut: false,
        }
      );
    },
  };
  const deps: ActionExecutorDeps = {
    packId: 'rk3588-atk',
    contractVersion: 'devboard/v1',
    // **the current board** (the credential is bound to it — contract `spec/04` §2.4.1, sixth item)
    deviceKey: () => 'atk-01',
    hasExitCode: over.hasExitCode ?? true,
    runTransaction: async <T>(fn: (conn: Connection) => Promise<T>): Promise<T> =>
      fn(fakeConn as unknown as Connection),
    readTag: async (): Promise<TagReading | undefined> => undefined,
    granted: () => ({
      actions: {
        [action.id]: action.guard ?? undefined,
      },
    }),
    audit: (row: AuditRow): string => {
      audits.push(row);
      return `audit-${audits.length}`;
    },
  };
  return { deps, executed, audits };
}

describe('executor · happy path', () => {
  it('execute + read back + one audit row', async () => {
    const h = harness();
    const result = await invokeAction(ACTION, { value: 128 }, h.deps);
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
    // Execute + readback that reads the file (cat) — **both on the same connection**
    expect(h.executed[0]).toContain('echo 128 >');
    // A readback that reads the file = a `cat` **on the same connection** (the path is quoted by the rules of the shell)
    expect(h.executed[1]).toBe("cat -- '/sys/class/backlight/backlight/brightness'");
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]?.actionId).toBe('backlight.set');
  });

  it('**the command that runs is the encoded one** (the arguments are quoted)', async () => {
    const h = harness();
    await invokeAction(ACTION, { value: 128 }, h.deps);
    expect(h.executed[0]).toBe("echo 128 > /sys/class/backlight/backlight/brightness");
  });

  it('a string argument is injected in single quotes (the injection surface is closed)', async () => {
    const withString: ActionDef = {
      ...ACTION,
      id: 'note.set',
      params: { text: { type: 'string', maxLength: 64 } },
      command: 'echo {text} > /tmp/note',
      readback: { kind: 'none', consequence: 'wrote a file' },
    };
    const h = harness({ action: withString });
    await invokeAction(withString, { text: 'x; reboot' }, h.deps);
    expect(h.executed[0]).toBe("echo 'x; reboot' > /tmp/note");
  });

  it('the audit row carries the **final command** (the first link in the chain of accountability)', async () => {
    const h = harness();
    await invokeAction(ACTION, { value: 128 }, h.deps);
    // **The command is encoded** (the arguments are quoted)
    expect(h.audits[0]?.command).toBe('echo 128 > /sys/class/backlight/backlight/brightness');
  });

  it('the audit row carries the **params** and the **readback value**', async () => {
    const h = harness();
    await invokeAction(ACTION, { value: 128 }, h.deps);
    expect(h.audits[0]?.params).toEqual({ value: 128 });
    expect(h.audits[0]?.value).toBe('128');
  });

  it('the readback value in the result is **the same value** as the one in the audit row', async () => {
    const h = harness();
    const result = await invokeAction(ACTION, { value: 128 }, h.deps);
    expect(result.readback?.value).toBe(h.audits[0]?.value);
  });

  it('a readback mismatch is not ok, and verified is false', async () => {
    const h = harness({ fileContent: '100' });
    const result = await invokeAction(ACTION, { value: 128 }, h.deps);
    expect(result.ok).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('readback_mismatch');
  });
});

describe('executor · shape of the result (per the contract)', () => {
  it('the value that was read back is in `readback` (contract spec/04 §2.4 / spec/03 §5.2)', async () => {
    const h = harness();
    const result = await invokeAction(ACTION, { value: 128 }, h.deps);
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
    // **Not a flat `result.value`** — the contract writes `readback.value`
    expect(result.readback?.value).toBe('128');
  });

  it('the result carries an `audit_id` (the unit of accountability)', async () => {
    const h = harness();
    const result = await invokeAction(ACTION, { value: 128 }, h.deps);
    expect(result.audit_id).toBe('audit-1');
  });

  it('a readback mismatch carries `expected` / `actual` (the failure shape of the contract)', async () => {
    const h = harness({ fileContent: '100' });
    const result = await invokeAction(ACTION, { value: 128 }, h.deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('readback_mismatch');
    expect(result.expected).toBe('128');
    expect(result.actual).toBe('100');
  });
});

describe('executor · the verification command of the readback also passes the danger floor', () => {
  it('**a verify command that hits the danger floor is not run** (a command from the pack may not run a dangerous command in the name of verification)', async () => {
    const dangerous: ActionDef = {
      ...ACTION,
      id: 'probe',
      command: 'echo hi',
      readback: { kind: 'verify', command: 'rm -rf /' },
    };
    const h = harness({ action: dangerous });
    await expect(invokeAction(dangerous, { value: 128 }, h.deps)).rejects.toThrow(/danger floor/);
    // **That dangerous command was not sent**
    expect(h.executed.some((c) => c.includes('rm -rf'))).toBe(false);
  });
});

describe('executor · authorisation (exactly two criteria)', () => {
  it('destructive → **runs directly** (no prompt — the danger level is informational)', async () => {
    const destructive: ActionDef = { ...ACTION, danger: 'destructive' };
    const h = harness({ action: destructive });
    const result = await invokeAction(destructive, { value: 128 }, h.deps);
    expect(result.ok).toBe(true);
    // **The command really went out**
    expect(h.executed.length).toBeGreaterThan(0);
  });

  it('**a floor hit no longer blocks in the executor** (the floor is for validation and display — the gate is the permission area in the settings)', async () => {
    // The pack declares `reversible`, but **the encoded command** hits the floor
    const dangerous: ActionDef = {
      ...ACTION,
      id: 'wipe.root',
      command: 'rm -rf /',
      params: {},
      readback: { kind: 'none', consequence: 'delete the root' },
    };
    const h = harness({ action: dangerous });
    const result = await invokeAction(dangerous, {}, h.deps);
    expect(result.ok).toBe(true);
    // **The command went out** (**the executor no longer asks the operator whether it is dangerous**)
    expect(h.executed.some((c) => c.includes('rm -rf'))).toBe(true);
  });

  it('a param outside the guard range → **denied** (never "ask the operator" — the guard is the boundary the pack author drew)', async () => {
    const h = harness();
    const result = await invokeAction(ACTION, { value: 5 }, h.deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('denied');
    // **The command was not sent**
    expect(h.executed).toHaveLength(0);
  });

  it('an action that is not granted → denied, the command does not run', async () => {
    const h = harness();
    h.deps.granted = () => ({ actions: {} });
    const result = await invokeAction(ACTION, { value: 128 }, h.deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('denied');
    expect(h.executed).toHaveLength(0);
  });

  it('**a denial is audited as well** (one row per attempt, so the chain of accountability is unbroken)', async () => {
    const h = harness();
    const result = await invokeAction(ACTION, { value: 5 }, h.deps);
    expect(result.reason).toBe('denied');
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]?.ok).toBe(false);
  });

  it('**the result has no "needs confirmation" field** (the `needsConfirmation` outcome is gone)', async () => {
    const destructive: ActionDef = { ...ACTION, danger: 'destructive' };
    const h = harness({ action: destructive });
    const result = await invokeAction(destructive, { value: 128 }, h.deps);
    expect(Object.keys(result)).not.toContain('needsConfirmation');
  });
});

describe('executor · readback form 5', () => {
  it('none → ok but verified:false (not a failure, and not a claim of verification)', async () => {
    const led: ActionDef = {
      ...ACTION,
      id: 'led.blink',
      readback: { kind: 'none', consequence: 'lights the on-board LED for about 1 second' },
    };
    const h = harness({ action: led });
    const result = await invokeAction(led, { value: 128 }, h.deps);
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(false);
  });
});

describe('executor · execution and readback are inseparable', () => {
  it('the readback runs in **the same transaction** (runTransaction is called once)', async () => {
    const h = harness();
    let transactions = 0;
    const base = h.deps.runTransaction;
    h.deps.runTransaction = async <T>(fn: (conn: Connection) => Promise<T>): Promise<T> => {
      transactions += 1;
      return base(fn);
    };
    await invokeAction(ACTION, { value: 128 }, h.deps);
    expect(transactions).toBe(1);
  });
});
