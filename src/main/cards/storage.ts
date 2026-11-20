import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The storage of a card: **one namespace per card** (contract §6.2).
 *
 * ── The rules ──
 *
 * | Rule | Value |
 * |---|---|
 * | On disk | `<dir>/<cardId>/storage.json` |
 * | Namespace | **per card id** — the cards cannot see each other |
 * | Value | must be **JSON serialisable** |
 * | Limit per key | **64 KB** |
 * | Limit per namespace | **1 MB** |
 * | Key name | must not start with `__` (**reserved for the host**) |
 * | Uninstall | the data is **kept** (contract §6.2) |
 *
 * ── Why the limits live in the host ──
 *
 * A card is written by an AI: it may accidentally (or deliberately) push a
 * huge value into it.
 * **Without a limit one card could fill up the disk of the user** — that is
 * something the host has to shield the user from, not something a card should
 * be trusted to restrain on its own.
 */
export interface StorageResult {
  ok: boolean;
  /** Why it failed (**the reason has to be right** — `reserved_key` does not mean "the value cannot be serialised") */
  reason?: 'quota_exceeded' | 'not_serializable' | 'reserved_key';
}

/** The limit of a single key (bytes) */
export const KEY_LIMIT_BYTES = 64 * 1024;
/** The limit of one namespace (bytes) */
export const NAMESPACE_LIMIT_BYTES = 1024 * 1024;

export class CardStorage {
  /** The namespace of each card (the copy in memory; on disk is its mirror) */
  private readonly cache = new Map<string, Record<string, unknown>>();

  constructor(private readonly deps: { dir: string }) {}

  /** Reads a key */
  get(cardId: string, key: string): unknown {
    const ns = this.namespace(cardId);
    return ns[key];
  }

  /** Writes a key */
  set(cardId: string, key: string, value: unknown): StorageResult {
    // **The `__` prefix is reserved for the host** (contract §6.2) — **the reason code has to say so**:
    // it is not "the value cannot be serialised", it is "you may not use this key name"
    if (key.startsWith('__')) return { ok: false, reason: 'reserved_key' };

    let encoded: string;
    try {
      encoded = JSON.stringify(value);
    } catch {
      return { ok: false, reason: 'not_serializable' };
    }
    if (encoded === undefined) return { ok: false, reason: 'not_serializable' };

    const size = Buffer.byteLength(encoded, 'utf8');
    if (size > KEY_LIMIT_BYTES) return { ok: false, reason: 'quota_exceeded' };

    const ns = { ...this.namespace(cardId) };
    const old = ns[key];
    const before = this.totalBytes(ns);
    const after = before - (old === undefined ? 0 : Buffer.byteLength(JSON.stringify(old) ?? '', 'utf8')) + size;
    if (after > NAMESPACE_LIMIT_BYTES) return { ok: false, reason: 'quota_exceeded' };

    ns[key] = value;
    this.cache.set(cardId, ns);
    this.persist(cardId, ns);
    return { ok: true };
  }

  /** Deletes a key */
  remove(cardId: string, key: string): StorageResult {
    const ns = { ...this.namespace(cardId) };
    if (!(key in ns)) return { ok: true };
    delete ns[key];
    this.cache.set(cardId, ns);
    this.persist(cardId, ns);
    return { ok: true };
  }

  /** All the keys of this namespace */
  keys(cardId: string): string[] {
    return Object.keys(this.namespace(cardId)).sort();
  }

  /** Clears this namespace */
  clear(cardId: string): StorageResult {
    this.cache.set(cardId, {});
    this.persist(cardId, {});
    return { ok: true };
  }

  /** Fetches a namespace (and reads it from disk) */
  private namespace(cardId: string): Record<string, unknown> {
    const cached = this.cache.get(cardId);
    if (cached !== undefined) return cached;
    const file = this.fileOf(cardId);
    let loaded: Record<string, unknown> = {};
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
        if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
          loaded = raw as Record<string, unknown>;
        }
      } catch {
        // **A broken file → treated as empty** (not a reason to crash)
        loaded = {};
      }
    }
    this.cache.set(cardId, loaded);
    return loaded;
  }

  private fileOf(cardId: string): string {
    return join(this.deps.dir, cardId, 'storage.json');
  }

  private persist(cardId: string, ns: Record<string, unknown>): void {
    const file = this.fileOf(cardId);
    mkdirSync(join(this.deps.dir, cardId), { recursive: true });
    writeFileSync(file, JSON.stringify(ns, null, 2), 'utf8');
  }

  private totalBytes(ns: Record<string, unknown>): number {
    let total = 0;
    for (const value of Object.values(ns)) {
      total += Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
    }
    return total;
  }
}
