import type { ExecResult } from '../hal/connection';
import type { TagReading } from '../../shared/tag-reading';
import type { ReadbackDef } from '../tags/schema';
import { PLACEHOLDER } from '../util/shell-quote';

/**
 * Readback — contract `docs/spec/02-board-pack.md` §4.4, "the five forms of
 * readback".
 *
 * ── Why the readback is mandatory ──
 *
 * Contract §5.2: "the readback is mandatory. After the runtime executes an
 * action it takes the value according to `readback` and returns that value as
 * the result of the action. The card must render from the returned value and
 * must not update optimistically on its own."
 *
 * → Without a readback there is no way to know whether the board really
 *   reached the target state, and a cockpit that shows "in effect" while
 *   nothing took effect is the one mistake this product must not make.
 *
 * ── The five forms ──
 *
 * | Form | What it looks at |
 * |---|---|
 * | 1 `tag` (the default) | Reads that one tag on purpose (a fresh one, not waiting for the next cycle) |
 * | 2 `file_equals` | Reads the file and compares the value (`expect` may be `{param}`, there is a `tolerance`) |
 * | 3 `command_ok` | The exit code of the action's own command (it does not run a second command) |
 * | 4 `verify` | Runs a second verification command, polling until it succeeds or times out |
 * | 5 `none` | There is no observable state → `ok: true` + `verified: false` |
 *
 * ── There is no exit code on a serial port (fact S5) ──
 *
 * Forms 3 and 4 both look at the exit code → they must be rejected on a
 * serial transport (contract §4.4, at the end: "these two forms must be
 * rejected on a serial transport").
 */

/** The result of the readback */
export interface ReadbackResult {
  /** Did the action execute successfully (did the command finish) */
  ok: boolean;
  /** Was it confirmed that the board really reached the target state */
  verified: boolean;
  /** The value read back */
  value?: number | string | boolean | null;
  unit?: string;
  /** The status of the tag that was read back */
  status?: TagReading['status'];
  /** Why it does not match / why it does not hold */
  reason?:
    | 'readback_mismatch'
    | 'not_found'
    | 'timeout'
    | 'unsupported_transport'
    | 'failed'
    /** It was called off ✓ (not "does not match" ✓ — a human calling it off ≠ the board not obeying ✓) */
    | 'cancelled';
  /** The expected value */
  expected?: unknown;
  /** The actual value */
  actual?: unknown;
  /** One line for a human to read */
  detail?: string;
}

/** The parameters (with two faces) */
export interface ReadbackParams {
  /** The raw values — used for comparing (`expect` is a value, not a shell fragment) */
  raw: Record<string, unknown>;
  /** The encoded fragments — used for assembling commands (like `'x'`) */
  encoded: Record<string, string>;
}

/** The capabilities the readback needs (all of them "what it can do", not "how it connects") */
export interface ReadbackDeps {
  /** Read one tag (a fresh one) */
  readTag: (tag: string) => Promise<TagReading | undefined>;
  /** Read one file (remote); `null` when it cannot be read */
  readFile: (path: string) => Promise<string | null>;
  /** Run one command */
  exec: (command: string) => Promise<ExecResult>;
  /** Does this connection have an exit code (serial does not, fact S5) */
  hasExitCode: boolean;
  /** Wait a while (used by the `verify` polling) */
  sleep?: (ms: number) => Promise<void>;
}

/** Replace `{param}` with the given value */
function substitute(text: string, values: Record<string, unknown>): string {
  return text.replace(PLACEHOLDER, (_match, name: string) => {
    const value = values[name];
    return value === undefined ? `{${name}}` : String(value);
  });
}

/** Do two values count as equal (numbers are compared as numbers, the rest as literals) */
function sameValue(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (actual === null || actual === undefined) return false;
  const a = typeof actual === 'number' ? actual : Number(actual);
  const b = typeof expected === 'number' ? expected : Number(expected);
  if (Number.isFinite(a) && Number.isFinite(b) && typeof actual !== 'string') return a === b;
  return String(actual) === String(expected);
}

/** Form 1: read one tag */
async function readTagForm(
  spec: ReadbackDef,
  params: ReadbackParams,
  deps: ReadbackDeps,
): Promise<ReadbackResult> {
  const tag = spec.tag;
  if (typeof tag !== 'string' || tag.length === 0) {
    return { ok: false, verified: false, reason: 'failed', detail: '回读没有说读哪个 tag' };
  }
  const reading = await deps.readTag(tag);
  if (reading === undefined) {
    return { ok: false, verified: false, reason: 'not_found', detail: `读不到 ${tag}` };
  }
  if (reading.status !== 'ok') {
    // Not ok means "cannot be confirmed as in effect" —
    // a stale value is an old one (the board may not have reached the target
    // state yet), and unavailable/error need no further explanation.
    return {
      ok: false,
      verified: false,
      reason: 'failed',
      status: reading.status,
      actual: reading.value,
      detail: reading.detail ?? `${tag} 的状态是 ${reading.status}，不能算确认生效`,
    };
  }
  if (spec.expect === undefined) {
    // No expect → reading it is the confirmation (the default use of form 1)
    return { ok: true, verified: true, value: reading.value, unit: reading.unit, status: reading.status };
  }
  const expected = substitute(String(spec.expect), params.raw);
  if (!sameValue(reading.value, expected)) {
    return {
      ok: false,
      verified: false,
      reason: 'readback_mismatch',
      expected,
      actual: reading.value,
      detail: '回读到的值与期望不符',
    };
  }
  return { ok: true, verified: true, value: reading.value, unit: reading.unit, status: reading.status };
}

