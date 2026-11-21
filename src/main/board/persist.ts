/**
 * **Writing the resolved profile into the user's own directory.**
 *
 * ── Why the user directory ──
 *
 * → The built-in profiles live **inside the application archive** ✓ → they
 *   are read-only ✓ → the machine-specific values cannot be written there ✓.
 * → The user directory is writable ✓ → and on the same id **the user's copy
 *   wins** ✓ (`profiles/loader.ts` ✓) → so writing there is what "the
 *   connection is set up on this machine" means ✓.
 *
 * ── The rule about overwriting ──
 *
 * → **An existing file in the user directory is never overwritten** ✓ —
 *   it is the person's own configuration ✓ (the kit's rule is the same ✓:
 *   installing fills in what is missing ✓).
 * → The built-in copy keeps its placeholder ✓ → so the user can always see
 *   what the shipped value was ✓.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConnectionProfile } from '../profiles/schema';

export interface PersistResult {
  /** Was a file written? */
  written: boolean;
  /** Where it went (or would go) */
  path: string;
  /** Why it was not written (when it was not ✓) */
  reason?: string;
}

/**
 * Write the profile into the user directory ✓.
 *
 * → **Never overwrites** ✓ (an existing file there is the person's own ✓).
 * → Written through a temporary file ✓ (a half-written file would be read
 *   back as "no profile" ✓ — the same rule the permission store follows ✓).
 */
export function persistProfile(
  profile: ConnectionProfile,
  userProfilesDir: string,
): PersistResult {
  const path = join(userProfilesDir, `${profile.id}.json`);
  if (existsSync(path)) {
    return { written: false, path, reason: 'the user directory already has a profile with this id' };
  }
  mkdirSync(userProfilesDir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
  return { written: true, path };
}
