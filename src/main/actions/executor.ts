import { makeError } from '../../shared/errors';
import type { Connection, ExecResult } from '../hal/connection';
import type { ActionDef } from '../tags/schema';
import type { TagReading } from '../../shared/tag-reading';
import { buildCommand } from './encoder';
import { quoteShellValue } from '../util/shell-quote';
import { checkFloor } from './floor-check';
import { authorize, type GrantedActions } from './authorization';
import { runReadback } from './readback';
import type { AuditRow } from './audit';

/**
 * The action executor — contract `docs/spec/02-board-pack.md` §5.2 and the
 * seven-step chain.
 *
 * ```
 * ① Encode the parameters → ② Re-check the floor → ③ Authorize
 *                         → ④ (Confirm if necessary)
 *                         → ⑤ Execute → ⑥ Readback → ⑦ Audit
 * ```
 *
 * → **Where each step happens** ✓ (the comments are the design ✓):
 *   ① **here** ✓ (the parameters are encoded by type ✓ — never interpolated ✓)
 *   ② **here, and only for the readback's `verify` command** ✓ — the pack's
 *      own command was judged by the **validator** when the pack was loaded ✓
 *      (rule 16 ✓) and the **runtime does not check it again** ✓ (contract
 *      `02` §5.2 ✓ — "it no longer re-checks" ✓).
 *      → The verify command is given by the pack ✓ → it has to pass the
 *      floor as well ✓ (otherwise a pack could run `rm -rf /` under the name
 *      of "verification" ✗ — two independent reviews flagged this ✓).
 *   ③ **in the session layer** ✓ (the manifest's declaration is the
 *   permission ✓ — ADR-D46 ✓)
 *   ④ **gone** ✓ (the confirmation chain was cut ✓ — ADR-D48 ✓)
 *   ⑤ ⑥ ⑦ **here** ✓ (one exclusive transaction ✓ — SPEC-D22 ✓)
 *
 * ── Execution and readback are one inseparable exclusive transaction
 *    (implementation decision records ADR-D23 / SPEC-D22) ──
 *
 * If the readback is interleaved by a sample, what it reads may be the output
 * of a different command — "the readback does not match" would then be a
 * false negative, and the cockpit would display a wrong real state.
 * → So both of them run inside `runTransaction` (the same queue slot).
 */

/** What the executor needs */
export interface ActionExecutorDeps {
  /** The board pack id (the credentials are bound to it) */
  packId: string;
  /** The contract version (the credentials are bound to it) */
  contractVersion: string;
  /**
   * Which board this step touches (the credentials are bound to it ✓ —
   * contract `spec/04` §2.4.1, the sixth item ✓).
   *
   * → It is a function, not a value ✓ — the current connection can change ✓
   *   (the board was swapped ✓)
   * → The issuing side and the consuming side read the same function ✓ → so
   *   the two agree ✓.
   */
  deviceKey: () => string;
  /** Does this connection have an exit code (serial does not, fact S5) */
  hasExitCode: boolean;
  /** Run one exclusive transaction on this connection (execution + readback both live inside it) */
  runTransaction: <T>(fn: (connection: Connection) => Promise<T>) => Promise<T>;
  /** Read one tag (a fresh one) */
  readTag: (tag: string) => Promise<TagReading | undefined>;
  /** Granted actions (**the card declares them** ✓ — the permission area decides whether they may run ✓) */
  granted: () => GrantedActions;
  // There is no "should we ask a human" item any more ✓ (2026-11-16 ✓ ·
  // implementation decision record ADR-D48 ✓) —
  // to control what may be done, use the unified permission area in the
  // settings ✓ (implementation decision record ADR-D47 ✓).
  audit: (row: AuditRow) => string;
  /** Who triggered it (card id / agent / user) */
  actor?: string;
  /**
   * The input of this step (given by the workflow layer ✓ — a workflow's
   * parameters are declared in the workflow pack, not in the board pack ✓;
   * without this, afterwards you only see "some step ran" and not "which
   * project was used" ✗ — a link of the chain of accountability is broken
   * ✓).
   */
  auditInputs?: Record<string, unknown>;
  /**
   * Call it off midway (`AbortSignal` ✓) — "the human does not want it any
   * more" ✓.
   *
   * → The workflow layer uses it to implement "cancel" ✓ (`spec/05` §8 ✓);
   * → it is kept apart from the timeout ✓ (a timeout is "waited too long" ✓).
   */
  execSignal?: AbortSignal;
  /**
   * The execution timeout (milliseconds).
   *
   * → The workflow layer's long steps (compiling takes minutes) use it ✓;
   * → without one there is no timeout at all ✓ (the actions of M6 are
   *   usually fast ✓).
   */
  execTimeoutMs?: number;
  /** Now (milliseconds) */
  now?: () => number;
}

