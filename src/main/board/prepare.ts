/**
 * **Preparing a connection for this machine.**
 *
 * ── The one job of this module ──
 *
 * A published profile carries **placeholders** for the values that only one
 * machine knows (the board's serial number ✓ · its address ✓ · the serial
 * port its console is on ✓ · **the credential** ✓). Before a connection is
 * built, those values are **detected** ✓ and the repaired profile is
 * **written into the user directory** ✓ → from then on the application reads
 * the right values ✓ (the user's copy wins ✓).
 *
 * ── When nothing is wrong, nothing happens ──
 *
 * → A profile whose values are real is **not touched** ✓ → no adb call, no
 *   write, no delay ✓.
 *
 * ── When it cannot be repaired, it says so ──
 *
 * → The old message was "cannot reach the SSH host 192.0.2.100:22" ✓ — a
 *   **documented address** ✓ that the user cannot reach because **it is not a
 *   board** ✓ → the message has to name the placeholder ✓.
 *
 * ── What "broken" means ✓ (the rules of this project ✓) ──
 *
 * | What | Why it is broken |
 * |---|---|
 * | the address is a **placeholder** | it is a documentation address ✓ — it can never be a board ✓ |
 * | the address **does not answer** | a value that looks plausible but is wrong is invisible to a "is it a placeholder" check ✓ (found on 2026-11-21 ✓) |
 * | the machine's address is **not among the ssh records** | the guest's address is the person's own ✓ — the board's address must never leak into it ✓ |
 * | the **credential is missing** | without a key or a password the ssh handshake cannot succeed ✓ — and the failure then says "cannot reach", which sends the user looking for a network problem that does not exist ✓ |
 * | the adb serial is **stale** | the board was swapped ✓ |
 */
