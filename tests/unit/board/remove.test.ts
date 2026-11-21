import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeUserBoard } from '../../../src/main/board/remove';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cockpit-board-remove-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeProfile(dir: string, name: string, deviceKey: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      id: name,
      label: name,
      transport: 'serial',
      board_pack: deviceKey,
      device_key: deviceKey,
      options: { port: 'COM3', baudrate: 1500000 },
    }),
  );
  return path;
}

describe('removing a user-added board', () => {
  it('removes its user profiles and board pack together', () => {
    const builtin = join(root, 'builtin');
    const user = join(root, 'user-profiles');
    const boards = join(root, 'user-boards');
    writeProfile(builtin, 'shipped-board', 'SHIPPED');
    const profile = writeProfile(user, 'board-my-board', 'MY-BOARD');
    mkdirSync(join(boards, 'MY-BOARD'), { recursive: true });
    writeFileSync(join(boards, 'MY-BOARD', 'board.yaml'), 'kind: BoardPack\n');

    const result = removeUserBoard({
      deviceKey: 'MY-BOARD',
      builtinProfilesDir: builtin,
      userProfilesDir: user,
      userBoardsDir: boards,
    });

    expect(result.removedProfiles).toEqual(['board-my-board']);
    expect(result.removedPack).toBe(true);
    expect(existsSync(profile)).toBe(false);
    expect(existsSync(join(boards, 'MY-BOARD'))).toBe(false);
  });

  it('refuses to remove a board shipped with the project', () => {
    const builtin = join(root, 'builtin');
    const user = join(root, 'user-profiles');
    const boards = join(root, 'user-boards');
    writeProfile(builtin, 'board-shipped', 'SHIPPED');
    const profile = writeProfile(user, 'board-shipped', 'SHIPPED');
    mkdirSync(join(boards, 'SHIPPED'), { recursive: true });

    expect(() =>
      removeUserBoard({
        deviceKey: 'SHIPPED',
        builtinProfilesDir: builtin,
        userProfilesDir: user,
        userBoardsDir: boards,
      }),
    ).toThrow(/built-in boards cannot be deleted/);
    expect(existsSync(profile)).toBe(true);
    expect(existsSync(join(boards, 'SHIPPED'))).toBe(true);
  });

  it('refuses a board path that leaves the user board directory', () => {
    const builtin = join(root, 'builtin');
    const user = join(root, 'user-profiles');
    const boards = join(root, 'user-boards');
    const outside = join(root, 'outside');
    writeProfile(user, 'board-escape', '../outside');
    mkdirSync(outside, { recursive: true });

    expect(() =>
      removeUserBoard({
        deviceKey: '../outside',
        builtinProfilesDir: builtin,
        userProfilesDir: user,
        userBoardsDir: boards,
      }),
    ).toThrow(/outside the user data directory/);
    expect(existsSync(outside)).toBe(true);
  });
});
