import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The session log.
 *
 * Legacy project fact G4: a crash, a restart or closing the window must
 * never lose records — every line is written to disk and flushed, the ANSI
 * codes are stripped, and the path is
 * `%LOCALAPPDATA%/<App>/logs/<date>/<label>-<HHMMSS>.log`.
 *
 * The writes here are synchronous (`appendFileSync`): opening and closing
 * the file for every write is itself a "flush per line", so the lines that
 * were written before the process was killed are not lost. Asynchronous
 * writes would have to deal with backpressure and with when to flush, which
 * is not worth it for a session log of a few lines per second.
 *
 * ── The format comes from the legacy project ──
 *
 * The golden sample `fixtures/session-log/serial-session.log` was produced
 * by the legacy project's `SessionLog`
 * (`DevBoardConsole/devboard_console/core/session_log.py`). So the format
 * is not guessed, it has a source:
 *
 * ```
 * [02:15:07.054] === session opened 2026-11-12 02:15:07 target=<label> · serial transport=serial ===
 * [02:15:07.054] --- connected <label> · serial ---
 * [02:15:10.071] drwxr-xr-x   3 root root 4.0K Aug 27  2026 data/
 * ...
 * [02:19:47.165] --- disconnected ---
 * [02:19:47.206] --- stream-ended ---
 * === session closed 2026-11-12 02:20:10 ===
 * ```
 *
 * Four rules:
 * 1. Every line carries the `[HH:mm:ss.SSS]` prefix (a multi-line chunk is
 *    prefixed line by line — the legacy project wrote line by line after
 *    `split("\n")`; without prefixing line by line, the second line would
 *    have no prefix).
 * 2. The session open/close lines and the event lines:
 *    `=== session opened ... ===`, `--- connected ... ---`,
 *    `=== session closed ... ===`. Note that the closing line carries no
 *    timestamp — the legacy project wrote it straight to the handle.
 * 3. All ANSI is stripped, including `ESC[?25l` (hide cursor) and OSC
 *    sequences.
 * 4. `\r\n` / `\r` are normalised to `\n` — the serial console ends its
 *    lines with CR.
 */

export interface SessionLogOptions {
  /** Goes into the file name, e.g. 'board-serial' */
  label: string;
  /** An absolute path; the tests pass a temporary directory */
  dataDir: string;
  /** The kind of transport. Written into the "session opened" line (the legacy project wrote it too) */
  transport?: string;
  /** An injected clock, `() => new Date()` by default. The tests use a fixed time so that the file name is predictable */
  now?: () => Date;
}

/**
 * Removes ANSI escape sequences.
 *
 * It covers three forms (the scope of the legacy project's `ANSI_RE`):
 * - CSI: `ESC [ <params> <intermediate bytes> <final byte>`, the params may
 *   contain `?` (private)
 * - OSC: `ESC ] ... BEL` (window title)
 * - A single character: `ESC <letter>` (for example `ESC c`)
 *
 * The legacy implementation only recognised `ESC[` plus digits and missed
 * `ESC[?25l` (hide cursor) and OSC — half an escape code was left in the
 * log.
 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
  /**
   * An OSC sequence: `ESC ] <content> <terminator>`.
   *
   * There are two terminators: BEL (`\x07`) and ST (`ESC \`).
   * xterm and most modern shells use ST for OSC 0/2 (window title) and OSC 8
   * (hyperlink) — recognising BEL only would leave half a sequence such as
   * `0;titletext` in the log.
   */
  // eslint-disable-next-line no-control-regex
  const OSC = /\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)/g;
  // eslint-disable-next-line no-control-regex
  const CH = /\x1b[@-Z\\-_]/g;
  return s.replace(CSI, '').replace(OSC, '').replace(CH, '');
}

/** The timestamp prefix `[HH:mm:ss.SSS]` (local time) */
export function formatTimestamp(at: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}` +
    `.${pad(at.getMilliseconds(), 3)}`
  );
}

/** '<label>-<HHMMSS>.log' */
export function logFileName(label: string, at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const hhmm = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${label}-${hhmm}.log`;
}

/** The characters that are unsafe in a file name (the scope of the legacy project's `_SANITIZE`) */
function safeName(label: string): string {
  const cleaned = label.replace(/[\\/:*?"<>|]+/g, '-').trim().replace(/^-+|-+$/g, '');
  return cleaned || 'session';
}

/** 'YYYY-MM-DD HH:MM:SS' (the time format of the legacy project's event lines) */
function eventStamp(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  );
}

export class SessionLog {
  readonly filePath: string;

  constructor(private readonly opts: SessionLogOptions) {
    const at = this.now();
    const dateDir = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
    const dir = join(opts.dataDir, 'logs', dateDir);
    mkdirSync(dir, { recursive: true });

    // Two sessions that start within the same second must not collide on
    // the name — a collision makes the second one append to the log of the
    // first, and afterwards the two conversations cannot be told apart.
    //
    // The file name is `<label>-<HHMMSS>.log` (the shape defined by
    // `logFileName`). This used to be `logFileName('', at).slice(0, 6)` —
    // the empty label brings an extra hyphen, and slicing 6 characters off
    // cuts one digit too few, so the 09:05:03 session landed as
    // `t--09050.log`.
    const stem = logFileName(safeName(opts.label), at).replace(/\.log$/, '');
    let path = join(dir, `${stem}.log`);
    let counter = 1;
    while (existsSync(path)) {
      path = join(dir, `${stem}-${counter}.log`);
      counter += 1;
    }
    this.filePath = path;

    // The opening line: isomorphic with the legacy project (which wrote it
    // in open())
    const transport = opts.transport ?? 'unknown';
    this.write(
      `=== session opened ${eventStamp(at)} target=${opts.label} transport=${transport} ===`,
    );
  }

  /**
   * Writes one line: strip ANSI → split it by line → timestamp every line →
   * append to the file.
   *
   * Splitting by line is mandatory: one reply from the remote side is often
   * several lines, and without a prefix per line the second line onwards
   * would have no timestamp — while in the golden sample every single line
   * has one.
   */
  write(line: string): void {
    const stamp = formatTimestamp(this.now());
    const text = stripAnsi(line).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (const raw of text.replace(/\n+$/, '').split('\n')) {
      appendFileSync(this.filePath, `[${stamp}] ${raw}\n`);
    }
  }

  /**
   * Records an event (connection, stream drop, ...).
   *
   * The legacy project called it `write_event`, and the format is
   * `--- <kind> [<detail>] ---`.
   */
  writeEvent(kind: string, detail = ''): void {
    this.write(`--- ${kind}${detail ? ` ${detail}` : ''} ---`);
  }

  /**
   * The closing.
   *
   * The closing line carries no timestamp — the legacy project wrote it
   * straight to the handle, and the last line of the golden sample is the
   * same (`=== session closed ... ===`).
   */
  close(): void {
    appendFileSync(this.filePath, `=== session closed ${eventStamp(this.now())} ===\n`);
  }

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }
}
