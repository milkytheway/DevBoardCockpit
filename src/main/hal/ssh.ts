import { StringDecoder } from 'node:string_decoder';
import { basename, join } from 'node:path';
import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2';
import { makeError } from '../../shared/errors';
import type { FileEntry } from '../../shared/ipc-contract';
import type { SessionLog } from '../logging/session-log';
import type { ConnectionProfile } from '../profiles/schema';
import { Session, TIMEOUT_EXIT_CODE } from './session';
import { capabilitiesFor, transportDefaults } from './capabilities';
import { readFileSync } from 'node:fs';
import type { ConnectionCapabilities, Connection, ExecOptions, ExecResult } from './connection';

/**
 * The SSH transport.
 *
 * **Fact H1**: it uses `ssh2` (on the Node side) and **not** an `ssh.exe`
 * script — a script cannot do password authentication.
 *
 * SSH is in pty mode: the remote side provides a real terminal, echoes by
 * itself and emits ANSI, so the host only forwards the keystrokes (see the
 * two terminal modes of the legacy behaviour).
 */

export function sshCapabilities(): ConnectionCapabilities {
  return transportDefaults('ssh');
}

/**
 * Read the private key file (**read it as content**).
 *
 * If it cannot be read → **raise an error** (not "connect without the
 * private key" → and then fail authentication for no apparent reason ✗).
 */
function readPrivateKey(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (err) {
    throw makeError('CONN_OPEN_FAILED', `读不了私钥文件 ${path}`, {
      detail: { path, cause: err instanceof Error ? err.message : String(err) },
    });
  }
}

export interface SshConnectOptions {
  host: string;
  port: number;
  username?: string;
  /** The private key (**content**, not a path — ssh2 wants the key itself ✓) */
  privateKey?: Buffer | string;
  password?: string;
}

/** Parse the connection parameters from the profile. A missing host raises an error right away — when the connection fails it has to name the host. */
export function sshArgs(profile: ConnectionProfile): SshConnectOptions {
  const host = profile.options['host'];
  if (typeof host !== 'string' || host.length === 0) {
    throw makeError('IPC_INVALID_PAYLOAD', "SSH 连接缺少 'host'", {
      detail: { source: profile.id, field: 'host' },
    });
  }
  const port = Number(profile.options['port'] ?? 22);
  const username = profile.options['username'];
  const keyFilename = profile.options['key_filename'];
  const password = profile.options['password'];

  return {
    host,
    port,
    ...(typeof username === 'string' ? { username } : {}),
    ...(typeof password === 'string' ? { password } : {}),
    // **The private key has to be read as content (Buffer), a path is not
    // enough** — the `privateKey` of ssh2 takes **the key itself**; given a
    // path it tries to parse the path as key content
    // → "Unsupported key format" (hit in a real-device test on 2026-11-15).
    ...(typeof keyFilename === 'string' ? { privateKey: readPrivateKey(keyFilename) } : {}),
  };
}

export interface SshConnectionOptions {
  /** Inject the ssh2 client, used by tests */
  clientFactory?: (opts: SshConnectOptions) => Client;
}

/**
 * One entry of an sftp readdir reply.
 *
 * The type ssh2 hands over is `FileEntryWithStats` (attrs always carries a
 * pile of methods), but a real server does not necessarily provide all of
 * them — here only the three fields we actually use are declared, and the
 * missing ones are treated as "unobtainable" instead of being faked.
 */
interface SftpDirEntry {
  filename: string;
  longname?: string;
  attrs?: {
    /** POSIX mode: the high bits are the file type bits */
    mode?: number;
    size?: number;
    /** **Seconds**, not milliseconds */
    mtime?: number;
  };
}

/**
 * One sftp entry → the `FileEntry` of the contract.
 *
 * **The sizeBytes of a directory is null** (what cannot be read is not 0 —
 * Fact G2): the 4096 that `ls -la` shows for a directory is the number of
 * blocks the file system allocated to it, not its "size", and showing it as
 * a file size is a lie.
 */
