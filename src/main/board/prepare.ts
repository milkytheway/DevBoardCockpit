/**
 * **Preparing a connection for this machine.**
 *
 * ── What this does ──
 *
 * → The **profile** says what the connection is ✓ (the transport ✓ · the
 *   board ✓ · the label ✓).
 * → The **machine-value store** says which machine it reaches ✓ (the serial
 *   number ✓ · the address ✓ · the port ✓ · the private key ✓).
 * → This module **merges** them ✓ and, when a value is missing ✓ or **no
 *   longer true** ✓, **finds** it again ✓ and **writes it down** ✓.
 *
 * ── Why not a copy of the profile in the user directory ──
 *
 * → A copy **overrides the whole profile** ✓ → the next fix to the shipped
 *   profile **never reaches that machine** ✓ → the connection **freezes** ✓
 *   (that is how a stale address survived the very repair meant to replace
 *   it ✓).
 * → The store holds **only the machine-specific fields** ✓ → the shipped
 *   profile stays the truth about the connection ✓.
 *
 * ── The rules ──
 *
 * | # | Rule | Why |
 * |---|---|---|
 * | 1 | **Only a board's connections are detected** ✓ | the guest machine is not on the board's network ✓ → the board cannot say where it is ✓ |
 * | 2 | **A value is verified before it is used** ✓ | an address that is written down proves nothing ✓ (the port has to answer ✓) |
 * | 3 | **A value the person confirmed is never second-guessed** ✓ | it is their decision ✓ — the error says what was tried ✓ |
 * | 4 | **Several candidates → nothing is chosen** ✓ | the same "never guess" as everywhere else ✓ |
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { ConnectionProfile } from '../profiles/schema';
import {
  isPlaceholderHost,
  isPlaceholderSerial,
  probeSerialPorts,
  type PortProbe,
} from './detect';
import { findMachineValues, forgetDetection, type FindDeps } from './find';
import { probeTcp } from './probe';
import { MachineValueStore, type ValueSource } from './machine-values';

export interface PrepareDeps extends FindDeps {
  /** The store ✓ */
  store: MachineValueStore;
  /** The log ✓ */
  log?: (message: string) => void;
  /** The models the board pack accepts ✓ */
  expectedModels?: readonly string[];
}

/** The value of a field is missing or a placeholder ✓ */
function isUnusable(value: unknown, placeholder: boolean): boolean {
  if (typeof value !== 'string' || value.length === 0) return true;
  return placeholder;
}

/** Is this the connection of a board? ✓ (the guest machine is not ✓) */
export function isBoardConnection(profile: ConnectionProfile): boolean {
  return typeof profile.board_pack === 'string' && profile.board_pack.length > 0;
}

/**
 * Does this profile still need a value that only this machine knows? ✓
 *
 * → The **adb** connection needs a serial ✓ · the **ssh** connection needs
 *   an address ✓ and a private key ✓ · the **serial** connection needs a
 *   port ✓.
 * → **A value that is stored is not missing** ✓ — even when it is stale ✓
 *   (a stale value is detected again when the verification finds that it
 *   does not answer ✓).
 * → **The host's own shell** ✓ (`local` ✓) needs nothing ✓ — it is the
 *   host itself ✓.
 */
export function needsValue(
  profile: ConnectionProfile,
  store: MachineValueStore,
): boolean {
  const stored = store.get(profile.id);
  const options = profile.options;
  switch (profile.transport) {
    case 'adb':
      // → **Only a board's connections have a serial number** ✓.
      if (!isBoardConnection(profile)) return false;
      return (
        stored['serial'] === undefined &&
        isUnusable(options['serial'], isPlaceholderSerial(String(options['serial'] ?? '')))
      );
    case 'ssh':
      return (
        (stored['host'] === undefined &&
          isUnusable(options['host'], isPlaceholderHost(String(options['host'] ?? '')))) ||
        (stored['key_filename'] === undefined && stored['password'] === undefined)
      );
    case 'serial':
      // → **Only a board's connections have a console** ✓.
      if (!isBoardConnection(profile)) return false;
      return stored['port'] === undefined && isUnusable(options['port'], false);
    default:
      return false;
  }
}

/**
 * The fields of one transport ✓ — **only those are stored** ✓.
 *
 * → The adb connection stores the serial number ✓ · the ssh connection the
 *   address ✓ the key ✓ the user name ✓ · the serial connection the port ✓.
 * → **Nothing else** ✓ (a value that another transport does not use is
 *   noise ✓).
 */
export function fieldsOf(
  transport: ConnectionProfile['transport'],
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  switch (transport) {
    case 'adb':
      if (patch['serial'] !== undefined) out['serial'] = patch['serial'];
      break;
    case 'ssh':
      for (const field of ['host', 'key_filename', 'username', 'port'] as const) {
        if (patch[field] !== undefined) out[field] = patch[field];
      }
      break;
    case 'serial':
      if (patch['port'] !== undefined) out['port'] = patch['port'];
      break;
    default:
      break;
  }
  return out;
}

/**
 * **Is the stored value still true?** ✓
 *
 * → **A value that is written down proves nothing** ✓ → the address has to
 *   answer ✓ → the port has to answer ✓.
 * → **A value the person confirmed is never second-guessed** ✓ (it is their
 *   decision ✓ — the error message names what was tried ✓).
 * → **A detected value that does not answer is detected again** ✓ → that is
 *   how a stale value stops being used ✓ (**the freeze is broken** ✓).
 */