/**
 * The result of one invocation.
 *
 * ── The shape follows the contract, not the convenience of the
 *    implementation ──
 *
 * `spec/04` §2.4 (`execute_action`) and `spec/03` §5.2
 * (`cockpit.actions.invoke`):
 *
 * ```
 * → { ok: true,  readback: { value, unit, status, at }, verified: true, audit_id: "..." }
 * → { ok: false, reason: "readback_mismatch", expected: true, actual: false }
 * ```
 *
 * → The value read back lives in `readback` (the card renders it as
 *   `r.readback.value`), not flattened at the top level.
 * → On failure it carries `expected` / `actual` (a human can see how far off
 *   it is).
 * → `audit_id` is the unit of accountability (the timeline of ADR-D31 R8
 *   references it).
 */
export interface ActionOutcome {
  /** Did the action succeed */
  ok: boolean;
  /** Was it confirmed that the board really reached the target state */
  verified: boolean;
  /** The real state read back (the `readback` of contract §2.4) */
  readback?: {
    value?: unknown;
    unit?: string;
    /** The status of the tag that was read back (only form 1 has it) */
    status?: TagReading['status'];
    /** The moment of the readback (milliseconds UTC) */
    at: number;
  };
  /** Why it did not succeed */
  reason?: string;
  /** The expected value (given on failure) */
  expected?: unknown;
  /** The actual value (given on failure) */
  actual?: unknown;
  /** One line for a human to read */
  detail?: string;
  /** The id of the audit row (the unit of accountability) */
  audit_id?: string;
  /**
   * The output of the command (stdout, truncated ✓).
   *
   * → A request like "run it and show me the output" needs it ✓
   *   (the user's "watch the intermediate result" card relies on it ✓);
   * → a workflow step needs it too: hand the output of one command to the
   *   next step ✓ (the credential preparation step: the source target's
   *   public key → the target's `authorized_keys` ✓).
   */
  output?: string;
  /** Was the output truncated (say so, do not let people think they saw all of it) */
  outputTruncated?: boolean;
}

