import type { SessionLog } from '../logging/session-log';

/**
 * Session base class and the marker protocol.
 *
 * The **marker protocol** is the lifeline of serial (Facts S1–S3): a serial
 * line has one wire, one reader thread and one transcript; commands claim
 * their own reply by marker. The board **echoes** commands, so the same
 * marker appears **twice** in the transcript (once on the echo line, once
 * after the output) — take the content between "the newline after the first
 * occurrence" and "the second occurrence".
 *
 * Marker format: `__DBC<pid>_<millisecond timestamp>__`, unique every time
 * (Fact S3), and it has to be stripped from the transcript before the output
 * is handed to the user.
 */

/** The timeout code shared by the whole project (Fact G1): the transports time out differently, so everything is normalised to 124 */
export const TIMEOUT_EXIT_CODE = 124;

/** Build the unique marker of this command */
export function buildMarker(pid: number, atMs: number): string {
  return `__DBC${pid}_${atMs}__`;
}

/**
 * Claim the command output that belongs to a marker in the transcript.
 *
 * - The marker appears twice (the board echoes): take what is between the
 *   first occurrence and the second
 * - The marker appears only once (the board does not echo): take everything
 *   after the first occurrence
 * - The marker does not exist: return an empty string
 *
 * The trailing newline is removed from the result.
 */
export function extractMarkerOutput(transcript: string, marker: string): string {
  const first = transcript.indexOf(marker);
  if (first < 0) return '';

  let after = transcript.slice(first + marker.length);
  // Skip the single newline right after it (the output follows the echo line)
  if (after.startsWith('\r\n')) after = after.slice(2);
  else if (after.startsWith('\n')) after = after.slice(1);

  const second = after.indexOf(marker);
  const body = second >= 0 ? after.slice(0, second) : after;

  // Strip the trailing newline
  return body.replace(/\r?\n$/, '');
}

/** Strip these markers from the text (used before sending to the user, Fact S3) */
export function stripMarkers(transcript: string, markers: string[]): string {
  let out = transcript;
  for (const m of markers) {
    out = out.split(m).join('');
  }
  return out;
}

/**
 * Session base class.
 *
 * The subclasses implement the concrete transports (serial / ssh / local
 * pty). What they share: writing the log, the exit code semantics, marker
 * management.
 */
export abstract class Session {
  constructor(protected readonly log: SessionLog) {}

  /** Write data to the remote side */
  abstract write(data: string): void;

  /** Terminal size change. Serial has no concept of a window, so the implementation is a no-op */
  abstract resize(cols: number, rows: number): void;

  /** Close the session */
  abstract close(): void;

  /** Subscribe to the remote output. The transport layer feeds the received data in */
  abstract onData(cb: (chunk: string) => void): void;

  /**
   * Exit code. **Always null for serial** — serial cannot obtain an exit
   * status (Fact S5): a textual reply counts as 0, a timeout counts as 124.
   */
  abstract readonly exitCode: number | null;

  /**
   * The session **ended on its own** (the remote shell exited, adbd dropped
   * the link, the cable was unplugged).
   *
   * **Why this hook is needed**: without it, after the user types `exit` in
   * an SSH terminal the tab stays in the interface, the screen freezes on the
   * last output, and further typing goes into a **dead** channel — "the
   * board went offline and the interface does not know". That collides
   * directly with "a cockpit, not a remote control": a cockpit has to show
   * what the board is **actually** doing.
   *
   * There is no exit event by default (a serial console never reports one).
   */
  onExit(_cb: (exitCode: number | null) => void): void {
    // Default implementation: no exit event
  }

  /** Record one line into the session log */
  protected record(line: string): void {
    this.log.write(line);
  }
}
