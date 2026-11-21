import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProfile, deviceKeyConflicts, type ConnectionProfile } from './schema';

/**
 * Loading the connection profiles.
 *
 * Two sources: the builtin directory (shipped with the application, read
 * only) and the user directory (writable). On the same id the two are
 * **merged** — the builtin one says *what this connection is*, the user one
 * says *what this machine needs*.
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

/** One profile as it was read from a file ✓ (the path is remembered for the warning ✓) */
interface Loaded {
  profile: ConnectionProfile;
  path: string;
}

/** Reads one directory of profiles ✓ */
function collect(dir: string | undefined, warn: (message: string) => void): Map<string, Loaded> {
  const out = new Map<string, Loaded>();
  if (!dir) return out;
  for (const file of readDir(dir)) {
    const path = join(dir, file);
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const profile = parseProfile(parsed, path);
      out.set(profile.id, { profile, path });
    } catch (err) {
      warn(`skipping the broken profile ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

/**
 * **The two layers of one profile** ✓.
 *
 * → The **identity** (`label` · `transport` · `board_pack` · `device_key`) is
 *   the **contract** of the connection ✓ — it says which board it is and
 *   which channel it uses ✓ — and it does not belong to one machine ✓.
 * → The **options** are the **machine-specific values** ✓ (the address ✓ ·
 *   the serial number ✓ · the serial port ✓ · the credential ✓) — they
 *   belong to the machine the profile is used on ✓.
 *
 * → **The merge** ✓: the identity comes from the **built-in** profile ✓ and
 *   the options are merged **field by field** ✓ — the user's value wins ✓ ·
 *   the built-in's fields that the user's copy does not name **survive** ✓.
 *
 * → **Why not "the user's copy wins completely"** ✓ (the old rule ✓):
 *   a copy that is written once and never touched **freezes** the profile ✓
 *   → a shipped fix (a renamed board ✓ · a new default ✓) never reaches the
 *   machine ✓. That is exactly how the board came to be called `atk-01` on a
 *   machine whose shipped profile says `ATK-DLRK3588` ✓ (found on
 *   2026-11-21 ✓).
 *
 * → An option of the user's copy that the transport does not allow is
 *   **dropped** ✓ (the built-in's value stays ✓) — a profile that does not
 *   fit its transport is not a profile ✓ (the schema is closed ✓).
 */
export function mergeProfiles(
  builtin: ConnectionProfile,
  user: ConnectionProfile,
): { profile: ConnectionProfile; dropped: string[] } {
  const identity: Record<string, unknown> = {
    id: builtin.id,
    label: builtin.label,
    transport: builtin.transport,
    ...(builtin.board_pack === undefined ? {} : { board_pack: builtin.board_pack }),
    ...(builtin.device_key === undefined ? {} : { device_key: builtin.device_key }),
  };

  const options: Record<string, unknown> = { ...builtin.options };
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(user.options)) {
    const candidate = { ...options, [key]: value };
    try {
      parseProfile({ ...identity, options: candidate }, 'merged');
      options[key] = value;
    } catch {
      // → The value does not fit this transport ✓ → the built-in's value
      //   stays ✓ (and the drop is reported ✓).
      dropped.push(key);
    }
  }

  const profile = parseProfile({ ...identity, options }, 'merged');
  return { profile, dropped };
}

/**
 * The fields of the identity ✓ (what the built-in profile decides ✓).
 *
 * → A difference between the two copies is reported ✓ — the person learns
 *   that their copy is stale ✓ (and that it was ignored ✓).
 */
function identityDifferences(builtin: ConnectionProfile, user: ConnectionProfile): string[] {
  const out: string[] = [];
  if (builtin.label !== user.label) out.push(`label ${user.label} → ${builtin.label}`);
  if (builtin.transport !== user.transport) out.push(`transport ${user.transport} → ${builtin.transport}`);
  const builtinPack = builtin.board_pack ?? null;
  const userPack = user.board_pack ?? null;
  if (builtinPack !== userPack) out.push(`board_pack ${userPack ?? '(none)'} → ${builtinPack ?? '(none)'}`);
  const builtinKey = builtin.device_key ?? builtin.id;
  const userKey = user.device_key ?? user.id;
  if (builtinKey !== userKey) out.push(`device_key ${userKey} → ${builtinKey}`);
  return out;
}

/**
 * The warnings that were already given ✓ — **per warning channel** ✓.
 *
 * → The profile list is read **again and again** ✓ (every connection ✓ ·
 *   every `connections:list` ✓) → without this the same stale copy would be
 *   reported on every read ✓ → the log would drown in it ✓ (found on
 *   2026-11-21 ✓).
 * → **Once per channel is enough** ✓ — the copy does not change while the
 *   application runs ✓ (the board setup writes a new one ✓ → and then the
 *   copy is no longer stale ✓).
 * → The channel is part of the key ✓ → a caller that collects the warnings
 *   for itself gets **all** of them ✓ (the test does ✓).
 */
const warned = new WeakMap<(message: string) => void, Set<string>>();

/** The default channel ✓ (stable ✓ — it is the key of the set above ✓) */
const defaultWarn = (message: string): void => {
  console.warn(message);
};

/** Says a warning — but only once per channel ✓ */
function warnOnce(warn: (message: string) => void, message: string): void {
  let seen = warned.get(warn);
  if (seen === undefined) {
    seen = new Set<string>();
    warned.set(warn, seen);
  }
  if (seen.has(message)) return;
  seen.add(message);
  warn(message);
}

export function loadProfiles(opts: LoadProfilesOptions): ConnectionProfile[] {
  const warn = opts.warn ?? defaultWarn;
  const builtins = collect(opts.builtinDir, warn);
  const users = collect(opts.userDir, warn);

  const merged = new Map<string, ConnectionProfile>();
  for (const [id, entry] of builtins) merged.set(id, entry.profile);

  for (const [id, entry] of users) {
    const base = builtins.get(id);
    // → **A profile that only the user directory has is used as it is** ✓
    //   (the wizard's own board ✓ — it has no shipped counterpart ✓).
    if (base === undefined) {
      merged.set(id, entry.profile);
      continue;
    }
    const differences = identityDifferences(base.profile, entry.profile);
    if (differences.length > 0) {
      warnOnce(
        warn,
        `the copy of "${id}" in the user directory is stale (${differences.join(' · ')}) — ` +
          'the shipped identity is used ✓ and only the machine-specific values are taken from the user directory ✓',
      );
    }
    const result = mergeProfiles(base.profile, entry.profile);
    if (result.dropped.length > 0) {
      warnOnce(
        warn,
        `the copy of "${id}" in the user directory carries options that the ${base.profile.transport} transport does not allow (${result.dropped.join(' · ')}) — they are ignored ✓`,
      );
    }
    merged.set(id, result.profile);
  }

  const list = Array.from(merged.values()).sort((a, b) => a.id.localeCompare(b.id));

  // The same `device_key` declares different board packs ✓ → say so ✓
  // → It does not take the application down ✓ (the same rule as "a broken
  //   file is only skipped" ✓ — the user should not fail to start over one
  //   typo ✓)
  for (const conflict of deviceKeyConflicts(list)) {
    warn(
      `device_key '${conflict.device_key}' declares the board packs ${conflict.board_packs.join(' / ')} at the same time` +
        `(${conflict.profile_ids.join(' / ')} are involved) — one board has exactly one model ✓`,
    );
  }

  return list;
}
