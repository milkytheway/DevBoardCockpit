import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * **The host keys of this machine** ✓ — trust on first use ✓.
 *
 * ── Why it is here at all ──
 *
 * → A successful authentication proves **"the credential was accepted"** ✓ —
 *   it does **not** prove **"the other side is the board"** ✓ → on a shared
 *   network somebody else could take the place of the board ✗ (a
 *   man-in-the-middle ✓).
 * → So the host checks the **key of the other side** ✓ → the first time it
 *   sees a host it **remembers** the key ✓ (trust on first use ✓) → the next
 *   time the key has to be **the same** ✓ → otherwise the connection is
 *   refused ✓.
 *
 * ── Why the store is **the host's own** and not `~/.ssh/known_hosts` ──
 *
 * → The application is **not** ssh ✓ → it must not write into the person's
 *   ssh configuration ✗ (that is the person's file ✓ · the person's
 *   `known_hosts` is for their ssh ✓).
 * → → **The keys live in the user data directory** ✓ ✓.
 */
export interface HostKeyStore {
  /** The key we know for this host ✓ (`undefined` = we know none ✓) */
  known(host: string, port: number): string | undefined;
  /** **Remembers** the key of a host ✓ (the first time ✓) */
  remember(host: string, port: number, key: string): void;
}

interface HostKeyFile {
  [key: string]: string;
}

/** The key of a host ✓ (`host:port` ✓ — the port is part of the name ✓) */
function keyOf(host: string, port: number): string {
  return `${host}:${port}`;
}

/** A store that keeps the keys in a file ✓ (the host's own data directory ✓) */
export class FileHostKeyStore implements HostKeyStore {
  private cache: HostKeyFile | undefined;

  constructor(private readonly file: string) {}

  known(host: string, port: number): string | undefined {
    return this.read()[keyOf(host, port)];
  }

  remember(host: string, port: number, key: string): void {
    const all = this.read();
    all[keyOf(host, port)] = key;
    this.write(all);
  }

  private read(): HostKeyFile {
    if (this.cache !== undefined) return this.cache;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      parsed = {};
    }
    this.cache = typeof parsed === 'object' && parsed !== null ? (parsed as HostKeyFile) : {};
    return this.cache;
  }

  private write(all: HostKeyFile): void {
    this.cache = all;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8');
      renameSync(tmp, this.file);
    } catch {
      // → **A store that cannot be written is not fatal** ✓ (the connection
      //   works ✓ — the host simply has to be trusted again next time ✓).
    }
  }
}

/** A store that keeps nothing ✓ (the tests ✓) */
export class MemoryHostKeyStore implements HostKeyStore {
  private readonly keys = new Map<string, string>();

  known(host: string, port: number): string | undefined {
    return this.keys.get(keyOf(host, port));
  }

  remember(host: string, port: number, key: string): void {
    this.keys.set(keyOf(host, port), key);
  }
}

/** Is the file there? (the diagnostics ✓) */
export function hostKeyFileExists(file: string): boolean {
  return existsSync(file);
}
