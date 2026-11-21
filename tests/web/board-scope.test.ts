import { describe, it, expect } from 'vitest';
import type { ConnectionInfo } from '../../src/shared/ipc-contract';
import {
  boardOfConnection,
  boardOfSession,
  boardsIn,
  connectionsOfBoard,
  currentBoard,
  machineConnections,
  sessionsOfBoard,
} from '../../src/renderer/shell/board-scope';

/**
 * **Which board does this belong to?** ✓
 *
 * ── Why it matters ──
 *
 * → The machine can have **several boards** ✓ (the real one ✓ and the
 *   synthetic one ✓) → a flat list of terminals puts **the terminal of one
 *   board under the other** ✓ → the user cannot tell whose terminal they
 *   are looking at ✓ (the user said exactly this on 2026-11-21 ✓).
 * → So the terminal page is scoped to **one board at a time** ✓.
 */

function connection(
  id: string,
  deviceKey: string,
  boardPack: string | null,
  current = false,
): ConnectionInfo {
  return {
    id,
    label: id,
    transport: boardPack === null ? 'ssh' : 'adb',
    boardPack,
    deviceKey,
    current,
    capabilities: { exec: true, pty: false, files: false, exitCode: true },
  };
}

const REAL = connection('board-adb', 'atk-01', 'rk3588-atk', true);
const FAKE = connection('fake-board', 'fake-board', 'rk3588-atk');
const LOCAL = connection('local', 'local', null);

describe('the board scope · the board of a thing', () => {
  it('**a connection knows its board** ✓', () => {
    expect(boardOfConnection([REAL, FAKE], 'board-adb')).toBe('atk-01');
    expect(boardOfConnection([REAL, FAKE], 'fake-board')).toBe('fake-board');
  });

  it('**a connection without a board pack is not a board** ✓ (the local machine ✓ · the guest ✓)', () => {
    expect(boardOfConnection([LOCAL], 'local')).toBeNull();
    expect(machineConnections([REAL, FAKE, LOCAL])).toHaveLength(1);
  });

  it('**the session knows the board of its connection** ✓', () => {
    const session = { sessionId: 's-1', profileId: 'fake-board', label: 'fake' };
    expect(boardOfSession([REAL, FAKE], session)).toBe('fake-board');
  });

  it('**the board the runtime is on is the current one** ✓', () => {
    expect(currentBoard([REAL, FAKE])).toBe('atk-01');
    expect(currentBoard([FAKE, REAL])).toBe('atk-01');
    expect(currentBoard([FAKE, { ...REAL, current: false }])).toBeNull();
  });

  it('**the boards are listed with the current one first** ✓', () => {
    expect(boardsIn([FAKE, REAL])).toEqual(['atk-01', 'fake-board']);
  });
});

describe('the board scope · the terminal page', () => {
  const sessions = [
    { sessionId: 's-real', profileId: 'board-adb', label: 'Board · ADB' },
    { sessionId: 's-fake', profileId: 'fake-board', label: 'fake board' },
  ];

  it('**only the sessions of the current board are shown** ✓', () => {
    const shown = sessionsOfBoard(sessions, [REAL, FAKE], 'atk-01');
    expect(shown.map((session) => session.sessionId)).toEqual(['s-real']);
  });

  it('**the terminal of the other board is not on this board** ✓', () => {
    const shown = sessionsOfBoard(sessions, [REAL, FAKE], 'fake-board');
    expect(shown.map((session) => session.sessionId)).toEqual(['s-fake']);
  });

  it('**no board → everything** ✓ (there is nothing to scope it by ✓)', () => {
    expect(sessionsOfBoard(sessions, [REAL, FAKE], null)).toHaveLength(2);
  });

  it('**the connections of the board are the ones that belong to it** ✓', () => {
    const shown = connectionsOfBoard([REAL, FAKE, LOCAL], 'atk-01');
    expect(shown.map((entry) => entry.id)).toEqual(['board-adb']);
  });
});
