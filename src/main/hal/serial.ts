import { StringDecoder } from 'node:string_decoder';
import { SerialPort } from 'serialport';
import { makeError } from '../../shared/errors';
import type { SessionLog } from '../logging/session-log';
import type { ConnectionProfile } from '../profiles/schema';
import { buildMarker, extractMarkerOutput, Session, TIMEOUT_EXIT_CODE } from './session';
import { capabilitiesFor, transportDefaults } from './capabilities';
import type { ConnectionCapabilities, Connection, ExecResult, FileEntry, ExecOptions } from './connection';

/**
 * The serial transport.
 *
 * Three hard facts about serial (`docs/02-device-facts.md`):
 *
 * - **S1 single channel**: the command channel and the interactive terminal
 *   share one wire, one reader thread and one transcript.
 * - **S5 no exit code**: a textual reply = 0, a timeout = 124.
 * - **S7 cannot carry files**: `capabilities()` does not contain `files`, and
 *   the UI disables the file browser accordingly.
 *
 * Two more: **S2** the board echoes commands, so a marker appears twice in
 * the transcript; **S4** getty expects CR, so on send `\n` → `\r\n`.
 */

/**
 * Serial is a **console**: a real terminal that echoes by itself and prints
 * its own prompt.
 *
 * This is not my judgement, three sources agree:
 * - the legacy architecture notes: "A target that runs a real terminal --
 *   `ssh`, **or a serial console** -- gives the user a prompt, an echo and
 *   line editing"
 * - this repository's own `profiles/targets/board-serial.json` says
 *   `"pty": true`
 * - Fact S2 says the board **echoes** commands — echoing is the behaviour of
 *   a real terminal
 *
 * The capability table of the plan wrote serial as `pty: false`, which
 * conflicts with those three; the plan was wrong. Serial cannot carry files
 * (Fact S7) and cannot obtain an exit code (Fact S5) — those two stay.
 */
export function serialCapabilities(): ConnectionCapabilities {
  return transportDefaults('serial');
}

/**
 * The minimal abstraction of a serial port — only to make it testable; the
 * real implementation wraps serialport.
 *
 * `close` is **asynchronous**: serialport's `close()` only finishes once the
 * `close` event arrives, and returning synchronously would produce "it
 * reports an error right after it closed".
 */
export interface SerialPortLike {
  write(data: string): void;
  onData(cb: (chunk: string) => void): void;
  /** Notification when the layer below fails (cable unplugged, driver anomaly) */
  onError(cb: (err: Error) => void): void;
  close(): Promise<void>;
}

/**
 * Open a serial port. **The port must really be opened** —
 * `new SerialPort({autoOpen: false})` only constructs the object; a later
 * write then throws because "the port is not open", and nobody listens to
 * that error → the main process crashes.
 */
export type SerialPortFactory = (opts: { path: string; baudRate: number }) => Promise<SerialPortLike>;

const DEFAULT_TIMEOUT_MS = 30_000;

/** The real implementation: serialport's SerialPort adapted to SerialPortLike */
/**
 * The real serial port factory.
 *
 * **It is exported so that it can be tested.** The previous implementation
 * was private to the module, so the question "did the port actually open"
 * is **now guarded by a test** — delete `await port.open()` and
 * `tests/unit/serial-real-factory.test.ts` turns red immediately (mutation
 * guard M40). And that is exactly the C1 of the whole review: with the port
 * not open, the main process crashes on the user's first keystroke.
 */
export const realPortFactory: SerialPortFactory = async ({ path, baudRate }) => {
  const port = new SerialPort({ path, baudRate, autoOpen: false });
  // Bad bytes do not void the whole command (Fact A8) — a StringDecoder
  // reassembles across chunks, otherwise a multi-byte character split across
  // two chunks becomes two U+FFFD.
  const decoder = new StringDecoder('utf8');
  const listeners: ((chunk: string) => void)[] = [];
  const errorListeners: ((err: Error) => void)[] = [];

  port.on('data', (buf: Buffer) => {
    const chunk = decoder.write(buf);
    if (chunk.length === 0) return;
    for (const cb of listeners) cb(chunk);
  });
  port.on('error', (err: Error) => {
    for (const cb of errorListeners) cb(err);
  });

  await port.open();

  return {
    write(data: string) {
      port.write(data);
    },
    onData(cb: (chunk: string) => void) {
      listeners.push(cb);
    },
    onError(cb: (err: Error) => void) {
      errorListeners.push(cb);
    },
    async close() {
      if (!port.isOpen) return;
      await new Promise<void>((resolve) => {
        port.close(() => resolve());
      });
    },
  };
};

export class SerialConnection implements Connection {
  readonly id: string;
  readonly transport = 'serial' as const;

