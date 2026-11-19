import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { makeError } from '../../shared/errors';
import type { FileEntry } from '../../shared/ipc-contract';
import type { SessionLog } from '../logging/session-log';
import type { ConnectionProfile } from '../profiles/schema';
import { runProcess } from '../util/spawn';
import { quotePath } from '../util/shell-quote';
import { parseLsLines } from '../util/ls-output';
import { Session } from './session';
import { terminalEnvScript } from './session-env';
import type { ConnectionCapabilities, Connection, ExecOptions, ExecResult } from './connection';
import { capabilitiesFor, transportDefaults } from './capabilities';

/**
 * The ADB transport.
 *
 * The key facts:
 *
 * - **Fact A1**: **no PTY**. On Windows `adb shell -t -t` holds the reply
 *   back until the next command, which shows up as "lagging by one". So adb
 *   runs in pipe mode.
 * - **Fact A7**: `adb devices` may contain `offline` / `unauthorized`,
 *   **only `device` counts**.
 * - **Fact A8**: output is decoded as UTF-8 and bad bytes do not void the
 *   whole command (this is the job of `runProcess`).
 * - **Facts A2/A3**: at session start `export TERM=xterm-256color` and a
 *   shell function are used (see `session-env.ts`).
 *
 * The adb path comes from `hostTools.adb` in `profiles/settings.json` —
 * machine-specific paths only enter the configuration, never the code
 * (fact list §2).
 */

export function adbCapabilities(): ConnectionCapabilities {
  return transportDefaults('adb');
}

/**
 * The serial pinned in the profile.
 *
 * Not pinned (absent / empty string / not a string) means undefined —
 * "pinned to a specific board" and "connect to whatever is there" are two
 * different ways to connect, and their semantics must not be mixed.
 */
function profileSerial(profile: ConnectionProfile): string | undefined {
  const serial = profile.options['serial'];
  return typeof serial === 'string' && serial.length > 0 ? serial : undefined;
}

/** Build the argument array for adb. When a serial exists, `-s <serial>` is put in front. */
export function adbArgs(profile: ConnectionProfile, extra: string[]): string[] {
  const serial = profileSerial(profile);
  if (serial !== undefined) {
    return ['-s', serial, ...extra];
  }
  return [...extra];
}

/** One device record in the output of `adb devices` */
interface DeviceRow {
  /** The serial (first column) */
  serial: string;
  /** The first word of the state: device / offline / unauthorized / no … */
  state: string;
  /** The raw state text: things like `no permissions (user in plugdev group)` have to be kept in full */
  stateText: string;
}

/**
 * Parse the output of `adb devices`.
 *
 * Two kinds of **rows that are not device rows** are filtered out:
 * - the `List of devices attached` header;
 * - **daemon noise** such as `* daemon not running; starting now at tcp:5037`
 *   — it is not a device, and letting it into the states turns the error
 *   message into noise (the opposite of an operations black hole).
 */
function parseDeviceRows(stdout: string): DeviceRow[] {
  const rows: DeviceRow[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith('List of devices')) continue;
    if (line.startsWith('*')) continue;
    const parts = line.split(/\s+/);
    const serial = parts[0] ?? '';
    if (serial.length === 0) continue;
    const stateText = parts.slice(1).join(' ').trim();
    rows.push({ serial, state: parts[1] ?? '', stateText });
  }
  return rows;
}

export interface AdbConnectionOptions {
  /** Path of the adb executable. Defaults to 'adb' (found on PATH) */
  adbPath?: string;
  /** Entry point for running adb, a fake implementation for tests */
  runner?: typeof runProcess;
  /**
   * Entry point for spawning the child process, a fake implementation for
   * tests.
   *
   * **Why it is needed**: whether anyone listens for the `'error'` event of
   * `child.stdin` can only be measured by actually spawning a child process
   * that dies immediately — and "the board dropped off the link" is exactly
   * that path.
   */
  spawn?: typeof spawn;
}

export class AdbConnection implements Connection {
  readonly id: string;
  readonly transport = 'adb' as const;

  private readonly adbPath: string;
  private readonly runner: typeof runProcess;
  private readonly spawnFn: typeof spawn;
  private opened = false;

  constructor(
    private readonly profile: ConnectionProfile,
    private readonly log: SessionLog,
    opts: AdbConnectionOptions = {},
  ) {
    this.id = profile.id;
    this.adbPath = opts.adbPath ?? 'adb';
    this.runner = opts.runner ?? runProcess;
    this.spawnFn = opts.spawn ?? spawn;
  }

  capabilities(): ConnectionCapabilities {
    // **profile aware** — not a transport constant (see the notes in `capabilities.ts`).
    return capabilitiesFor(this.profile);
  }