import { makeError } from '../../shared/errors';
import type { BoardValues } from '../../shared/board-setup';
import type { ConnectionProfile } from '../profiles/schema';
import {
  isPlaceholderHost,
  isPlaceholderSerial,
  listAdbDevices,
  type AdbDevice,
} from './detect';
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
  // → **The serial port of this machine is not known yet** ✓ → the shipped
  //   profile names **no** port ✓ (the COM port of the machine that wrote it
  //   must not travel with the repository ✓) → the board setup finds it ✓
  //   ("a port that answers is the console" ✓).
  if (profile.transport === 'serial') {
    const port = options['port'];
    if (typeof port === 'string' && port.length === 0) {
      return 'the serial port';
    }
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

/** The ssh endpoint of this profile ✓ (`options.host` ✓ or `options.ssh.host` ✓) */
function sshEndpoint(
  profile: ConnectionProfile,
): { host: string; port: number } | null {
  const options = profile.options;
  if (profile.transport === 'ssh') {
    const host = options['host'];
    if (typeof host !== 'string' || host.length === 0) return null;
    return { host, port: Number(options['port'] ?? 22) };
  }
  const nested = options['ssh'];
  if (typeof nested !== 'object' || nested === null) return null;
  const ssh = nested as Record<string, unknown>;
  const host = ssh['host'];
  if (typeof host !== 'string' || host.length === 0) return null;
  return { host, port: Number(ssh['port'] ?? 22) };
}

/**
 * **Does the address of this profile still answer?** ✓
 *
 * → A stored address that does not answer is **re-detected** ✓ → the freeze
 *   of a connection is broken ✓ (a plausible but wrong address was invisible
 *   to the "is it a placeholder" check ✓ — found on 2026-11-21 ✓).
 *
 * → **The host that did not answer is returned** ✓ → the resolver does not
 *   probe it a second time ✓ (a host that does not answer costs the whole
 *   timeout ✓).
 */
async function addressIsDead(
  profile: ConnectionProfile,
  deps: ResolveDeps,
): Promise<string | null> {
  if (deps.probeAddress === undefined) return null;
  const endpoint = sshEndpoint(profile);
  if (endpoint === null) return null;
  if (isPlaceholderHost(endpoint.host)) return null;
  if (await deps.probeAddress(endpoint.host, endpoint.port)) return null;
  return endpoint.host;
}

/**
 * **Is the address of this machine one this machine reaches?** ✓
 *
 * → A machine that is **not a board** ✓ (the guest ✓) has an address of its
 *   own ✓ → it comes from the person's ssh records ✓ → an address that is
 *   not among them is **not this machine** ✓ (the board's address landed
 *   there on 2026-11-21 ✓).
 * → **The resolution does this** ✓ (`resolve.ts` ✓ · `resolveMachineAddress`
 *   ✓) → the function lives there ✓ (one place ✓).
 */

/** **Is the credential missing?** ✓ (without one the handshake cannot succeed ✓) */
function credentialIsMissing(profile: ConnectionProfile): boolean {
  if (profile.transport !== 'ssh') return false;
  const options = profile.options;
  const key = options['key_filename'];
  if (typeof key === 'string' && key.length > 0) return false;
  const password = options['password'];
  if (typeof password === 'string' && password.length > 0) return false;
  return true;
}

/**
 * Prepare the profile for this machine ✓.
 *
 * → The repaired profile is written into the user directory ✓ → the next
 *   start reads the right values ✓ → no detection, no delay ✓.
 * → **The user's own values are kept** ✓ — only the fields that are broken
 *   are replaced ✓ (the repair writes the whole file ✓, but the file it
 *   writes carries the person's own values for everything else ✓).
 */
export async function prepareProfile(
  profile: ConnectionProfile,
  deps: PrepareDeps,
): Promise<ConnectionProfile> {
  const log = deps.log ?? ((message: string) => console.log(message));

  const isBoard = typeof profile.board_pack === 'string' && profile.board_pack.length > 0;

  // → **A connection without a board pack is not a board's connection** ✓
  //   (the host's own shell ✓ · **the guest machine** ✓) → it must never get
  //   the board's address ✓ → **the address belongs to the board** ✓.
  //   → But it does have **its own** machine-specific values ✓ (the address
  //   of the guest ✓ · its credential ✓) → those are resolved here ✓.
  if (!isBoard) {
    if (profile.transport !== 'ssh') return profile;
    const machine = await resolveProfile(profile, { ...deps, devices: [] });
    for (const change of machine.changes) {
      log(`[board] ${profile.id}: ${change.field} "${change.from}" → "${change.to}" (${change.how})`);
    }
    if (machine.changes.length > 0) {
      const written = persistProfile(machine.profile, deps.userProfilesDir, { overwrite: true });
      if (written.written) {
        log(`[board] ${profile.id}: the repaired profile was written to ${written.path}`);
      }
    }
    return machine.profile;
  }

  // ── The adb connection needs the device list to know whether its serial is stale ✓ ──
  const devices =
    profile.transport === 'adb' || placeholderOf(profile) !== null
      ? await listAdbDevices(deps)
      : [];

  const dead = await addressIsDead(profile, deps);
  const broken =
    needsRepair(profile, devices) || dead !== null || credentialIsMissing(profile);
  if (!broken) return profile;

  const outcome = await resolveProfile(profile, { ...deps, devices, deadHost: dead });

  for (const change of outcome.changes) {
    log(`[board] ${profile.id}: ${change.field} "${change.from}" → "${change.to}" (${change.how})`);
  }

  // ── It worked → write it down ✓ ──
  if (outcome.changes.length > 0) {
    const written = persistProfile(outcome.profile, deps.userProfilesDir, { overwrite: true });
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

/**
 * **Fill the values the person confirmed** ✓.
 *
 * → The detection found them ✓ (or the person typed them ✓) → they go into
 *   the profile ✓ → **only the fields that belong to that transport** ✓
 *   (the adb connection has no port ✓ · the ssh connection has no serial ✓).
 * → The nested address ✓ (`options.ssh.host` ✓ — the guest reaches the board
 *   through it ✓) is filled in for **every** connection of the board ✓.
 */
export function applyValues(profile: ConnectionProfile, values: BoardValues): ConnectionProfile {
  // → **A connection without a board pack is not a board's connection** ✓
  //   (the host's own shell ✓ · **the guest machine** ✓) → it keeps its own
  //   address ✓ → **the address belongs to the board** ✓.
  if (typeof profile.board_pack !== 'string' || profile.board_pack.length === 0) {
    return profile;
  }
  const options: Record<string, unknown> = { ...profile.options };
  if (profile.transport === 'adb' && values.adbSerial.length > 0) {
    options['serial'] = values.adbSerial;
  }
  if (profile.transport === 'ssh' && values.address.length > 0) {
    options['host'] = values.address;
  }
  // → **The credential** ✓ (the ssh transport only ✓ — the adb connection has
  //   no key ✓ · the serial connection has none either ✓).
  if (profile.transport === 'ssh' && values.keyFilename.length > 0) {
    options['key_filename'] = values.keyFilename;
  }
  if (profile.transport === 'serial' && values.serialPort.length > 0) {
    options['port'] = values.serialPort;
  }
  const nested = options['ssh'];
  if (typeof nested === 'object' && nested !== null && values.address.length > 0) {
    options['ssh'] = { ...(nested as Record<string, unknown>), host: values.address };
  }
  return { ...profile, options };
}

/** The changes of a preparation ✓ (for the interface ✓) */
export type { ProfileChange };
