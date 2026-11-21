import { describe, it, expect } from 'vitest';
import type { ConnectionInfo } from '../../src/shared/ipc-contract';
import { boardsOf } from '../../src/renderer/shell/devices';

/**
 * The interface layer knows boards only (`devices.ts`).
 *
 * ── Why this layer exists ──
 *
 * → The physical board and the connection are two layers (contract
 *   `docs/spec/02-board-pack.md` section 10.2) — a board has three
 *   connections (ADB / serial / SSH), so the interface groups them by board.
 * → The user was explicit on 2026-11-16: "support the selection of a board
 *   only, do not put the connections in there."
 *   → The interface layer knows boards only → the host picks the connection.
 *
 * → `device_key` is "which board" — every connection of the same board
 *   carries the same value.
 */
function conn(
  id: string,
  deviceKey: string,
  overrides: Partial<ConnectionInfo> = {},
): ConnectionInfo {
  return {
    id,
    label: id,
    transport: 'adb',
    boardPack: 'rk3588-atk',
    deviceKey,
    current: false,
    capabilities: { exec: true, pty: false, files: true, exitCode: true },
    ...overrides,
  };
}

describe('Grouping by board', () => {
  it('a shipped board and a user-added board keep separate deletion rights', () => {
    const boards = boardsOf([
      conn('shipped', 'SHIPPED'),
      conn('mine', 'MY-BOARD', { deletable: true }),
    ]);
    expect(boards.map((board) => [board.deviceKey, board.deletable])).toEqual([
      ['SHIPPED', false],
      ['MY-BOARD', true],
    ]);
  });

  it('the several connections of one board collapse into one board', () => {
    const boards = boardsOf([
      conn('board-adb', 'atk-01', { label: 'Board · ADB' }),
      conn('board-serial', 'atk-01', { label: 'Board · Serial', transport: 'serial' }),
      conn('board-ssh', 'atk-01', { label: 'Board · SSH', transport: 'ssh' }),
      conn('guest', 'guest', { label: 'Guest', transport: 'ssh' }),
    ]);
    expect(boards.map((b) => b.deviceKey)).toEqual(['atk-01', 'guest']);
    expect(boards[0]?.connectionCount).toBe(3);
  });

  it('the current board comes first (the person choosing sees the board they are on)', () => {
    const boards = boardsOf([
      conn('guest', 'guest', { label: 'Guest', transport: 'ssh' }),
      conn('board-adb', 'atk-01', { label: 'Board · ADB', current: true }),
    ]);
    expect(boards.map((b) => b.deviceKey)).toEqual(['atk-01', 'guest']);
    expect(boards[0]?.current).toBe(true);
    expect(boards[1]?.current).toBe(false);
  });

  it('the board pack is the model of the board', () => {
    const boards = boardsOf([
      conn('board-adb', 'atk-01', { boardPack: 'rk3588-atk' }),
      conn('fake-board', 'fake-board', { boardPack: 'rk3588-atk' }),
    ]);
    expect(boards.map((b) => b.boardPack)).toEqual(['rk3588-atk', 'rk3588-atk']);
  });

  it('a connection without a board pack is not a board (the local machine and the guest are not boards)', () => {
    const boards = boardsOf([
      conn('local', 'local', { boardPack: null, transport: 'local' }),
      conn('guest', 'guest', { boardPack: null, transport: 'ssh' }),
      conn('board-adb', 'atk-01', { boardPack: 'rk3588-atk' }),
    ]);
    // Only a connection bound to a board pack is a board — the same measure as at
    // runtime (`src/main/tags/runtime.ts`)
    expect(boards.map((b) => b.deviceKey)).toEqual(['atk-01']);
  });

  it('a board has exactly one "current" — two claims to be current mean the data is inconsistent', () => {
    const boards = boardsOf([
      conn('board-adb', 'atk-01', { current: true }),
      conn('board-ssh', 'atk-01', { current: true }),
    ]);
    // Only the first one counts (the second one is never guessed at)
    expect(boards[0]?.current).toBe(true);
    expect(boards.length).toBe(1);
  });

  it('no connection gives an empty array (not a board without connections)', () => {
    expect(boardsOf([])).toEqual([]);
  });
});