  /**
   * Before opening, confirm that the board is in the `device` state.
   *
   * A vague "connection failed" is an operations black hole — the user
   * cannot tell whether the cable is **not plugged in**, the board is
   **not authorised**, or the board is **offline**. So the error message
   * carries the raw state string.
   *
   * **When the profile pins a serial, only that board is accepted**
   * (Fact A7): `adb devices` lists **all** devices (`-s` does not filter it),
   * so a criterion like "is any one of them a device" would let an
   * **offline** board through — the connection opens and every later command
   * fails on `adb -s <offline board>`, and **the failure is a million miles
   * away from the cause**. Here the match is exact, by serial.
   */
  async open(): Promise<void> {
    const result = await this.runner(this.adbPath, adbArgs(this.profile, ['devices']));
    const out = result.stdout;

    const rows = parseDeviceRows(out);
    const serial = profileSerial(this.profile);

    if (serial !== undefined) {
      // A board is pinned: accept only this row
      const row = rows.find((r) => r.serial === serial);
      if (!row) {
        const present = rows.map((r) => r.serial);
        const detail = present.length > 0 ? present.join(', ') : '(no device)';
        throw makeError(
          'CONN_OPEN_FAILED',
          `the serial pinned by the profile is not in the adb devices list: ${serial} (the current devices: ${detail})`,
          { detail: { serial, present, raw: out } },
        );
      }
      if (row.state !== 'device') {
        throw makeError(
          'CONN_OPEN_FAILED',
          `the device ${serial} pinned by the profile is in the state "${row.stateText}", not device`,
          { detail: { serial, state: row.state, stateText: row.stateText, raw: out } },
        );
      }
    } else {
      // No board is pinned: the old behaviour — at least one of them is in the device state
      const connected = rows.filter((r) => r.state === 'device');
      if (connected.length === 0) {
        const states = rows.map((r) => r.stateText);
        const detail = states.length > 0 ? states.join(', ') : '(no device)';
        throw makeError('CONN_OPEN_FAILED', `adb has no device in the device state: ${detail}`, {
          detail: { states, raw: out },
        });
      }
    }

    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    if (!this.opened) {
      throw makeError('CONN_CLOSED', 'the ADB connection is not open', { detail: { id: this.id } });
    }
    return this.runner(this.adbPath, adbArgs(this.profile, ['shell', command]), {
      timeoutMs: opts?.timeoutMs,
      ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
    });
  }

  /**
   * Download: goes through `adb pull`.
   *
   * **Not** a remote `pull` command — the board does not have that command.
   */
  async pull(remotePath: string, localPath: string): Promise<void> {
    const result = await this.runner(this.adbPath, adbArgs(this.profile, ['pull', remotePath, localPath]));
    if (result.exitCode !== 0) {
      throw makeError('FILE_TRANSFER_FAILED', `download failed: ${remotePath}`, {
        detail: { remotePath, localPath, stderr: result.stderr },
      });
    }
  }

  /** Upload: goes through `adb push` */
  async push(localPath: string, remotePath: string): Promise<void> {
    const result = await this.runner(this.adbPath, adbArgs(this.profile, ['push', localPath, remotePath]));
    if (result.exitCode !== 0) {
      throw makeError('FILE_TRANSFER_FAILED', `upload failed: ${localPath}`, {
        detail: { localPath, remotePath, stderr: result.stderr },
      });
    }
  }

  /**
   * List a remote directory: goes through `adb shell ls -la <path>`
   * (Task 9, Step 3 of the original implementation plan).
   *
   * **Listing a directory is a capability of the connection layer**, at the
   * same level as `pull`/`push` — the file transfer service must not know
   * "what the remote command of adb looks like", otherwise every new
   * transport means one more change to the service layer.
   *
   * The `sizeBytes` of a directory is `null` (Fact G2): **what cannot be read
   * is not 0**. What `ls -la` reports for a directory is the inode block
   * count (4096), which is not the size of the directory; reporting it to the
   * user as a byte count is false data.
   */
  async list(remotePath: string): Promise<FileEntry[]> {
    const result = await this.exec(`ls -la ${quotePath(remotePath)}`);
    if (result.exitCode !== 0) {
      throw makeError('FILE_TRANSFER_FAILED', `listing the directory failed: ${remotePath}`, {
        detail: { remotePath, stderr: result.stderr },
      });
    }
    // Strip the trailing `/` before appending the name: '/root/' + 'a.txt' must not become '/root//a.txt'
    const base = remotePath.replace(/\/+$/, '');
    return parseLsLines(result.stdout).map((e) => ({
      name: e.name,
      path: `${base}/${e.name}`,
      isDirectory: e.type === 'd',
      sizeBytes: e.type === 'd' ? null : e.size,
      modifiedAt: e.modifiedAt,
    }));
  }

