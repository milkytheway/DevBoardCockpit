import { spawn } from 'node:child_process';

/**
 * The one place where child processes are started.
 *
 * Three hard constraints:
 *
 * - Device fact G3: on Windows a process launched from a GUI opens a
 *   console window by default → `windowsHide: true` is mandatory.
 *   Otherwise the legacy project's "sample metrics once a second → the
 *   screen flickers wildly" happens again.
 * - Device fact G1: every timeout is normalised to 124, and the callers
 *   recognise that one meaning only.
 * - Device fact A8: the output is decoded as UTF-8, bad bytes are replaced
 *   with U+FFFD, and a bad byte must not void the whole command.
 */

export interface SpawnResult {
  /** null = killed by a signal or never exited. Always null over the serial port (device fact S5) */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** When true, exitCode is necessarily 124 */
  timedOut: boolean;
  /**
   * The pid of the child process (for diagnostics).
   *
   * → "After the cancellation, is the process really gone?" — this
   *   criterion depends on it (the phenomenon measured on a real board
   *   was "the process is still running").
   */
  pid?: number;
  /**
   * It was cancelled (not a timeout — the two must not share a code:
   * "waited too long and got no result" and "the human called it off" are
   * two different things).
   */
  cancelled?: boolean;
}

export interface SpawnOptions {
  /** Timeout in milliseconds, 30000 by default */
  timeoutMs?: number;
  /** The content written to the child process stdin */
  input?: string;
  /** Environment variables appended to process.env */
  env?: Record<string, string>;
  /**
   * Stopping it halfway through (`AbortSignal`).
   *
   * → A timeout means "waited too long"; a cancellation means "the human no
   *   longer wants it" — the two are kept apart (a real-board measurement
   *   showed a 75-second transfer step running to completion after the cancel arrived —
   *   precisely because this path did not exist).
   * → A cancellation kills the child process (merely not waiting leaves it
   *   running in the background).
   */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** The unified timeout code (device fact G1) — the same constant as in `hal/session.ts` */
const TIMEOUT_EXIT_CODE = 124;

export function runProcess(
  command: string,
  args: string[],
  opts: SpawnOptions = {},
): Promise<SpawnResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  return new Promise<SpawnResult>((resolve, reject) => {
    // stdin uses 'pipe' rather than 'ignore': it is only needed when there
    // is input to write. Both cases end stdin, so the child sees EOF
    // instead of waiting for input forever.
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...opts.env },
    });

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    // ── Cancellation: kill the child process ──
    // → "Stop waiting" is not enough: the process keeps running in the
    //   background (a real-board measurement showed a 75-second transfer running to
    //   completion anyway)
    // → SIGTERM first, giving it 200ms to exit on its own; if it does not,
    //   SIGKILL
    const onAbort = (): void => {
      if (settled) return;
      cancelled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // If it has already exited, fine
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // If it is already gone, fine
        }
      }, 200);
    };
    if (opts.signal !== undefined) {
      if (opts.signal.aborted) {
        // Cancelled right from the start → do not start it at all (and still
        // mark it cancelled)
        cancelled = true;
        child.kill();
      } else {
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    child.stdout?.on('data', (c: Buffer) => outChunks.push(c));
    child.stderr?.on('data', (c: Buffer) => errChunks.push(c));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode: timedOut ? TIMEOUT_EXIT_CODE : code,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        durationMs: Date.now() - startedAt,
        timedOut,
        ...(cancelled ? { cancelled: true } : {}),
        pid: child.pid,
      });
    });

    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    } else {
      // With no input, close stdin so the child sees EOF instead of waiting
      // forever
      child.stdin?.end();
    }
  });
}
