import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProfile, deviceKeyConflicts, type ConnectionProfile } from './schema';

/**
 * Loading the connection profiles.
 *
 * Two sources: the builtin directory (shipped with the application, read
 * only) and the user directory (writable). On the same id the user's wins —
 * the user can override a builtin profile, which is the precondition of
 * "changing the configuration without touching the code" (the most
 * convenient way to add a board in the legacy project: drop a JSON file into
 * the user directory, restart, the board appears).
 *
 * A broken file does not take the rest down: one badly written profile is
 * only skipped and gets a warning. The user should not fail to start the
 * whole application over one typo.
 */

export interface LoadProfilesOptions {
  /** The builtin directory, an absolute path */
  builtinDir: string;
  /** The user directory, an absolute path. Skipped when it does not exist */
  userDir?: string;
  /** Where the warnings go, `console.warn` by default */
  warn?: (message: string) => void;
}

function readDir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

export function loadProfiles(opts: LoadProfilesOptions): ConnectionProfile[] {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const merged = new Map<string, ConnectionProfile>();

  const collect = (dir: string | undefined): void => {
    if (!dir) return;
    for (const file of readDir(dir)) {
      const path = join(dir, file);
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
        const profile = parseProfile(parsed, path);
        merged.set(profile.id, profile);
      } catch (err) {
        warn(`跳过坏的 profile ${path}：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  // The builtin ones first, the user ones after — on the same id the user's overrides the builtin's
  collect(opts.builtinDir);
  collect(opts.userDir);

  const list = Array.from(merged.values()).sort((a, b) => a.id.localeCompare(b.id));

  // The same `device_key` declares different board packs ✓ → say so ✓
  // → It does not take the application down ✓ (the same rule as "a broken
  //   file is only skipped" ✓ — the user should not fail to start over one
  //   typo ✓)
  for (const conflict of deviceKeyConflicts(list)) {
    warn(
      `device_key '${conflict.device_key}' 同时声明了板型包 ${conflict.board_packs.join(' / ')}` +
        `（牵涉 ${conflict.profile_ids.join(' / ')}）—— 一块板只有一个型号 ✓`,
    );
  }

  return list;
}
