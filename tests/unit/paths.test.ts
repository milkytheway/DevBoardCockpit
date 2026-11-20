import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { userDataDir, userProfilesDir, logDir } from '../../src/main/util/paths';

describe('paths', () => {
  const prev = process.env.LOCALAPPDATA;
  afterEach(() => {
    if (prev === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = prev;
  });

  it('the user data directory hangs under LOCALAPPDATA (Windows)', () => {
    process.env.LOCALAPPDATA = 'C:\\Users\\T\\AppData\\Local';
    expect(userDataDir()).toBe(join('C:\\Users\\T\\AppData\\Local', 'DevBoardCockpit'));
  });

  it('the profiles and the logs are both in the user data directory', () => {
    expect(userProfilesDir().endsWith(join('profiles', 'targets'))).toBe(true);
    expect(logDir().endsWith('logs')).toBe(true);
  });
});
