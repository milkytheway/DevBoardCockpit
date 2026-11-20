import { describe, it, expect } from 'vitest';
import { runReadback, type ReadbackDeps } from '../../../src/main/actions/readback';
import type { TagReading } from '../../../src/shared/tag-reading';

/**
 * The five forms of readback — contract `docs/spec/02-board-pack.md` §4.4.
 *
 * Why the readback is mandatory, in the words of the contract §5.2: "The
 * readback is mandatory. After the action has run, the runtime takes a value
 * according to the `readback` and returns it as the result of the action. A
 * card **must** render the returned value and may not update itself
 * optimistically."
 *
 * Without a readback there is no way to know whether the board really entered
 * the intended state. A cockpit that shows "applied" when nothing happened is
 * the one kind of error this product must never produce.
 */
function deps(overrides: Partial<ReadbackDeps> = {}): ReadbackDeps {
  return {
    readTag: async () => undefined,
    readFile: async () => null,
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false }),
    hasExitCode: true,
    ...overrides,
  };
}

function reading(overrides: Partial<TagReading> = {}): TagReading {
  return {
    tag: 'system.load',
    value: 1,
    unit: '',
    status: 'ok',
    at: 1_700_000_000_000,
    seq: 1,
    ...overrides,
  };
}

describe('readback · form 1 (tag, the default form)', () => {
  it('the value matches → ok + verified + the value', async () => {
    const result = await runReadback(
      { tag: 'system.load', expect: '1' },
      { raw: {}, encoded: {} },
      deps({ readTag: async () => reading({ value: 1 }) }),
    );
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.value).toBe(1);
  });

  it('the value does not match → not ok, and it states what was expected and what was actual', async () => {
    const result = await runReadback(
      { tag: 'system.load', expect: '1' },
      { raw: {}, encoded: {} },
      deps({ readTag: async () => reading({ value: 0 }) }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('readback_mismatch');
    expect(result.expected).toBe('1');
    expect(result.actual).toBe(0);
  });

  it('the tag cannot be read → not_found (not a mismatch)', async () => {
    const result = await runReadback(
      { tag: 'system.load', expect: '1' },
      { raw: {}, encoded: {} },
      deps({ readTag: async () => undefined }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_found');
  });

  it('the tag itself is unavailable → it still does not count as confirmed', async () => {
    const result = await runReadback(
      { tag: 'system.load', expect: '1' },
      { raw: {}, encoded: {} },
      deps({ readTag: async () => reading({ status: 'unavailable', value: null }) }),
    );
    expect(result.ok).toBe(false);
  });
});

describe('readback · form 2 (file_equals)', () => {
  it('equal → ok', async () => {
    const result = await runReadback(
      { kind: 'file_equals', path: '/sys/backlight', expect: '128' },
      { raw: {}, encoded: {} },
      deps({ readFile: async () => '128' }),
    );
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
  });

  it('not equal → mismatch', async () => {
    const result = await runReadback(
      { kind: 'file_equals', path: '/sys/backlight', expect: '128' },
      { raw: {}, encoded: {} },
      deps({ readFile: async () => '100' }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('readback_mismatch');
  });

  it('with a tolerance: a difference of 1 is inside it → counts as a match', async () => {
    const result = await runReadback(
      { kind: 'file_equals', path: '/sys/backlight', expect: '128', tolerance: 1 },
      { raw: {}, encoded: {} },
      deps({ readFile: async () => '127' }),
    );
    expect(result.ok).toBe(true);
  });

  it('with a tolerance: a difference of 2 exceeds it → mismatch', async () => {
    const result = await runReadback(
      { kind: 'file_equals', path: '/sys/backlight', expect: '128', tolerance: 1 },
      { raw: {}, encoded: {} },
      deps({ readFile: async () => '126' }),
    );
    expect(result.ok).toBe(false);
  });

  it('the file cannot be read → not_found', async () => {
    const result = await runReadback(
      { kind: 'file_equals', path: '/sys/backlight', expect: '128' },
      { raw: {}, encoded: {} },
      deps({ readFile: async () => null }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_found');
  });
});

describe('readback · form 3 (command_ok) and form 4 (verify)', () => {
  it('command_ok: **the command of the action itself** returns 0 → ok (**no second command is run**)', async () => {
    let executed = 0;
    const result = await runReadback(
      { kind: 'command_ok' },
      { raw: {}, encoded: {} },
      deps({
        exec: async () => {
          executed += 1;
          return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
        },
      }),
      { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false },
    );
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
    expect(executed).toBe(0);
  });

  it('command_ok: the command of the action returns non-zero → mismatch', async () => {
    const result = await runReadback(
      { kind: 'command_ok' },
      { raw: {}, encoded: {} },
      deps(),
      { exitCode: 1, stdout: '', stderr: 'boom', durationMs: 1, timedOut: false },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('readback_mismatch');
  });

  it('on a **connection without an exit code** (serial), command_ok is rejected', async () => {
    const result = await runReadback(
      { kind: 'command_ok' },
      { raw: {}, encoded: {} },
      deps({ hasExitCode: false }),
      { exitCode: null, stdout: '', stderr: '', durationMs: 1, timedOut: false },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unsupported_transport');
  });

  it('**the command of the action was cancelled** → the reason is cancelled (**not a mismatch**)', async () => {
    // The exit code of a cancelled command is `null` (neither 0 nor 124).
    // Without the `cancelled` flag it would fall into the "returned non-zero" branch.
    // Reporting a readback mismatch would be a lie: the operator stopped it, the board did not disobey.
    const result = await runReadback(
      { kind: 'command_ok' },
      { raw: {}, encoded: {} },
      deps(),
      { exitCode: null, stdout: '', stderr: '', durationMs: 1, timedOut: false, cancelled: true },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('cancelled');
  });

  it('verify: the command succeeds → ok', async () => {
    const result = await runReadback(
      { kind: 'verify', command: 'test -e /tmp/marker', timeout_ms: 500 },
      { raw: {}, encoded: {} },
      deps({ exec: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false }) }),
    );
    expect(result.ok).toBe(true);
  });

  it('verify: the command never succeeds → timeout (not a mismatch)', async () => {
    const result = await runReadback(
      { kind: 'verify', command: 'test -e /tmp/marker', timeout_ms: 30 },
      { raw: {}, encoded: {} },
      deps({
        exec: async () => ({ exitCode: 1, stdout: '', stderr: '', durationMs: 1, timedOut: false }),
        sleep: async () => new Promise((r) => setTimeout(r, 5)),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('timeout');
  });

  it('on a **connection without an exit code**, verify is rejected as well', async () => {
    const result = await runReadback(
      { kind: 'verify', command: 'test -e /tmp/marker' },
      { raw: {}, encoded: {} },
      deps({ hasExitCode: false }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unsupported_transport');
  });
});

describe('readback · form 5 (none)', () => {
  it('ok: true but **verified: false** (neither a failure nor "nothing was said")', async () => {
    const result = await runReadback(
      { kind: 'none', consequence: 'lights the on-board LED for about 1 second' },
      { raw: {}, encoded: {} },
      deps(),
    );
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.detail).toContain('LED');
  });
});

describe('readback · parameter substitution (expect may name an argument)', () => {
  it('{value} in expect uses the **original value** of this call (not the shell fragment)', async () => {
    const result = await runReadback(
      { kind: 'file_equals', path: '/sys/backlight', expect: '{value}' },
      { raw: { value: '128' }, encoded: { value: "'128'" } },
      deps({ readFile: async () => '128' }),
    );
    expect(result.ok).toBe(true);
  });

  it('the value substituted for {value} in expect does not match the file → mismatch', async () => {
    const result = await runReadback(
      { kind: 'file_equals', path: '/sys/backlight', expect: '{value}' },
      { raw: { value: '128' }, encoded: { value: "'128'" } },
      deps({ readFile: async () => '100' }),
    );
    expect(result.ok).toBe(false);
  });
});