  async openSession(_opts?: { cols?: number; rows?: number }): Promise<Session> {
    if (!this.opened) {
      throw makeError('CONN_CLOSED', 'the ADB connection is not open', { detail: { id: this.id } });
    }
    return new AdbSession(this, this.log);
  }

  /**
   * Open a resident `adb shell`.
   *
   * **No PTY** (Fact A1: on Windows `adb shell -t -t` lags by one).
   */
  spawnShell(): ChildProcessWithoutNullStreams {
    const args = adbArgs(this.profile, ['shell']);
    const child = this.spawnFn(this.adbPath, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    child.on('error', (err) => {
      console.error(`[adb shell] ${err.message}`);
    });
    // **stdin must also handle 'error'**.
    // Writing to an already closed pipe yields EPIPE/ECONNRESET, and a
    // stream's 'error' event **without a listener turns into an uncaught
    // exception** — not a crashed terminal window, but **the whole Electron
    // main process going down**.
    //
    // The trigger path is realistic: after the `adb devices` check passes,
    // the board drops off the link or the serial does not match, and the
    // write of the session environment script in the constructor lands on a
    // pipe that is about to die.
    // (The serial line has `port.on('error')`, the SSH line has
    //   `client.on('error')`; only ADB's stdin is bare.)
    child.stdin.on('error', (err: Error) => {
      console.error(`[adb shell stdin] ${err.message}`);
    });
    return child;
  }
}

/**
 * The interactive session of ADB.
 *
 * **One resident `adb shell` child process**, not one spawn per keystroke:
 * spawning adb on every keystroke drags the board's CPU down (Fact A5: one
 * round trip ≈30ms), and none of the board's output would be received.
 *
 * adb is in pipe mode: the board **does not echo** and does not emit ANSI,
 * so the prompt and the echo are both the host's responsibility (legacy
 * behaviour, a corollary of Fact A1).
 *
 * `terminalEnvScript()` is executed once when the session is established —
 * otherwise `TERM` is still `dumb` (Fact A2, coreutils refuses to
 * colorize) and `ls` is still not a multi-column colored shell function
 * (Fact A3).
 */
class AdbSession extends Session {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly dataCbs: ((chunk: string) => void)[] = [];
  /**
   * **One decoder each** for stdout and stderr.
   *
   * Sharing one would mangle a multi-byte character that is split across the
   * two streams (the first half from stdout + the second half from stderr =
   * one garbled character).
   */
  private readonly stdoutDecoder = new StringDecoder('utf8');
  private readonly stderrDecoder = new StringDecoder('utf8');

  constructor(
    conn: AdbConnection,
    log: SessionLog,
  ) {
    super(log);
    this.child = conn.spawnShell();

    this.child.stdout.on('data', (buf: Buffer) => {
      const chunk = this.stdoutDecoder.write(buf);
      if (chunk.length === 0) return;
      for (const cb of this.dataCbs) cb(chunk);
    });
    this.child.stderr.on('data', (buf: Buffer) => {
      const chunk = this.stderrDecoder.write(buf);
      if (chunk.length === 0) return;
      for (const cb of this.dataCbs) cb(chunk);
    });

    // The session environment: TERM and the shell function for ls (Facts
    // A2/A3).
    //
    // **Write it verbatim, do not append `\r\n` again.**
    // The script itself already ends with `\n`; appending one more `\r` makes
    // that stray CR be executed by the remote shell as **a command of its
    // own** — measured on a real board (2026-11-13, the shell of the board
    // is bash):
    //
    // ```
    // root@ATK-DLRK3588/bin/bash: line 3: $'\r': command not found
    // ```
    //
    // The serial line needs a CR (getty expects CR, Fact S4), but ADB is in
    // pipe mode: the remote side reads **lines**, and the end of a line is
    // LF.
    this.child.stdin.write(terminalEnvScript());
  }

  readonly exitCode: number | null = null;

  write(data: string): void {
    // Pipe mode: the board does not echo, the host is responsible for the echo
    this.child.stdin.write(data);
    this.record(data);
  }

  onData(cb: (chunk: string) => void): void {
    this.dataCbs.push(cb);
  }

  /**
   * The adb shell exited → report it.
   *
   * Unplugging the cable, adbd restarting and the user typing `exit` all end
   * up here. Without it, the interface keeps the tab and the user keeps
   * typing into a dead channel.
   */
  onExit(cb: (exitCode: number | null) => void): void {
    this.child.on('exit', (code: number | null) => cb(code));
  }

  resize(_cols: number, _rows: number): void {
    // adb shell has no concept of a window size
  }

  close(): void {
    this.child.kill();
  }
}
