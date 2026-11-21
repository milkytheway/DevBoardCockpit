import type { ConnectionInfo } from '../../shared/ipc-contract';
import type { TerminalTab } from './types';

/**
 * **Which board does this belong to?** ✓
 *
 * ── Why this layer exists ──
 *
 * → A **board** is the physical thing ✓ and a **connection** is one way to
 *   reach it ✓ (contract `spec/02` §10.2 ✓) → one board has three
 *   connections ✓.
 * → The terminal page used to list **every** connection and **every**
 *   session in one flat list ✓ → with two boards on the machine ✓ (the real
 *   one ✓ and the synthetic one ✓) the terminal of one board **showed up
 *   under the other** ✓ → **the user could not tell whose terminal they
 *   were looking at** ✓.
 * → So: **the terminal page belongs to one board at a time** ✓ and the
 *   sidebar says which board each group is ✓.
 */

/** The board of a connection ✓ (`null` = it is not a board ✓ — the local machine ✓ · the guest ✓) */
export function boardOfConnection(
  connections: readonly ConnectionInfo[],
  connectionId: string,
): string | null {
  const connection = connections.find((candidate) => candidate.id === connectionId);
  if (connection === undefined) return null;
  if (connection.boardPack === null) return null;
  return connection.deviceKey;
}

/**
 * The board the runtime is on ✓.
 *
 * → **The connection the runtime uses** ✓ (`current` ✓) → its board ✓.
 * → `null` when there is no runtime ✓ (nothing is connected ✓) → then the
 *   terminal page shows everything ✓ (there is no board to scope it by ✓).
 */
export function currentBoard(connections: readonly ConnectionInfo[]): string | null {
  const current = connections.find((connection) => connection.current);
  if (current === undefined) return null;
  if (current.boardPack === null) return null;
  return current.deviceKey;
}

/** The board a session belongs to ✓ */
export function boardOfSession(
  connections: readonly ConnectionInfo[],
  session: TerminalTab,
): string | null {
  return boardOfConnection(connections, session.profileId);
}

/**
 * The sessions of one board ✓.
 *
 * → **The board that is current ✓ and the machines ✓** — a machine (the
 *   local shell ✓ · the guest ✓) is **not a board** ✓ → its session cannot
 *   leak into a board ✓ → and it must be visible ✓ (the user opened it ✓ →
 *   nothing happens ✗ — found on 2026-11-21 ✓).
 * → **The sessions of the other boards are not on this page** ✓ — one board
 *   at a time ✓ (the fake board's terminal used to show up on the 3588's
 *   page ✓) → they stay in the sidebar ✓ (a serial port is exclusive ✓ →
 *   they have to stay closable ✓).
 * → **No board is current** → the page belongs to no board ✓ → only the
 *   machines are on it ✓ (never the sessions of every board ✓).
 */
export function sessionsOfBoard(
  sessions: readonly TerminalTab[],
  connections: readonly ConnectionInfo[],
  board: string | null,
): TerminalTab[] {
  return sessions.filter((session) => {
    const owner = boardOfSession(connections, session);
    // → **A session that belongs to no board** ✓ (the local shell ✓ · the
    //   guest ✓) → it is shown whatever board is current ✓.
    if (owner === null) return true;
    if (board === null) return false;
    return owner === board;
  });
}

/**
 * The connections of one board ✓.
 *
 * → **The machines without a board are not hidden** ✓ — they are the host's
 *   own shell ✓ and the guest ✓ → they are not boards ✓ → they do not belong
 *   to the board scope ✓ → they are listed in their own group ✓.
 */
export function connectionsOfBoard(
  connections: readonly ConnectionInfo[],
  board: string | null,
): ConnectionInfo[] {
  if (board === null) return [...connections];
  return connections.filter((connection) =>
    connection.boardPack === null ? false : connection.deviceKey === board,
  );
}

/**
 * The connections that are not boards ✓ (the host's own shell ✓ · the guest ✓).
 *
 * → They are **machines** ✓ — they are always available ✓ → the board scope
 *   does not take them away ✓.
 */
export function machineConnections(connections: readonly ConnectionInfo[]): ConnectionInfo[] {
  return connections.filter((connection) => connection.boardPack === null);
}

/** The boards the connections know about ✓ (the current one first ✓) */
export function boardsIn(connections: readonly ConnectionInfo[]): string[] {
  const seen: string[] = [];
  for (const connection of connections) {
    if (connection.boardPack === null) continue;
    if (connection.current) {
      // **The current board comes first** ✓ (the same rule as the picker ✓)
      const at = seen.indexOf(connection.deviceKey);
      if (at > 0) seen.splice(at, 1);
      seen.unshift(connection.deviceKey);
      continue;
    }
    if (!seen.includes(connection.deviceKey)) seen.push(connection.deviceKey);
  }
  return seen;
}