function toFileEntry(entry: SftpDirEntry, remotePath: string): FileEntry {
  const attrs = entry.attrs ?? {};
  const mode = typeof attrs.mode === 'number' ? attrs.mode : undefined;

  // Directory detection: the high bits of the POSIX mode are the file type
  // bits (0o170000), 0o040000 = directory. When the mode is unobtainable
  // (absent or 0 — 0 is not the mode of any legal file type) fall back to the
  // first character of longname, which is the notation of ls -l (d
  // directory / - file / l symlink).
  const isDirectory =
    mode !== undefined && mode > 0
      ? (mode & 0o170000) === 0o040000
      : (entry.longname ?? '').charAt(0) === 'd';

  // The mtime of sftp is in **seconds** (not milliseconds) — treating it as
  // milliseconds is off by a factor of a thousand.
  // An mtime of 0 means "the server gave no timestamp", not 1970: showing it
  // as 1970 is a lie, so it is reported as null, the "unobtainable" case
  // (the same principle as sizeBytes, Fact G2).
  const mtime = typeof attrs.mtime === 'number' && Number.isFinite(attrs.mtime) ? attrs.mtime : undefined;
  const modifiedAt = mtime !== undefined && mtime > 0 ? new Date(mtime * 1000).toISOString() : null;

  const size = typeof attrs.size === 'number' ? attrs.size : null;

  return {
    name: entry.filename,
    // Strip the trailing slash of remotePath before appending, so that it does not become `/root//a.txt`
    path: `${remotePath.replace(/\/+$/, '')}/${entry.filename}`,
    isDirectory,
    sizeBytes: isDirectory ? null : size,
    modifiedAt,
  };
}

export class SshConnection implements Connection {
  readonly id: string;
  readonly transport = 'ssh' as const;

  private client: Client | undefined;
  private readonly opts: SshConnectOptions;
  /** The most recent link error. Lets the layers above check the connection health */
  lastError: Error | undefined;

  constructor(
    private readonly profile: ConnectionProfile,
    private readonly log: SessionLog,
    private readonly options: SshConnectionOptions = {},
  ) {
    this.id = profile.id;
    this.opts = sshArgs(profile);
  }

  capabilities(): ConnectionCapabilities {
    // **profile aware** — not a transport constant (see the notes in `capabilities.ts`).
    return capabilitiesFor(this.profile);
  }

  async open(): Promise<void> {
    const client = this.options.clientFactory
      ? this.options.clientFactory(this.opts)
      : new Client();

    await new Promise<void>((resolve, reject) => {
      const onReady = (): void => {
        resolve();
      };
      const onError = (err: Error & { level?: string }): void => {
        // An error after the connection was established (the link dropped)
        // also has to be handled — an 'error' event without a listener turns
        // into an uncaught exception and takes the main process down.
        if (this.client) {
          this.lastError = err;
        } else {
          reject(
            makeError('CONN_OPEN_FAILED', `SSH 连不上 ${this.opts.host}:${this.opts.port}`, {
              detail: { host: this.opts.host, port: this.opts.port, cause: err.message, level: err.level },
            }),
          );
        }
      };
      client.once('ready', onReady);
      // A resident listener: it is not removed after the handshake
      client.on('error', onError);
      client.connect(this.opts);
    });

    this.client = client;
  }

  async close(): Promise<void> {
    this.client?.end();
    this.client = undefined;
  }

  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    if (!this.client) {
      throw makeError('CONN_CLOSED', 'SSH 连接未打开', { detail: { id: this.id } });
    }
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const startedAt = Date.now();

    return new Promise<ExecResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let stream: ClientChannel | undefined;

      // **Reassembly across chunks** (constraint G15 / risk RF-3):
      // a Chinese character may be split across two chunks, and
      // `Buffer.toString('utf8')` decodes each chunk independently — that
      // yields two U+FFFD and silently corrupts valid content. Serial
      // (serial.ts) and ADB (adb.ts) both use StringDecoder, so SSH has to
      // as well.
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');

      /** Settle once. Repeated calls have no effect — a timeout and a close may arrive at the same time */
      const settle = (code: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts?.signal?.removeEventListener('abort', onAbort);
        // Flush the tail: the tail of the last chunk may still be sitting in the decoder
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
        resolve({
          exitCode: timedOut ? TIMEOUT_EXIT_CODE : code,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
          timedOut,
          ...(cancelled ? { cancelled: true } : {}),
        });
      };