  private port: SerialPortLike | undefined;
  /** The most recent port-level error (cable unplugged, driver anomaly). Lets the layers above check the connection health */
  lastError: Error | undefined;
  /**
   * The reply buffer of this exec. `undefined` = no command is running at the
   * moment.
   *
   * **Why it is "this one" and not "one shared transcript"**:
   * it used `transcript.length` as an absolute index and claimed with
   * `slice(from)`. But the transcript is trimmed (64 KB cap), and once an
   * index goes stale it can never be claimed back — after a large output
   * (`cat` of a big file, `ls -la` of a big directory), **the exec channel of
   * this connection is dead for good**.
   *
   * Changed to "every exec uses its own buffer, holding only the data that
   * arrives after the command was sent", so **there is no such thing as an
   * index** any more: the buffer naturally holds only the reply of this
   * command.
   */
  private execBuffer: string | undefined;
  /**
   * Round-trip mutual exclusion (contract `spec/02` §1.2.1 + Fact S1).
   *
   * Serial has one wire and one reader thread. The command channel and the
   * interactive terminal **share one wire** — so only one round trip at a
   * time is possible on the same connection.
   *
   * This lock used to block only exec↔exec: while an interactive session was
   * open, any exec would **append the command after the input the user had
   * not finished typing** (the shell on the board receives
   * `ls -l /tmpuptime; echo marker`).
   */
  private busy = false;

  constructor(
    private readonly profile: ConnectionProfile,
    private readonly log: SessionLog,
    private readonly portFactory: SerialPortFactory = realPortFactory,
  ) {
    this.id = profile.id;
  }

  capabilities(): ConnectionCapabilities {
    // **profile aware** — not a transport constant (see the notes in `capabilities.ts`).
    return capabilitiesFor(this.profile);
  }

