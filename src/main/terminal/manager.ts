import { randomUUID } from 'node:crypto';
import { makeError } from '../../shared/errors';
import type { SessionLog } from '../logging/session-log';
import type { ConnectionProfile } from '../profiles/schema';
import type { Connection } from '../hal/connection';
import { capabilitiesFor } from '../hal/capabilities';
import type { Session } from '../hal/session';
import { PipeInput } from './line-editor';

/**
 * The lifecycle of a terminal session.
 *
 * One session = one interactive session on one connection instance.
 * On the host side only three things happen: forwarding the keystrokes,
 * forwarding the output, writing the log.
 *
 * Who is responsible for the echo (the two terminal modes of the legacy
 * project):
 *
 * - pty mode (ssh, `adb shell -t`): the remote side provides a real
 *   terminal, echoes by itself and emits the ANSI itself. The host only
 *   forwards the keystrokes and does not echo a second time — one extra echo
 *   and the user sees two lines of text.
 * - pipe mode (`adb shell` without a PTY, serial): the remote side does not
 *   echo. So the host also writes the user input into the data channel, and
 *   only then does the user see what they typed.
 *
 * This boundary has to be decided on the capability bits, not on the
 * transport name — the legacy project inferred it from the transport name,
 * and a newly registered transport was then treated as a real terminal (see
 * `connection.ts`).
 */

export interface TerminalManagerOptions {
  /** Lists the usable connection profiles (looked up by id) */
  listProfiles(): ConnectionProfile[];
  /**
   * Builds a connection from a profile.
   *
   * The log is built by the manager and handed in — one log per session,
   * and the copy of the connection and the copy of the session have to be
   * the same file: the input (`Session.record`) and the output (the
   * manager's `onData`) have to end up in the same place. Both sides used to
   * build one each, with the same label, so one session landed in two files
   * and the connection's copy never got its closing line.
   */
  createConnection(profile: ConnectionProfile, log: SessionLog): Connection;
  /**
   * Builds a session log.
   *
   * One per session (not one per profile) — the same profile opened in two
   * tabs means two conversations that have to be told apart.
   */
  createLog(label: string, transport: string): SessionLog;
  /** The notification after a connection is established. Modules such as the file transfer use it to get the "find a connection by id" entry point */
  onConnectionOpen?: (sessionId: string, connection: Connection) => void;
  /** The notification after a connection is closed. Otherwise the connections Map keeps the closed connections */
  onConnectionClose?: (sessionId: string) => void;
}

interface LiveSession {
  id: string;
  /**
   * Which profile this session is connected to ✓.
   *
   * → It answers "does this profile have a live connection right now" ✓
   *   (the `connected` of contract `spec/04` §2.1 ✓).
   * → Sessions are indexed by sessionId, "who is connected" is indexed by
   *   profileId ✓ — two different questions ✓
   *   (the same profile can be opened in two tabs ✓ — indexing the sessions
   *   by profileId collides ✓ — that pit has been stepped into ✓).
   */
  profileId: string;
  session: Session;
  connection: Connection;
  pty: boolean;
  /** The line-editing layer of pipe mode. One per session (the input lines of the sessions do not touch each other) */
  editor: PipeInput;
}

export class TerminalManager {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly dataCbs: ((sessionId: string, chunk: string) => void)[] = [];
  private readonly exitCbs: ((sessionId: string, exitCode: number | null) => void)[] = [];
  private readonly logs = new Map<string, SessionLog>();

  constructor(private readonly opts: TerminalManagerOptions) {}

  /** One log per session (indexed by sessionId, not by profile) */
  private logFor(sessionId: string, label: string, transport: string): SessionLog {
    let log = this.logs.get(sessionId);
    if (!log) {
      log = this.opts.createLog(label, transport);
      this.logs.set(sessionId, log);
    }
    return log;
  }

  /** Closes out the log of a session: disconnect → (if the remote side exited on its own) end of stream → closing */
  private closeLog(sessionId: string, remoteExited: boolean): void {
    const log = this.logs.get(sessionId);
    if (!log) return;
    // The order matches the golden sample:
    //   --- disconnected --- → --- stream-ended --- → === session closed ===
    log.writeEvent('disconnected');
    if (remoteExited) log.writeEvent('stream-ended');
    log.close();
    this.logs.delete(sessionId);
  }

