import type { Session } from './session';
import type { TransportKind } from '../../shared/ipc-contract';

/**
 * The common interface of the connection layer.
 *
 * The four transports (serial / ADB / SSH / local) implement the same
 * interface, so the UI and the capability layer never need to know which
 * wire they are attached to — this is where "one unified workbench" lands in
 * code.
 */

/**
 * Capability bits. **The UI degrades by capability**, not by transport name.
 *
 * The old project paid for this: terminal mode (pty/pipe) used to be inferred
 * from the transport name, so a newly registered transport was treated as a
 * real terminal. Here the capabilities are made explicit.
 *
 * Defined in `shared/ipc-contract.ts` — the renderer also needs it to decide
 * "whether the file browser entry point has to be disabled", and the renderer
 * cannot import from main.
 */
export type { ConnectionCapabilities, FileEntry } from '../../shared/ipc-contract';
import type { ConnectionCapabilities, FileEntry } from '../../shared/ipc-contract';

export interface ExecResult {
  /** null = unobtainable (serial). A timeout is always 124 */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /**
   * **It was cancelled** (not a timeout ✓ — the two must not share a code ✓:
   * "waited long and got nothing" and "a human called it off" are two
   * different things ✗).
   *
   * → The vanguard's real-device test: without this path, a 75-second
   * transfer step **ran to completion after being cancelled** ✗.
   */
  cancelled?: boolean;
  /**
   * **The next step for the human** (optional).
   *
   * It is only given when "the shape of the failure is easy to misread": the
   * most common reason for a serial timeout is "**the reply was eaten by
   * another program**", not "the board is slow" — without saying so, people
   * go debugging in the wrong direction.
   *
   * **Adding a field does not change the semantics**: a timeout is still
   * `exitCode: 124` (Fact G1).
   */
  hint?: string;
}

/**
 * The options for executing one command.
 *
 * → **`signal` means "call it off midway"** ✓ (`AbortSignal` ✓):
 * a timeout is "waited too long" ✓, a cancellation is "**the human no
 * longer wants it**" ✓ — the two are kept apart ✓.
 */
export interface ExecOptions {
  /** Timeout (milliseconds) */
  timeoutMs?: number;
  /** Call it off midway (`AbortSignal` ✓) */
  signal?: AbortSignal;
}

export interface Connection {
  readonly id: string;
  readonly transport: TransportKind;
  capabilities(): ConnectionCapabilities;
  open(): Promise<void>;
  close(): Promise<void>;
  /**
   * **The most recent link error** ✓ — the connection that dropped says why
   * ✓.
   *
   * → It was written into a field **nobody read** ✓ (the SSH and the serial
   *   connection both had it ✓ · the interface never saw it ✓) →
   *   **the terminal just said "the session ended"** ✓ → the user could not
   *   tell a pulled cable from a refused port ✓ (found on 2026-11-21 ✓).
   */
  readonly lastError?: Error;
  /**
   * The lines the host wants to show in the terminal ✓ (optional ✓).
   *
   * → **They are not from the board** ✓ — they are what the host has to
   *   say about the link ✓ ("the port opened but the board said nothing" ✓).
   * → They are **queued** ✓ and drained after the terminal has subscribed ✓
   *   (a line that is written before the subscription is lost ✓ — the same
   *   trap as the first output of a session ✓).
   */
  drainNotices?(): string[];
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  /**
   * File transfer.
   *
   * **Dispatched by transport**, not by running a remote `pull`/`push`
   * command — the board has neither command (adb's pull is `adb pull`, ssh's
   * is sftp).
   *
   * ── Semantic convention: a remote path is always a "directory" ──
   *
   * The underlying tool of each of the three transports means something
   * different by "target":
   * - `adb push <local> <directory>` — the target is a directory, adb
   *   appends the basename itself ✓
   * - `sftp.fastPut(<local>, <remote file>)` — the target is a **full file
   *   path**
   * - `copyFile(<local>, <remote file>)` — the target is a **full file path**
   *
   * Hence the **unified convention: `remotePath` is a directory**, and each
   * transport appends the basename itself. Otherwise "upload to a given
   * directory" would break on SSH and on the local transport
   * (`copyFile(src, '/')` → ENOENT).
   * (Plan 1 re-review, finding S-05)
   */
  pull(remotePath: string, localPath: string): Promise<void>;
  push(localPath: string, remotePath: string): Promise<void>;

  /**
   * List a remote directory.
   *
   * **Dispatched by transport**, not by running a remote `ls` — the local
   * transport is Windows' cmd.exe, where the POSIX `ls -la` simply does not
   * exist (Task 9 of the original implementation plan says "adb uses
   * `adb shell ls -la`, ssh uses ssh2's `sftp`").
   *
   * The `sizeBytes` of a directory is `null` (what cannot be read is not 0 —
   * Fact G2).
   */
  list(remotePath: string): Promise<FileEntry[]>;

  /**
   * Open an interactive session (for the terminal).
   *
   * **Asynchronous**: the `shell()` of SSH needs one round trip before the
   * channel arrives — a synchronous implementation can never get the
   * channel, so the SSH terminal would not come up.
   *
   * A pipe-mode session does not echo (the host is responsible for it), a
   * pty-mode session does (the remote side is responsible for it).
   */
  openSession(opts?: { cols?: number; rows?: number }): Promise<Session>;
}
