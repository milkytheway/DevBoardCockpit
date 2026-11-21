/**
 * **Preparing a connection for this machine.**
 *
 * ── The one job of this module ──
 *
 * A published profile carries **placeholders** for the values that only one
 * machine knows (the board's serial number ✓ · its address ✓). Before a
 * connection is built, those placeholders are **detected** ✓ and the repaired
 * profile is **written into the user directory** ✓ → from then on the
 * application reads the right values ✓ (the user's copy wins ✓).
 *
 * ── When nothing is wrong, nothing happens ──
 *
 * → A profile whose values are real is **not touched** ✓ → no adb call, no
 *   write, no delay ✓.
 *
 * ── When it cannot be repaired, it says so ──
 *
 * → The old message was "cannot reach the SSH host 192.0.2.100:22" ✓ — a
 *   **documented address** ✓ that the user cannot reach because **it is not
 *   a board** ✓ → the message has to name the placeholder ✓.
 */
import { makeError } from '../../shared/errors';
import type { ConnectionProfile } from '../profiles/schema';
import { isPlaceholderHost, isPlaceholderSerial, listAdbDevices, type AdbDevice } from './detect';
import { persistProfile } from './persist';
import { resolveProfile, type ResolveDeps, type ProfileChange } from './resolve';

export interface PrepareDeps extends ResolveDeps {
  /** Where the repaired profile is written ✓ */
  userProfilesDir: string;
  /** The log line ✓ (the changes are worth a line each ✓) */
  log?: (message: string) => void;
}

/** The value that is still a placeholder ✓ — `null` when nothing is ✓ */
export function placeholderOf(profile: ConnectionProfile): string | null {
  const options = profile.options;
  const serial = options['serial'];
  if (typeof serial === 'string' && isPlaceholderSerial(serial)) {
    return `the serial ${serial}`;
  }
  const host = options['host'];
  if (typeof host === 'string' && isPlaceholderHost(host)) {
    return `the host ${host} (a documentation address of RFC 5737)`;
  }
  const nested = options['ssh'];
  if (typeof nested === 'object' && nested !== null) {
    const nestedHost = (nested as Record<string, unknown>)['host'];
    if (typeof nestedHost === 'string' && isPlaceholderHost(nestedHost)) {
      return `the address ${nestedHost} (a documentation address of RFC 5737)`;
    }
  }
  return null;
}

/**
 * Does this profile have to be repaired?
 *
 * → **The adb connection** ✓: the pinned serial has to be **really there**
 *   ✓ (a board that was swapped has a different serial ✓).
 * → **The other connections** ✓: only a placeholder counts ✓ (their host
 *   may be perfectly fine ✓).
 */
export function needsRepair(profile: ConnectionProfile, devices: readonly AdbDevice[]): boolean {
  const options = profile.options;
  const serial = options['serial'];
  if (typeof serial === 'string' && serial.length > 0) {
    if (isPlaceholderSerial(serial)) return true;
    if (devices.length > 0 && !devices.some((device) => device.serial === serial)) return true;
  }
  return placeholderOf(profile) !== null;
}

/**
 * Prepare the profile for this machine ✓.
 *
 * → **The repaired profile is written into the user directory** ✓ → the next
 *   start reads the right values ✓ → no detection, no delay ✓.
 * → **The user's own file is never overwritten** ✓ (`persist.ts` ✓).
 */
export async function prepareProfile(
  profile: ConnectionProfile,
  deps: PrepareDeps,
): Promise<ConnectionProfile> {
  const log = deps.log ?? ((message: string) => console.log(message));

  // → **A connection without a board pack is not a board's connection** ✓
  //   (the host's own shell ✓ · **the guest machine** ✓) → it must never get
  //   the board's address ✓ → **the address belongs to the board** ✓.
  if (typeof profile.board_pack !== 'string' || profile.board_pack.length === 0) {
    return profile;
  }

  // ── The adb connection needs the device list to know whether its serial is stale ✓ ──
  const devices =
    profile.transport === 'adb' || placeholderOf(profile) !== null
      ? await listAdbDevices(deps)
      : [];

  if (!needsRepair(profile, devices)) return profile;

  const outcome = await resolveProfile(profile, { ...deps, devices });

  for (const change of outcome.changes) {
    log(`[board] ${profile.id}: ${change.field} "${change.from}" → "${change.to}" (${change.how})`);
  }

  // ── It worked → write it down ✓ ──
  if (outcome.changes.length > 0) {
    const written = persistProfile(outcome.profile, deps.userProfilesDir);
    if (written.written) {
      log(`[board] ${profile.id}: the repaired profile was written to ${written.path}`);
    } else {
      log(`[board] ${profile.id}: ${written.reason ?? 'the profile was not written'}`);
    }
    return outcome.profile;
  }

  // ── It did not work → the message has to say why ✓ ──
  const placeholder = placeholderOf(profile);
  if (placeholder !== null) {
    const reasons = outcome.problems.length > 0 ? outcome.problems.join('; ') : 'nothing was detected';
    throw makeError(
      'CONN_OPEN_FAILED',
      `${profile.id} still carries ${placeholder} — the published profile is a placeholder, the board has to be set up on this machine (${reasons})`,
      { detail: { profileId: profile.id, placeholder, problems: outcome.problems } },
    );
  }
  return profile;
}

/** The changes of a preparation ✓ (for the interface ✓) */
export type { ProfileChange };