  /** Opens a session. Reports TERM_NOT_FOUND when the profile cannot be found */
  async open(profileId: string): Promise<{ sessionId: string }> {
    const profile = this.opts.listProfiles().find((p) => p.id === profileId);
    if (!profile) {
      throw makeError('TERM_NOT_FOUND', `no such connection ${profileId}`, {
        detail: { profileId },
      });
    }

    const id = randomUUID();
    // The session log: one per session (the two tabs of the same profile have
    // to be told apart), and the connection and the session share this one —
    // the input and the output have to end up in the same place.
    const log = this.logFor(id, profileId, profile.transport);

    let connection: Connection;
    try {
      connection = this.opts.createConnection(profile, log);
      await connection.open();
    } catch (err) {
      // It cannot connect: the log must not be left with an unfinished half
      this.closeLog(id, false);
      throw err;
    }

    let session: Session;
    try {
      session = await connection.openSession({ cols: 80, rows: 24 });
    } catch (err) {
      // If no session can be opened, close the connection — otherwise the ssh
      // client and the socket hang around forever, and the connection is not
      // in the Map, so nothing can reclaim it.
      await connection.close().catch(() => undefined);
      this.closeLog(id, false);
      throw err;
    }
    // The terminal mode is decided by the profile, not by the transport name.
    //
    // There used to be a bug here where the two sources of the capability
    // bit contradicted each other: `connection.capabilities().pty` reported
    // the constant of the transport (serial=true / adb=false / …) and never
    // looked at the profile, while on the UI side `connections:list` used
    // the profile-aware `capabilitiesFor(profile)`. The user set `pty` to
    // false in the profile, the UI reported false, the runtime still ran as
    // true, so the host did neither line editing nor echoing, not a single
    // character the user typed was visible, and the carriage return went
    // out as `\r`, so the remote side never saw the end of a line.
    //
    // The workaround at the time: this called `capabilitiesFor(profile)`
    // directly and bypassed the connection object. The fix of 2026-11-13:
    // the connection object calls `capabilitiesFor(profile)` as well
    // (`Connection.capabilities()` no longer reports the transport
    // constant), so the contradiction itself is gone; this still calls the
    // same function so that "the only implementation" is true in name too.
    const pty = capabilitiesFor(profile).pty;

    // The opening event line. The format is isomorphic with the golden sample (the legacy project wrote these lines too)
    log.writeEvent('connected', profileId);

    session.onData((chunk: string) => {
      // The remote output has to be written to the log as well — fact G4:
      // "a crash / a restart / closing the window must not lose records".
      // Writing the input but not the output leaves only half a conversation
      // for the after-the-fact review.
      log.write(chunk);
      for (const cb of this.dataCbs) cb(id, chunk);
    });

    // The remote side exited on its own (exit typed / the cable pulled /
    // adbd disconnected) → close out the session and notify the interface.
    // Without this, the interface keeps the tab and the user goes on typing
    // into a dead channel.
    session.onExit((exitCode: number | null) => {
      // **The reason the link died goes into the log** ✓ — the connection
      // says why ✓ (`lastError` ✓) → without it the terminal only said "the
      // session ended" ✓ and the user could not tell a pulled cable from a
      // refused port ✓ (found on 2026-11-21 ✓).
      const reason = connection.lastError;
      if (reason !== undefined) {
        log.write(`the link died: ${reason.message}`);
      }
      this.closeSession(id, exitCode, true);
    });

    // pipe mode: the remote side sends no prompt, the host draws it (the `options.prompt` of the profile)
    const prompt = typeof profile.options['prompt'] === 'string' ? profile.options['prompt'] : '';
    const editor = new PipeInput(prompt);
    this.sessions.set(id, { id, profileId: profile.id, session, connection, pty, editor });
    // Registered by sessionId: one tab, one connection. Registered by
    // profileId, two tabs of the same profile would overwrite each other.
    this.opts.onConnectionOpen?.(id, connection);

    // The first prompt of pipe mode
    if (!pty && prompt.length > 0) {
      for (const cb of this.dataCbs) cb(id, prompt);
    }
    return { sessionId: id };
  }

