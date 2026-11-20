import type { ConnectionInfo } from '../../shared/ipc-contract';

/**
 * **The interface layer only knows boards** (the board and its connections
 * are two layers ✓ — contract `spec/02` §10.2 ✓).
 *
 * ── Why this layer exists ──
 *
 * → A board has **three connections: ADB / serial / SSH** ✓ → **they are the
 *   same board** ✓
 * → The interface has to make the user think in **boards** ✓, not in
 *   **channels** ✓.
 * → The user was explicit on 2026-11-16: **only board selection, do not put
 *   the connections in there** ✓
 *   → **The menu lists boards only** ✓ → **the host picks the connection** ✓.
 *
 * ── Four rules (**all of them "never guess"** ✓) ──
 *
 * | # | Rule | Why |
 * |---|---|---|
 * | 1 | **The name of the device is its `device_key`** ✓ | **Do not invent a name** ✗ — the three connections carry different labels (`Board · ADB` / `Board · Serial` / `Board · SSH` ✓) → **picking one of them is an invention** ✗ → **use its identity** ✓ |
 * | 2 | **A connection without a board pack is not a board** ✓ | **The local machine and the guest are not boards** ✓ — the same measure as at runtime ✓ (`tags/runtime.ts` ✓) |
 * | 3 | **The current board comes first** ✓ | The person choosing a board **first sees which one they are using** ✓ |
 * | 4 | **A board has exactly one "current"** ✓ | Two things claiming to be current means **the data is inconsistent** ✓ → **only the first one counts** ✓ (**never guess who the second one is** ✓) |
 */

/** A board (**this is all the interface sees** ✓ — **the connections are not listed** ✓) */
export interface Board {
  /** **The identity of this board** ✓ (**its name is the same** ✓ — not invented ✓) */
  deviceKey: string;
  /** **The board pack** (**the model of this board** ✓) */
  boardPack: string;
  /** **The current runtime uses this board** ✓ */
  current: boolean;
  /** **How many connections this board has** ✓ (**information only** ✓ — **the interface does not let the user pick a connection** ✓) */
  connectionCount: number;
}

/**
 * Groups the connections by board.
 *
 * → **Only the connections bound to a board pack are kept** ✓ (**the local
 *   machine and the guest are not boards** ✓)
 * → **The current board comes first** ✓, the rest keep the input order ✓.
 * → **The name of a board is its `device_key`** ✓ (**not invented** ✓).
 */
export function boardsOf(connections: readonly ConnectionInfo[]): Board[] {
  const byKey = new Map<string, Board>();
  for (const connection of connections) {
    // **A connection without a board pack is not a board** ✓ (the local machine / the guest ✓ — they are "machines", not "boards" ✓)
    if (connection.boardPack === null) continue;
    const entry = byKey.get(connection.deviceKey);
    if (entry === undefined) {
      byKey.set(connection.deviceKey, {
        deviceKey: connection.deviceKey,
        boardPack: connection.boardPack,
        current: connection.current,
        connectionCount: 1,
      });
      continue;
    }
    // **Only the first `current` counts** ✓ (**two places claiming to be "current" means the data is confused** ✓)
    if (!entry.current && connection.current) entry.current = true;
    entry.connectionCount += 1;
  }

  const boards = [...byKey.values()];
  // **The current board comes first** ✓ (**the rest keep the input order** ✓)
  const currentFirst = boards.filter((board) => board.current);
  const rest = boards.filter((board) => !board.current);
  return [...currentFirst, ...rest];
}