/** Invoke one action */
export async function invokeAction(
  action: ActionDef,
  params: Record<string, unknown>,
  deps: ActionExecutorDeps,
): Promise<ActionOutcome> {
  const now = deps.now ?? (() => Date.now());
  const at = now();
  const actor = deps.actor ?? 'unknown';

  /**
   * Write one audit row and put its id back into the result.
   *
   * → The `audit_id` in the result is that row (contract `spec/04` §2.4).
   */
  const record = (outcome: ActionOutcome, value?: unknown): void => {
    outcome.audit_id = deps.audit({
      at,
      actor,
      actionId: action.id,
      params,
      // The final command goes into the audit row (the first link of the chain
      // of accountability ✓ — afterwards it has to be possible to reconstruct
      // "what exactly was executed" ✓)
      command,
      ...(deps.auditInputs === undefined ? {} : { inputs: deps.auditInputs }),
      ok: outcome.ok,
      verified: outcome.verified,
      ...(value === undefined ? {} : { value }),
      ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
    });
  };

  // ① Encode (§4.6) — an invalid parameter is rejected on the spot, the
  // command is not executed
  let command: string;
  let encoded: Record<string, string>;
  try {
    const built = buildCommand(action.command, action.params ?? {}, params);
    command = built.command;
    encoded = built.encoded;
  } catch (err) {
    const outcome: ActionOutcome = {
      ok: false,
      verified: false,
      reason: 'invalid_params',
      detail: err instanceof Error ? err.message : String(err),
    };
    record(outcome);
    return outcome;
  }

  // ② Authorize (two criteria ✓ — implementation decision record ADR-D48 ✓)
  const verdict = authorize(action, params, deps.granted());

  if (verdict.verdict === 'denied') {
    const outcome: ActionOutcome = {
      ok: false,
      verified: false,
      reason: 'denied',
      detail: verdict.detail,
    };
    record(outcome);
    return outcome;
  }

  // ③⑥ Execute + readback (the same exclusive transaction)
  const { result: readback, execResult } = await deps.runTransaction(async (connection) => {
    const execResult = await connection.exec(command, {
      ...(deps.execTimeoutMs === undefined ? {} : { timeoutMs: deps.execTimeoutMs }),
      ...(deps.execSignal === undefined ? {} : { signal: deps.execSignal }),
    });
    const result = await runReadback(
      action.readback ?? { kind: 'none', consequence: 'this action declares no readback' },
      { raw: params, encoded },
      {
        readTag: deps.readTag,
        // Reading a file = `cat` on that same connection — the HAL has no
        // "read the content of a remote file" capability (only list / pull /
        // push). And it has to happen inside the same transaction: opening
        // another round trip would slot itself between the action and the
        // readback (SPEC-D22).
        readFile: async (path: string): Promise<string | null> => {
          const cat = await connection.exec(`cat -- ${quoteShellValue(path)}`);
          return cat.timedOut || cat.exitCode !== 0 ? null : cat.stdout;
        },
        // The readback's `verify` also runs on the same connection.
        //
        // It has to pass the danger floor as well (the `verify` command is
        // given by the pack ✓): without the check a pack could run `rm -rf /`
        // on the board under the name of "verification" ✗ (two independent
        // reviews both flagged this ✓).
        exec: (cmd: string): Promise<ExecResult> => {
          const verifyFloor = checkFloor(cmd);
          if (verifyFloor.verdict === 'destructive') {
            throw makeError(
              'PACK_INVALID',
              `the verification command of the readback hits the danger floor (${verifyFloor.why ?? 'dangerous command'}), not executed`,
              { detail: { command: cmd, pattern: verifyFloor.pattern } },
            );
          }
          return connection.exec(cmd);
        },
        hasExitCode: deps.hasExitCode,
      },
      execResult,
    );
    return { execResult, result };
  });

  // It was cancelled → that is not "failure", it is "the human called it off" ✓
  // → It has to be checked here ✓: when the readback form is `none` it
  //   reports `ok: true` ✓ (the command really did run and the effect really
  //   is there ✓ — but it was cut in half ✗ → that would be a lie ✗)
  if (execResult.cancelled === true) {
    const cancelledOutcome: ActionOutcome = {
      ok: false,
      verified: false,
      reason: 'cancelled',
      detail: 'this execution was cancelled',
    };
    record(cancelledOutcome);
    return cancelledOutcome;
  }

  const hasReadback =
    readback.value !== undefined || readback.unit !== undefined || readback.status !== undefined;
  // The output has to be truncated (the output of a compile can run to tens of
  // thousands of lines → passing all of it along would overwhelm the IPC and
  // the audit ✓)
  const rawOutput = execResult.stdout ?? '';
  const OUTPUT_LIMIT = 8 * 1024;
  const truncated = rawOutput.length > OUTPUT_LIMIT;
  const output = truncated ? rawOutput.slice(-OUTPUT_LIMIT) : rawOutput;

  const outcome: ActionOutcome = {
    ok: readback.ok,
    verified: readback.verified,
    ...(output === '' ? {} : { output }),
    ...(truncated ? { outputTruncated: true } : {}),
    // The value read back lives in `readback` (contract §2.4 / §5.2 — the card
    // renders it as `r.readback.value`)
    ...(hasReadback
      ? {
          readback: {
            ...(readback.value === undefined ? {} : { value: readback.value }),
            ...(readback.unit === undefined ? {} : { unit: readback.unit }),
            ...(readback.status === undefined ? {} : { status: readback.status }),
            at,
          },
        }
      : {}),
    ...(readback.reason === undefined ? {} : { reason: readback.reason }),
    ...(readback.expected === undefined ? {} : { expected: readback.expected }),
    ...(readback.actual === undefined ? {} : { actual: readback.actual }),
    ...(readback.detail === undefined ? {} : { detail: readback.detail }),
  };
  record(outcome, readback.value);
  return outcome;
}
