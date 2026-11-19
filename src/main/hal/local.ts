import { copyFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { makeError } from '../../shared/errors';
import type { SessionLog } from '../logging/session-log';
import type { ConnectionProfile } from '../profiles/schema';
import { runProcess } from '../util/spawn';
import { Session } from './session';
import { createLocalPtySession } from '../terminal/pty';
import { capabilitiesFor, transportDefaults } from './capabilities';
import type { ConnectionCapabilities, Connection, ExecOptions, ExecResult, FileEntry } from './connection';

/**
 * The local transport.
 *
 * The host machine is itself a "target" — the old project kept it as the
 * reference implementation (`core/local_target.py`: the host machine, as a
 * target). With it, the code paths for the terminal and for file transfer
 * can be tested locally, without attaching a real board.
 */

export function localCapabilities(): ConnectionCapabilities {
  return transportDefaults('local');
}

export interface LocalConnectionOptions {
  /** Entry point for running commands, used by tests */
  runner?: typeof runProcess;
}

export class LocalConnection implements Connection {
  readonly id: string;
  readonly transport = 'local' as const;

  private readonly runner: typeof runProcess;
  private opened = false;

  constructor(
    private readonly profile: ConnectionProfile,
    private readonly log: SessionLog,
    opts: LocalConnectionOptions = {},
  ) {
    this.id = profile.id;
    this.runner = opts.runner ?? runProcess;
  }

  capabilities(): ConnectionCapabilities {
    // **profile aware** — not a transport constant (see the notes in `capabilities.ts`).
    return capabilitiesFor(this.profile);
  }

  async open(): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    if (!this.opened) {
      throw makeError('CONN_CLOSED', 'the local connection is not open', { detail: { id: this.id } });
    }
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const args = process.platform === 'win32' ? ['/c', command] : ['-c', command];
    return this.runner(shell, args, {
      timeoutMs: opts?.timeoutMs,
      ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
    });
  }

  /**
   * List a directory: **read it with fs, not with `ls -la`**.
   *
   * The exec of the local transport goes through cmd.exe (Windows) or
   * `/bin/sh` (everything else), and `ls -la` is a POSIX command — on cmd.exe
   * it does not exist at all, so the file tree of the local connection
   * **would always be empty**.
   *
   * Task 9 of the original implementation plan says "adb uses
   * `adb shell ls -la`, ssh uses sftp" — the local transport of course uses
   * its own filesystem.
   */
  async list(remotePath: string): Promise<FileEntry[]> {
    // The root directory maps to the **current working directory**.
    //
    // The default remote path of the file browser is '/' (the root on the
    // board), but on Windows '/' is not a directory — `readdir('/')` is bound
    // to fail, so the file tree of the local connection would always be
    // empty. The local "target" has no root in the sense of a board, so
    // using the working directory as the root is the most natural choice.
    const dir = remotePath === '/' || remotePath.length === 0 ? process.cwd() : remotePath;
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      throw makeError('FILE_TRANSFER_FAILED', `listing the directory failed: ${remotePath}`, {
        detail: { remotePath, resolved: dir, cause: err instanceof Error ? err.message : String(err) },
      });
    }

    const out: FileEntry[] = [];
    for (const dirent of dirents) {
      // Build the path from the **resolved** directory: the root maps to
      // cwd, and a path built from the unresolved remotePath is the drive
      // root on Windows, which does not exist — the download would fail with
      // ENOENT right away.
      const path = join(dir, dirent.name);
      let isDirectory = dirent.isDirectory();
      let sizeBytes: number | null = null;
      let modifiedAt: string | null = null;
      try {
        // stat follows symlinks — so isDirectory is correct when a symlink points at a directory
        const st = await stat(path);
        isDirectory = st.isDirectory();
        // **The size of a directory is not 0, it is unknown** (Fact G2: what cannot be read is not 0)
        if (!isDirectory) sizeBytes = st.size;
        modifiedAt = st.mtime.toISOString();
      } catch {
        // If it cannot be read, leave it null. The entry itself is still useful.
      }
      out.push({ name: dirent.name, path, isDirectory, sizeBytes, modifiedAt });
    }
    return out;
  }

  /** Download: read straight from the host filesystem */
  async pull(remotePath: string, localPath: string): Promise<void> {
    try {
      await copyFile(remotePath, localPath);
    } catch (err) {
      throw makeError('FILE_TRANSFER_FAILED', `download failed: ${remotePath}`, {
        detail: { remotePath, localPath, cause: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  /**
   * Upload: write straight to the host filesystem.
   *
   * `remotePath` is a **directory** (the unified semantics, see
   * `connection.ts`) — `copyFile` wants a full file path, so the basename is
   * appended here.
   */
  async push(localPath: string, remotePath: string): Promise<void> {
    const target = join(remotePath, basename(localPath));
    try {
      await copyFile(localPath, target);
    } catch (err) {
      throw makeError('FILE_TRANSFER_FAILED', `upload failed: ${localPath}`, {
        detail: { localPath, remotePath, target, cause: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  async openSession(opts?: { cols?: number; rows?: number }): Promise<Session> {
    if (!this.opened) {
      throw makeError('CONN_CLOSED', 'the local connection is not open', { detail: { id: this.id } });
    }
    // A real pty (node-pty) — not the stub that only records logs
    return createLocalPtySession(this.log, { cols: opts?.cols ?? 80, rows: opts?.rows ?? 24 });
  }
}

