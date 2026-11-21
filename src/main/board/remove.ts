import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { BoardDeleteResult } from '../../shared/ipc-contract';
import { makeError } from '../../shared/errors';
import { loadProfiles } from '../profiles/loader';
import { deviceKeyOf, parseProfile } from '../profiles/schema';

export interface RemoveBoardOptions {
  deviceKey: string;
  builtinProfilesDir: string;
  userProfilesDir: string;
  userBoardsDir: string;
}

interface UserProfileFile {
  id: string;
  deviceKey: string;
  path: string;
}

function userProfileFiles(dir: string): UserProfileFile[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const files: UserProfileFile[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const profile = parseProfile(JSON.parse(readFileSync(path, 'utf8')) as unknown, path);
      files.push({ id: profile.id, deviceKey: deviceKeyOf(profile), path });
    } catch {
      // A broken user profile is not a deletable board. It remains visible to
      // the loader's warning path so the user can repair or remove it there.
    }
  }
  return files;
}

function assertInside(root: string, target: string): void {
  if (dirname(target) !== resolve(root)) {
    throw makeError('IPC_INVALID_PAYLOAD', 'the board path is outside the user data directory');
  }
}

/**
 * Remove a board that exists only in the user's profile directory.
 *
 * Shipped boards are protected before any file operation. The user board pack
 * is only removed when its resolved path is a direct child of the user boards
 * directory.
 */
export function removeUserBoard(opts: RemoveBoardOptions): BoardDeleteResult {
  const builtin = loadProfiles({
    builtinDir: opts.builtinProfilesDir,
    warn: () => undefined,
  });
  const candidates = userProfileFiles(opts.userProfilesDir).filter(
    (profile) => profile.deviceKey === opts.deviceKey,
  );
  const builtinIds = new Set(builtin.map((profile) => profile.id));
  if (
    builtin.some((profile) => deviceKeyOf(profile) === opts.deviceKey) ||
    candidates.some((profile) => builtinIds.has(profile.id))
  ) {
    throw makeError('IPC_INVALID_PAYLOAD', 'built-in boards cannot be deleted');
  }
  if (candidates.length === 0) {
    throw makeError('IPC_INVALID_PAYLOAD', 'no user-added board has this identity');
  }

  const boardsRoot = resolve(opts.userBoardsDir);
  const packDir = resolve(boardsRoot, opts.deviceKey);
  assertInside(boardsRoot, packDir);

  const removedProfiles: string[] = [];
  for (const profile of candidates) {
    const profilePath = resolve(profile.path);
    assertInside(resolve(opts.userProfilesDir), profilePath);
    rmSync(profilePath, { force: true });
    removedProfiles.push(profile.id);
  }

  let removedPack = false;
  if (existsSync(packDir)) {
    rmSync(packDir, { recursive: true, force: true });
    removedPack = true;
  }

  return {
    deviceKey: opts.deviceKey,
    removedProfiles: removedProfiles.sort(),
    removedPack,
  };
}