/** Form 2: read the file and compare the value */
async function readFileForm(
  spec: ReadbackDef,
  params: ReadbackParams,
  deps: ReadbackDeps,
): Promise<ReadbackResult> {
  const path = substitute(String(spec.path ?? ''), params.raw);
  const content = await deps.readFile(path);
  if (content === null) {
    return { ok: false, verified: false, reason: 'not_found', detail: `读不到 ${path}` };
  }
  const actual = content.trim();
  const expected = substitute(String(spec.expect ?? ''), params.raw);
  const tolerance = spec.tolerance;
  const matches =
    tolerance === undefined
      ? actual === expected
      : (() => {
          const a = Number(actual);
          const b = Number(expected);
          return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
        })();
  if (!matches) {
    return {
      ok: false,
      verified: false,
      reason: 'readback_mismatch',
      expected,
      actual,
      detail: '回读到的值与期望不符',
    };
  }
  return { ok: true, verified: true, value: actual, detail: `${path} = ${actual}` };
}

/** Form 3: the exit code of the action's own command */
function commandOkForm(
  deps: ReadbackDeps,
  actionResult: ExecResult | undefined,
): ReadbackResult {
  if (!deps.hasExitCode) {
    return {
      ok: false,
      verified: false,
      reason: 'unsupported_transport',
      detail: '这条连接没有退出码（串口），command_ok 用不了',
    };
  }
  if (actionResult === undefined) {
    return { ok: false, verified: false, reason: 'failed', detail: '没有动作的执行结果可比' };
  }
  if (actionResult.timedOut) {
    return { ok: false, verified: false, reason: 'timeout', detail: '动作那条命令超时了' };
  }
  // It was cancelled → the exit code is `null` ✓ (neither 0 nor 124 ✓)
  // → Without looking at this flag it would fall into the "returned non-zero"
  //   bucket ✗
  // → Reporting "the readback does not match" would be a lie ✗ (a human
  //   calling it off ≠ the board not obeying ✓)
  if (actionResult.cancelled === true) {
    return { ok: false, verified: false, reason: 'cancelled', detail: '动作那条命令被取消了' };
  }
  if (actionResult.exitCode !== 0) {
    return {
      ok: false,
      verified: false,
      reason: 'readback_mismatch',
      expected: 0,
      actual: actionResult.exitCode,
      detail: actionResult.stderr.trim() || '动作那条命令返回非零',
    };
  }
  return { ok: true, verified: true, value: actionResult.exitCode, detail: '命令返回 0' };
}

/** Form 4: run a second verification command, polling until it succeeds or times out */
async function verifyForm(
  spec: ReadbackDef,
  params: ReadbackParams,
  deps: ReadbackDeps,
): Promise<ReadbackResult> {
  if (!deps.hasExitCode) {
    return {
      ok: false,
      verified: false,
      reason: 'unsupported_transport',
      detail: '这条连接没有退出码（串口），verify 用不了',
    };
  }
  const command = substitute(String(spec.command ?? ''), params.encoded);
  const timeoutMs = spec.timeout_ms ?? 5_000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await deps.exec(command);
    if (!result.timedOut && result.exitCode === 0) {
      return { ok: true, verified: true, value: 0, detail: '验证命令返回 0' };
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        verified: false,
        reason: 'timeout',
        detail: `验证命令在 ${timeoutMs}ms 内没成功`,
      };
    }
    await sleep(100);
  }
}

/**
 * Take one value according to the readback declaration.
 *
 * @param spec The readback block declared in the board pack
 * @param params The parameters of this call (raw values + encoded fragments)
 * @param deps The capabilities (read a tag / read a file / run a command)
 * @param actionResult The execution result of the action's own command (form 3
 *   looks at it)
 */
export async function runReadback(
  spec: ReadbackDef,
  params: ReadbackParams,
  deps: ReadbackDeps,
  actionResult?: ExecResult,
): Promise<ReadbackResult> {
  const kind = spec.kind ?? 'tag';
  switch (kind) {
    case 'tag':
      return readTagForm(spec, params, deps);
    case 'file_equals':
      return readFileForm(spec, params, deps);
    case 'command_ok':
      return commandOkForm(deps, actionResult);
    case 'verify':
      return verifyForm(spec, params, deps);
    case 'none':
      // Form 5: `ok: true` + `verified: false` —
      // not `ok: false` (the command really did run and the effect really is
      // there), and not `ok: true` with nothing said either (that hides "not
      // verified").
      return {
        ok: true,
        verified: false,
        detail: spec.consequence ?? '这个动作没有可回读的状态',
      };
    default:
      return {
        ok: false,
        verified: false,
        reason: 'failed',
        detail: `不知道的回读形式：${kind}`,
      };
  }
}