      /**
       * A timeout **closes only that one channel**, it does not tear down
       * the whole connection.
       *
       * This used to call `this.client.end()` — that closes **all** channels
       * of that client: the interactive terminal the user is using drops
       * immediately, while the connection is already dead and still treated
       * as "open" (`this.client` is not cleared), so every later command
       * goes to a dead connection.
       */
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          stream?.close();
        } catch {
          // The channel is already closed, never mind
        }
        // A timeout has to **settle by itself**: if the remote side does not
        // close the channel, this Promise never settles on the close event
        // alone and the caller hangs forever.
        settle(TIMEOUT_EXIT_CODE);
      }, timeoutMs);

      // ── Cancellation: **close that one channel** ──
      // → Same as the timeout (close only the channel, do not tear down the
      //   whole connection ✓ — otherwise the user's interactive terminal
      //   would drop immediately ✗)
      const onAbort = (): void => {
        if (settled) return;
        cancelled = true;
        try {
          stream?.close();
        } catch {
          // The channel is already closed, never mind
        }
        // **Settle by itself**: if the remote side does not close the channel, this Promise never settles ✗
        settle(null);
      };
      if (opts?.signal !== undefined) {
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      this.client!.exec(command, (err, ch) => {
        if (err) {
          clearTimeout(timer);
          opts?.signal?.removeEventListener('abort', onAbort);
          reject(makeError('CONN_OPEN_FAILED', `SSH 执行失败：${err.message}`, {
            detail: { host: this.opts.host, cause: err.message },
          }));
          return;
        }
        stream = ch;
        stream.on('data', (d: Buffer) => { stdout += stdoutDecoder.write(d); });
        stream.stderr.on('data', (d: Buffer) => { stderr += stderrDecoder.write(d); });
        stream.on('close', (code: number | null) => settle(code));
      });
    });
  }

  /**
   * Download: goes through ssh2's sftp.
   *
   * **Not** a remote `pull` command — the remote shell has no such command.
   */
  async pull(remotePath: string, localPath: string): Promise<void> {
    const sftp = await this.openSftp();
    try {
      await new Promise<void>((resolve, reject) => {
        sftp.fastGet(remotePath, localPath, (err) => {
          if (err) {
            reject(makeError('FILE_TRANSFER_FAILED', `下载失败：${remotePath}`, {
              detail: { remotePath, localPath, cause: err.message },
            }));
            return;
          }
          resolve();
        });
      });
    } finally {
      // It has to be closed on failure too — otherwise every failure leaks one sftp channel
      sftp.end();
    }
  }

  /**
   * Upload: goes through ssh2's sftp.
   *
   * `remotePath` is a **directory** (the unified semantics, see
   * `connection.ts`) — `fastPut` wants a full file path, so the basename is
   * appended here.
   */
  async push(localPath: string, remotePath: string): Promise<void> {
    const target = join(remotePath, basename(localPath));
    const sftp = await this.openSftp();
    try {
      await new Promise<void>((resolve, reject) => {
        sftp.fastPut(localPath, target, (err) => {
          if (err) {
            reject(makeError('FILE_TRANSFER_FAILED', `上传失败：${localPath}`, {
              detail: { localPath, remotePath, target, cause: err.message },
            }));
            return;
          }
          resolve();
        });
      });
    } finally {
      sftp.end();
    }
  }

  /**
   * List a remote directory.
   *
   * **It goes through the `sftp` of ssh2** (Task 9, Step 3 of the original
   * implementation plan: "adb uses `adb shell ls -la`, ssh uses the `sftp`
   * of ssh2") — **not** by running a remote `ls`.
   * That is the way of the adb line; SSH has an sftp channel here, so use it.
   */
  async list(remotePath: string): Promise<FileEntry[]> {
    const sftp = await this.openSftp();
    try {
      const entries = await new Promise<SftpDirEntry[]>((resolve, reject) => {
        sftp.readdir(remotePath, (err, list) => {
          if (err) {
            reject(makeError('FILE_TRANSFER_FAILED', `列目录失败：${remotePath}`, {
              detail: { remotePath, cause: err.message },
            }));
            return;
          }
          resolve(list);
        });
      });
      return entries.map((entry) => toFileEntry(entry, remotePath));
    } finally {
      // Close it when done (the same as pull / push). **It has to be closed
      // on failure too** — the sftp channel hangs off the connection, and one
      // leak keeps it occupied forever.
      sftp.end();
    }
  }

  /** Open one sftp channel */
  private openSftp(): Promise<SFTPWrapper> {
    return new Promise((resolve, reject) => {
      if (!this.client) {
        reject(makeError('CONN_CLOSED', 'SSH 连接未打开'));
        return;
      }
      this.client.sftp((err, sftp) => {
        if (err) {
          reject(makeError('FILE_TRANSFER_FAILED', `开 sftp 失败：${err.message}`, {
            detail: { host: this.opts.host, cause: err.message },
          }));
          return;
        }
        resolve(sftp);
      });
    });
  }

  async openSession(opts?: { cols?: number; rows?: number }): Promise<Session> {
    if (!this.client) {
      throw makeError('CONN_CLOSED', 'SSH 连接未打开', { detail: { id: this.id } });
    }
    // The shell() of ssh2 is **asynchronous**: the channel only arrives after
    // one round trip. Checking the channel synchronously is bound to yield
    // undefined — the SSH terminal would not come up.
    const channel = await this.openShell(opts?.cols ?? 80, opts?.rows ?? 24);
    return new SshSession(channel, this.log);
  }

  /** Open one shell channel */
  private openShell(cols: number, rows: number): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      this.client!.shell({ term: 'xterm-256color', cols, rows }, (err, ch) => {
        if (err) {
          reject(makeError('CONN_OPEN_FAILED', `SSH 开 shell 失败：${err.message}`, {
            detail: { host: this.opts.host, cause: err.message },
          }));
          return;
        }
        resolve(ch);
      });
    });
  }

}