export async function staleValue(
  profile: ConnectionProfile,
  store: MachineValueStore,
  deps: PrepareDeps,
): Promise<boolean> {
  if (profile.transport === 'local') return false;
  const stored = store.get(profile.id);
  if (profile.transport === 'ssh') {
    const entry = stored['host'];
    if (entry === undefined || entry.source === 'confirmed') return false;
    const host = typeof entry.value === 'string' ? entry.value : '';
    if (host.length === 0) return false;
    const port = Number(profile.options['port'] ?? 22);
    const probe = deps.probe ?? ((h: string, p: number) => probeTcp(h, p, 1500));
    const result = await probe(host, port);
    return !result.ok;
  }
  if (profile.transport === 'serial') {
    const entry = stored['port'];
    if (entry === undefined || entry.source === 'confirmed') return false;
    if (deps.ports === undefined) return false;
    const port = typeof entry.value === 'string' ? entry.value : '';
    if (port.length === 0) return false;
    const { answering, busy } = await probeSerialPorts(
      [{ path: port }],
      Number(profile.options['baudrate'] ?? 1500000),
      deps.ports,
    );
    // → **A busy port is not a stale port** ✓ (another program holds it ✓).
    if (busy.includes(port)) return false;
    return !answering.includes(port);
  }
  return false;
}

/**
 * Fill in what this machine knows ✓ and merge it into the profile ✓.
 *
 * → **The store wins** for the machine-specific fields ✓ (it is the truth
 *   about this machine ✓) · **the profile wins** for everything else ✓.
 * → **A value that is missing is found** ✓ → written into the store ✓
 *   (source `detected` ✓) → used ✓.
 * → **A value that no longer answers is found again** ✓ (the stale value is
 *   replaced ✓ — **that is what breaks the freeze** ✓).
 * → **What could not be found is reported** ✓ — the person has to see it ✓.
 */
export async function prepareProfile(
  profile: ConnectionProfile,
  deps: PrepareDeps,
): Promise<{ profile: ConnectionProfile; problems: string[]; changes: string[] }> {
  const log = deps.log ?? ((message: string) => console.log(message));
  const problems: string[] = [];
  const changes: string[] = [];

  // ── The store is the truth about this machine ✓ ──
  const stored = deps.store.get(profile.id);
  const options: Record<string, unknown> = { ...profile.options };
  for (const [field, entry] of Object.entries(stored)) {
    options[field] = entry.value;
  }

  // ── Is a value missing **or stale**? ✓ ──
  const missing = needsValue(profile, deps.store);
  const stale = missing ? false : await staleValue(profile, deps.store, deps);
  if (missing || stale) {
    if (stale) {
      log(`[board] ${profile.id}: the stored value does not answer any more → detecting again`);
    }
    const found = await findMachineValues({
      ...deps,
      force: stale,
      // → **A board says where it is** ✓ · **a machine that is not a board**
      //   cannot say ✓ → its candidates come from the user's own records ✓.
      kind: isBoardConnection(profile) ? 'board' : 'machine',
      expectedModels: deps.expectedModels ?? [],
      homeDir: deps.homeDir ?? homedir(),
    });
    // → **Only the fields of this transport are stored** ✓ (the adb
    //   connection has no port ✓ · the ssh connection has no serial ✓).
    const patch = fieldsOf(profile.transport, found.patch);
    if (Object.keys(patch).length > 0) {
      deps.store.set(profile.id, patch, 'detected');
      for (const [field, value] of Object.entries(patch)) {
        options[field] = value;
        const reason = found.reasons[field] ?? 'detected';
        changes.push(`${field} → ${String(value)} (${reason})`);
        log(`[board] ${profile.id}: ${field} → ${String(value)} (${reason})`);
      }
      // → **The next detection starts fresh** ✓ (the world may have changed ✓).
      forgetDetection();
    }
    // → **The address of the board is also the address the guest uses** ✓
    //   (`options.ssh.host` ✓ — the guest reaches the board through it ✓) →
    //   it is filled in for the other transports too ✓.
    if (patch['host'] !== undefined) {
      const nested = options['ssh'];
      if (typeof nested === 'object' && nested !== null) {
        options['ssh'] = {
          ...(nested as Record<string, unknown>),
          host: patch['host'],
        };
      }
    }
    problems.push(...found.problems);
  }

  const merged: ConnectionProfile = { ...profile, options };
  return { profile: merged, problems, changes };
}

/**
 * Write the values the person confirmed ✓.
 *
 * → **The store** ✓ (not a profile copy ✓ — the shipped profile stays the
 *   truth about the connection ✓).
 * → The source is `confirmed` ✓ → it wins over a detected value ✓.
 */
export function confirmValues(
  store: MachineValueStore,
  profileId: string,
  values: Record<string, unknown>,
  source: ValueSource = 'confirmed',
): void {
  store.set(profileId, values, source);
}

/** Does the file exist? ✓ (the private key must be there ✓) */
export function keyExists(path: string): boolean {
  return existsSync(path);
}

/** The serial ports of this machine ✓ (injected in the tests ✓) */
export type { PortProbe };
