import { makeError } from '../../shared/errors';
import type { Connection } from '../hal/connection';
import type { ConnectionProfile, TransportKind } from '../profiles/schema';

/**
 * **The link that carries the files** ✓ — the file page does not need an open
 * terminal ✓.
 *
 * ── Why it is its own thing ──
 *
 * → The file page used to need **a terminal session** ✓ (the host keeps its
 *   connections by session id ✓ → the page had nothing to talk to until the
 *   user opened a terminal ✗ → "the files are empty until a terminal is
 *   open" ✗).
 * → Now **the host picks the link itself** ✓ and the page just uses it ✓.
 *
 * ── The order ✓ — **ADB → SSH → serial** ✓
 *
 * → **ADB** ✓ first: it needs no credential ✓ and it is the channel the
 *   board itself is usually reachable on ✓ (the board's own address is
 *   discovered through it ✓).
 * → **SSH** ✓ next: it needs a credential ✓ (the machine layer finds it ✓)
 *   but it is the channel that survives a board that has no USB cable ✓.
 * → **serial** ✓ last: a serial line is **exclusive** ✓ (the runtime may
 *   hold it ✓ → "the port is busy" ✓) and it **cannot carry files** ✓
 *   (fact S7 ✓) → it is the last resort ✓ and it is honest about it ✓.
 *
 * → **"The previous one is not there → probe the next one"** ✓: every
 *   candidate that cannot be opened ✓ (or cannot carry files ✓) is skipped
 *   ✓ and the next one is tried ✓ — and if none works ✓ the error names
 *   **each** of them ✓ (never a guess ✓).
 */
export const FILE_ENDPOINT_ORDER: readonly TransportKind[] = ['adb', 'ssh', 'serial'];

/** The id of the endpoint's connection in the table of the host ✓ */
export const FILE_ENDPOINT_ID = 'file-endpoint';

/**
 * The candidates ✓ — the connections of **the board that is current** ✓ in
 * the order above ✓.
 *
 * → **Only the board that is current** ✓ — the machine can have several
 *   boards ✓ (the real one ✓ and the synthetic one ✓) → the file transfer
 *   must not go to the other one ✗ (that is the leak of 2026-11-21 ✓).
 * → **The order of the transports decides** ✓ — inside one transport the
 *   order of the list is kept ✓ (so the result is reproducible ✓).
 */
export function fileEndpointCandidates(
  profiles: readonly ConnectionProfile[],
  deviceKey: string | null,
  order: readonly TransportKind[] = FILE_ENDPOINT_ORDER,
): ConnectionProfile[] {
  if (deviceKey === null || deviceKey.length === 0) return [];
  const board = profiles.filter(
    (profile) =>
      typeof profile.board_pack === 'string' &&
      profile.board_pack.length > 0 &&
      (profile.device_key ?? profile.id) === deviceKey,
  );
  const out: ConnectionProfile[] = [];
  for (const transport of order) {
    for (const profile of board) {
      if (profile.transport === transport) out.push(profile);
    }
  }
  return out;
}

export interface FileEndpointOptions {
  /** The profiles of this machine ✓ */
  listProfiles(): ConnectionProfile[];
  /** The board that is current ✓ (`null` = none ✓) */
  currentDeviceKey(): string | null;
  /** Builds a connection for a profile ✓ (the machine values are filled in here ✓) */
  createConnection(profile: ConnectionProfile): Promise<Connection>;
}

export interface FileEndpointHandle {
  /** The id in the table of connections of the host ✓ */
  id: string;
  /** The profile the endpoint uses ✓ */
  profile: ConnectionProfile;
  /** The open connection ✓ */
  connection: Connection;
}

/**
 * The endpoint ✓ — one connection ✓ that the file page uses ✓.
 *
 * → **It is opened on demand** ✓ (the page asks for it ✓) and it is **kept
 *   open** ✓ (the next transfer does not pay the handshake again ✓).
 * → **When the board changes** ✓ the old connection is dropped ✓ and the
 *   next one is chosen ✓.
 */
export class FileEndpoint {
  private current: { profileId: string; profile: ConnectionProfile; connection: Connection } | undefined;

  constructor(private readonly opts: FileEndpointOptions) {}

  /** The connection that is open right now ✓ (`undefined` = none ✓) */
  get open(): FileEndpointHandle | undefined {
    const current = this.current;
    if (current === undefined) return undefined;
    return {
      id: FILE_ENDPOINT_ID,
      profile: current.profile,
      connection: current.connection,
    };
  }

  /**
   * The endpoint ✓ — the first candidate that works ✓.
   *
   * → **The connection that is already open is reused** ✓ (the same board ✓
   *   and the same profile ✓).
   * → Otherwise the candidates are tried **one by one** ✓ — a candidate that
   *   cannot be opened ✓ or cannot carry files ✓ is skipped ✓ and the next
   *   one is tried ✓.
   * → **None works** → the error names **every** candidate and why ✓ (never
   *   a guess ✓).
   */
  async ensure(): Promise<FileEndpointHandle> {
    const deviceKey = this.opts.currentDeviceKey();
    const candidates = fileEndpointCandidates(this.opts.listProfiles(), deviceKey);
    if (candidates.length === 0) {
      throw makeError(
        'CONN_OPEN_FAILED',
        'there is no board connected — a file transfer needs a board',
        { detail: { deviceKey } },
      );
    }

    // → **The connection that is already open is reused** ✓
    if (this.current !== undefined) {
      const profile = candidates.find((candidate) => candidate.id === this.current?.profileId);
      if (profile !== undefined) {
        return {
          id: FILE_ENDPOINT_ID,
          profile,
          connection: this.current.connection,
        };
      }
      await this.close();
    }

    const problems: string[] = [];
    for (const profile of candidates) {
      let connection: Connection;
      try {
        connection = await this.opts.createConnection(profile);
        await connection.open();
      } catch (err) {
        problems.push(`${profile.id} (${profile.transport}): ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      // → **A connection that cannot carry files is not the endpoint** ✓
      //   (the serial one ✗ — fact S7 ✓) → the next candidate is tried ✓.
      if (!connection.capabilities().files) {
        await connection.close().catch(() => undefined);
        problems.push(`${profile.id} (${profile.transport}): this connection cannot carry files`);
        continue;
      }
      this.current = { profileId: profile.id, profile, connection };
      return { id: FILE_ENDPOINT_ID, profile, connection };
    }

    throw makeError(
      'CONN_OPEN_FAILED',
      `no connection of this board can carry files (${problems.join('; ')})`,
      { detail: { problems, deviceKey } },
    );
  }

  /** Drops the connection ✓ (the board changed ✓ · the application quits ✓) */
  async close(): Promise<void> {
    const current = this.current;
    this.current = undefined;
    if (current === undefined) return;
    await current.connection.close().catch(() => undefined);
  }
}