  async open(): Promise<void> {
    const port = this.profile.options['port'];
    const baudRate = Number(this.profile.options['baudrate'] ?? 115200);

    // A repeated open overwrites `this.port`, and **the previous port handle
    // leaks**. Close the old one first.
    if (this.port) {
      await this.port.close();
      this.port = undefined;
    }

    try {
      this.port = await this.portFactory({ path: String(port), baudRate });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string } | undefined)?.code;
      const busy = code === 'EBUSY' || /busy|denied/i.test(message);
      if (busy) {
        // RF-5: name the port that is busy instead of a vague "open failed"
        throw makeError('PORT_BUSY', `serial port ${String(port)} is busy`, {
          detail: { port: String(port) },
        });
      }
      throw makeError('CONN_OPEN_FAILED', `cannot open serial port ${String(port)}`, {
        detail: { port: String(port), cause: message },
      });
    }

    this.port.onData((chunk) => {
      // Only feed the buffer of "this command". The buffer is cleared before
      // the command is sent, so it naturally holds only the reply of this
      // command — no index needed.
      if (this.execBuffer !== undefined) this.execBuffer += chunk;
    });

    // A port-level error (cable unplugged, driver anomaly) has to go
    // somewhere — an 'error' event without a listener turns into an
    // uncaught exception and takes the main process down.
    this.port.onError((err) => {
      this.lastError = err;
    });
  }

  async close(): Promise<void> {
    await this.port?.close();
    this.port = undefined;
    this.execBuffer = undefined;
    this.busy = false;
  }

  /**
   * Run a command.
   *
   * It follows the marker protocol: send the command → claim the reply in
   * the transcript. **A textual reply = 0; a timeout = 124** (Fact S5) —
   * serial cannot obtain an exit status.
   */
  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    if (!this.port) {
      throw makeError('CONN_CLOSED', 'the serial port is not open', { detail: { id: this.id } });
    }
    if (this.busy) {
      // Concurrent round trips on the same connection = crosstalk. Better to
      // reject than to let two commands claim each other's output.
      // **It is not a timeout, it is a "rejection"**: the two must not share
      // a code — the UI cannot tell "waited long and got nothing" from
      // "this line is busy".
      throw makeError('CONN_BUSY', 'a command is still running on this connection', {
        detail: { id: this.id, command },
      });
    }
    this.busy = true;
    try {
      return await this.execLocked(command, opts);
    } finally {
      this.busy = false;
    }
  }

  private async execLocked(command: string, opts?: ExecOptions): Promise<ExecResult> {

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();
    const marker = buildMarker(process.pid, Date.now());

    // The reply buffer of this command: clear it, then send the command, so
    // the buffer holds only "the data that arrived after the command was
    // sent".
    this.execBuffer = '';
    try {
      // **The one-line protocol** (Fact S2).
      //
      // The board **echoes commands**, so the same marker appears **twice**
      // in the reply:
      //   the first = on the echoed line (`command; echo marker` is echoed
      //     back)
      //   the second = printed by echo after the command has run
      // The content between the two is the output of the command.
      //
      // If the marker is sent on a line of its own, the board first runs
      // `marker` as a command (sh: marker: not found) and the output is
      // completely wrong.
      //
      // Fact S4: getty expects CR, sending only \n may not produce a newline
      this.port?.write(`${command}; echo ${marker}\r\n`);

      const output = await this.waitForMarker(marker, timeoutMs, opts?.signal);
      const timedOut = output === undefined;
      // **Cancellation** and **timeout** are kept apart ✓ (serial has no exit code ✓, only a flag can tell them apart ✓)
      const cancelled = output === undefined && opts?.signal?.aborted === true;

      const portName = this.profile.options['port'];
      return {
        exitCode: timedOut ? TIMEOUT_EXIT_CODE : 0,
        stdout: timedOut ? '' : output,
        stderr: '',
        durationMs: Date.now() - startedAt,
        timedOut: timedOut && !cancelled,
        ...(cancelled ? { cancelled: true } : {}),
        // The **prime suspect** for a timeout is "the reply was eaten by
        // another program", not "the board is slow".
        //
        // This really happened on a real board (2026-11-13): the
        // `serial-server.py` left behind by the Plan 1 acceptance run on the
        // host **opened COM3 exclusively** — the board was alive, the serial
        // line was fine, but **the reply was eaten by it**, so the
        // application's own exec waited forever. Without saying so, people
        // go looking in the "is the board dead" direction.
        ...(timedOut && !cancelled
          ? {
              hint:
                `one round trip on serial port ${String(portName)} timed out. ` +
                '**the most common reason is that another program swallowed the reply**' +
                '(for example the serial-server.py left by the Plan 1 acceptance run holds this port exclusively) — ' +
                `first make sure ${String(portName)} is not held by another program.`,
            }
          : {}),
      };
    } finally {
      this.execBuffer = undefined;
    }
  }

  /** Serial cannot carry files (Fact S7) */
  async list(_remotePath: string): Promise<FileEntry[]> {
    throw makeError('FILE_TRANSFER_FAILED', 'serial cannot carry files');
  }

  /** Serial cannot carry files (Fact S7) */
  async pull(_remotePath: string, _localPath: string): Promise<void> {
    throw makeError('FILE_TRANSFER_FAILED', 'serial cannot carry files');
  }

  /** Serial cannot carry files (Fact S7) */
  async push(_localPath: string, _remotePath: string): Promise<void> {
    throw makeError('FILE_TRANSFER_FAILED', 'serial cannot carry files');
  }

  async openSession(_opts?: { cols?: number; rows?: number }): Promise<Session> {
    if (!this.port) {
      throw makeError('CONN_CLOSED', 'the serial port is not open', { detail: { id: this.id } });
    }
    if (this.busy) {
      // There is already a round trip on this wire (Fact S1: the command
      // channel and the interactive terminal share one wire). Better to reject
      // than to append the command after the input the user has not finished
      // typing.
      throw makeError('CONN_BUSY', 'a command is already running on this connection', {
        detail: { id: this.id },
      });
    }
    // The interactive session holds the line until it closes
    this.busy = true;
    return new SerialSession(this.port, this.log, () => {
      this.busy = false;
    });
  }

  /** Wait for the marker to appear a second time. Returns the output text; undefined on timeout */
  private waitForMarker(
    marker: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const check = (): void => {
        const chunk = this.execBuffer ?? '';
        // The marker has to appear twice to count as complete (echoed once by the board + once after the output)
        if (chunk.split(marker).length - 1 >= 2) {
          resolve(extractMarkerOutput(chunk, marker));
          return;
        }
        // **It was cancelled → give up explicitly** ✓ (the "abandon waiting
        // for this marker" of contract §5.2 ✓)
        // → On serial there is **no way to kill the remote process** ✓ (it is
        //   not a shell connection ✗)
        // → At least **the host stops waiting** ✓ (the vanguard's real-device
        //   test: it ran to completion after being cancelled ✗ — precisely
        //   because the host was still waiting ✗)
        if (signal?.aborted === true) {
          resolve(undefined);
          return;
        }
        if (Date.now() > deadline) {
          resolve(undefined);
          return;
        }
        setTimeout(check, 20);
      };
      check();
    });
  }
}

/**
 * The interactive session of serial.
 *
 * **The port belongs to the connection; the session does not close it** —
 * closing the session is the job of the connection (`connection.close()`).
 * The session only releases the "round-trip mutual exclusion" lock.
 */
class SerialSession extends Session {
  constructor(
    private readonly port: SerialPortLike,
    log: SessionLog,
    /** The callback when the session closes. It releases the round-trip mutual exclusion lock of the connection */
    private readonly onClose: () => void,
  ) {
    super(log);
  }

  /** Serial cannot obtain an exit code (Fact S5) */
  readonly exitCode: number | null = null;

  write(data: string): void {
    this.port.write(data);
    this.record(data);
  }

  onData(cb: (chunk: string) => void): void {
    this.port.onData(cb);
  }

  resize(_cols: number, _rows: number): void {
    // Serial has no concept of a window size
  }

  close(): void {
    this.onClose();
  }
}

