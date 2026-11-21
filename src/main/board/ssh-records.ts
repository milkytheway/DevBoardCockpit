/**
 * **The SSH records of this machine** ✓ — the person's own records ✓.
 *
 * ── Why they are read ──
 *
 * → A connection profile cannot carry the credential of this machine ✓ (it
 *   belongs to the person ✓ · a published repository must not carry it ✓) and
 *   it cannot carry the address of the **guest** either ✓ (the guest is not a
 *   board ✓ — it has an address of its own ✓ · the board's address must
 *   never leak into it ✓).
 * → So the host reads what the person already has ✓: the addresses they
 *   reach over ssh ✓ (`known_hosts` ✓ · `config` ✓) and the private keys
 *   they use ✓ (`~/.ssh` ✓).
 *
 * ── The rule (the same one as everywhere else in this project ✓) ──
 *
 * → **Exactly one candidate → it may be used** ✓ · **several → the person
 *   says which one** ✓ · **none → it is reported** ✓ — never invented ✓
 *   (contract `06` rule 17 ✓).
 *
 * → **The content of a key never enters this module** ✓ — only the path ✓
 *   (the key is read where it is used ✓).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The SSH records of this machine ✓ */
export interface SshRecords {
  /**
   * The addresses the person already reaches over ssh ✓.
   *
   * → From `known_hosts` ✓ and from the `HostName` of the `config` ✓.
   * → **The hashed entries of `known_hosts` carry no address** ✓ → they are
   *   skipped ✓ (there is nothing to read out of them ✓).
   */
  addresses: string[];
  /** The private keys in `~/.ssh` ✓ (the paths ✓ — never the content ✓) */
  keys: string[];
}

/**
 * The addresses of a `known_hosts` file ✓.
 *
 * → The first field of a line is the host ✓ — it can be one name ✓ or
 *   several, separated by commas ✓.
 * → The hashed form (`|1|…`) carries no address ✓ → it is skipped ✓.
 */
export function parseKnownHosts(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const host = line.split(/\s+/)[0] ?? '';
    if (host.length === 0 || host.startsWith('|')) continue;
    for (const part of host.split(',')) {
      const name = part.trim();
      if (name.length === 0) continue;
      if (name.startsWith('[') && name.endsWith(']')) {
        // → `[host]:port` ✓ → the name is the host ✓
        const inner = name.slice(1, -1).replace(/:\d+$/, '');
        if (inner.length > 0 && !out.includes(inner)) out.push(inner);
        continue;
      }
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

/**
 * The addresses of an ssh `config` file ✓.
 *
 * → Only the `HostName` lines count ✓ (the `Host` lines are the **aliases**
 *   ✓ — the person may call the guest "board" ✓ — the address is the
 *   `HostName` ✓).
 */
export function parseSshConfig(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const [key, ...rest] = line.split(/\s+/);
    if (key?.toLowerCase() !== 'hostname') continue;
    const name = rest[0] ?? '';
    if (name.length > 0 && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * The files of `~/.ssh` that are **not** a private key ✓.
 *
 * → `known_hosts` ✓ · `known_hosts.old` ✓ · `config` ✓ · the public keys
 *   (`*.pub` ✓) · the directories ✓.
 */
function isPrivateKey(name: string): boolean {
  if (name.endsWith('.pub')) return false;
  if (name === 'known_hosts' || name.startsWith('known_hosts.')) return false;
  if (name === 'config') return false;
  if (name === 'authorized_keys' || name.startsWith('authorized_keys.')) return false;
  return true;
}

/**
 * Reads the SSH records of a home directory ✓.
 *
 * → A missing `~/.ssh` is **not an error** ✓ — it simply means "this machine
 *   has no ssh records" ✓ (and that is reported where it matters ✓).
 */
export function readSshRecords(home: string): SshRecords {
  const sshDir = join(home, '.ssh');
  if (!existsSync(sshDir)) return { addresses: [], keys: [] };

  const read = (name: string): string => {
    try {
      return readFileSync(join(sshDir, name), 'utf8');
    } catch {
      return '';
    }
  };

  const addresses: string[] = [];
  for (const name of parseKnownHosts(read('known_hosts'))) {
    if (!addresses.includes(name)) addresses.push(name);
  }
  for (const name of parseSshConfig(read('config'))) {
    if (!addresses.includes(name)) addresses.push(name);
  }

  let keys: string[] = [];
  try {
    keys = readdirSync(sshDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isPrivateKey(entry.name))
      .map((entry) => join(sshDir, entry.name))
      .sort();
  } catch {
    keys = [];
  }

  return { addresses, keys };
}