/** The interactive session of SSH. The remote side echoes by itself and emits ANSI, the host only forwards the keystrokes */
class SshSession extends Session {
  /**
   * Reassemble multi-byte characters across chunks (constraint G15 / risk
   * RF-3).
   *
   * It hangs off the session instance — one decoder per session, otherwise
   * two terminals each receive their own bytes and cannot piece together one
   * complete character.
   */
  private readonly decoder = new StringDecoder('utf8');
  private readonly dataCbs: ((chunk: string) => void)[] = [];
  /** Only one data listener is attached to the channel: decoder.write may be called only once per chunk */
  private listening = false;

  constructor(
    private readonly channel: ClientChannel,
    log: SessionLog,
  ) {
    super(log);
  }

  readonly exitCode: number | null = null;

  write(data: string): void {
    this.channel.write(data);
  }

  onData(cb: (chunk: string) => void): void {
    this.dataCbs.push(cb);
    if (this.listening) return;
    this.listening = true;
    this.channel.on('data', (d: Buffer) => {
      const chunk = this.decoder.write(d);
      // An empty string = this chunk carried only half a character, wait for
      // the next one. Handing it out as is would turn the half character into
      // a U+FFFD.
      if (chunk.length === 0) return;
      for (const c of this.dataCbs) c(chunk);
    });
  }

  resize(cols: number, rows: number): void {
    this.channel.setWindow(rows, cols, 0, 0);
  }

  /**
   * The remote shell exited on its own → report it.
   *
   * Without it, after the user types `exit` the interface keeps the tab and
   * further typing goes into a **dead** channel — "the board went offline
   * and the interface does not know".
   */
  onExit(cb: (exitCode: number | null) => void): void {
    this.channel.on('close', (code: number | null) => cb(code));
  }

  close(): void {
    // Flush the tail: the remote side may have sent only half a character
    // before the link dropped, and that half character has to be shown as a
    // replacement character, it must not be dropped silently (losing half of
    // it makes the screen content easier to misjudge than showing a blank).
    const tail = this.decoder.end();
    if (tail.length > 0) {
      for (const c of this.dataCbs) c(tail);
    }
    this.channel.close();
  }
}
