import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { userDataDir, userProfilesDir, logDir } from '../../src/main/util/paths';

describe('paths', () => {
  const prev = process.env.LOCALAPPDATA;
  afterEach(() => {
    if (prev === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = prev;
  });

  it('用户数据目录挂在 LOCALAPPDATA 下（Windows）', () => {
    process.env.LOCALAPPDATA = 'C:\\Users\\T\\AppData\\Local';
    expect(userDataDir()).toBe(join('C:\\Users\\T\\AppData\\Local', 'DevBoardCockpit'));
  });

  it('profiles 与 logs 都在用户数据目录下', () => {
    expect(userProfilesDir().endsWith(join('profiles', 'targets'))).toBe(true);
    expect(logDir().endsWith('logs')).toBe(true);
  });
});