  write(sessionId: string, data: string): void {
    const live = this.require(sessionId);

    if (live.pty) {
      // pty mode: the remote side has a real terminal (getty / sshd), the
      // line discipline and the echo live over there. The host only
      // forwards, one extra echo and the user sees two lines of text.
      live.session.write(data);
      return;
    }

    // pipe mode: the remote side has no line discipline — the host does the
    // line editing and the echoing. The carriage return has to be translated
    // into an LF before it goes out, otherwise the remote shell never sees
    // the end of a line (measured on a real board, plan-1 review, finding
    // R-01).
    const edit = live.editor.input(data);
    if (edit.toRemote.length > 0) live.session.write(edit.toRemote);
    if (edit.echo.length > 0) {
      for (const cb of this.dataCbs) cb(sessionId, edit.echo);
    }
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.require(sessionId).session.resize(cols, rows);
  }

  /**
   * Closes a session.
   *
   * It has to wait until the connection is really closed before returning:
   * the `close()` of a serial port is asynchronous (it waits for the
   * `port.close()` callback), and returning without waiting makes the user
   * hit `PORT_BUSY` when they "close a tab → reopen it right away" — and
   * since they just closed the tab, that "the port is in use" makes people
   * think the port is taken by somebody else.
   */
  async close(sessionId: string): Promise<void> {
    await this.closeSession(sessionId, this.sessions.get(sessionId)?.session.exitCode ?? null, false);
  }

  /**
   * Closes out a session.
   *
   * Two paths lead here: the user clicks the close button, or the remote
   * side exited on its own. Calling it twice is harmless — once the session
   * is deleted from the map, the second call returns right away.
   */
  private async closeSession(
    sessionId: string,
    exitCode: number | null,
    remoteExited: boolean,
  ): Promise<void> {
    const live = this.sessions.get(sessionId);
    if (!live) return;
    // The session is closed first: SSH flushes out the half character that
    // was in the decoder — it has to land before `=== session closed ===`.
    live.session.close();
    await live.connection.close().catch(() => undefined);
    this.sessions.delete(sessionId);
    // The connection has to be unregistered as well — otherwise looking up a
    // connection by id hands out a closed one
    this.opts.onConnectionClose?.(sessionId);
    // The disconnect and the closing have to go into the log as well —
    // afterwards it has to be visible "how did this session end"
    this.closeLog(sessionId, remoteExited);
    for (const cb of this.exitCbs) cb(sessionId, exitCode);
  }

  onData(cb: (sessionId: string, chunk: string) => void): void {
    this.dataCbs.push(cb);
  }

  /**
   * The profile ids that have a live connection right now ✓.
   *
   * → This is the answer to "does this profile have a live connection right
   *   now" ✓ (the `connected` of contract `spec/04` §2.1 ✓).
   * → The same profile opened in several tabs appears only once ✓ — the
   *   question is "which profiles are connected" ✓, not "how many sessions
   *   are there" ✓.
   * → Closing one tab → the other one is still there → the profile is still
   *   there ✓.
   *
   * → Why it is needed ✓: on the host side there is no connection registry ✓
   *   — the `connections` Map of `main/index.ts` is indexed by sessionId ✓
   *   (it is there for the file transfer ✓), and indexing the sessions by
   *   profileId collides ✓ (the same profile opened in two tabs ✓).
   */
  liveProfileIds(): string[] {
    const ids = new Set<string>();
    for (const live of this.sessions.values()) ids.add(live.profileId);
    return [...ids];
  }

  onExit(cb: (sessionId: string, exitCode: number | null) => void): void {
    this.exitCbs.push(cb);
  }

  private require(sessionId: string): LiveSession {
    const live = this.sessions.get(sessionId);
    if (!live) {
      throw makeError('TERM_NOT_FOUND', `no such session ${sessionId}`, { detail: { sessionId } });
    }
    return live;
  }
}
