import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 卡片的存储：**每张卡一个命名空间**（契约 §6.2）。
 *
 * ── 规则 ──
 *
 * | 规则 | 值 |
 * |---|---|
 * | 落盘 | `<dir>/<cardId>/storage.json` |
 * | 命名空间 | **按卡片 id**——卡片之间互不可见 |
 * | 值 | 必须 **JSON 可序列化** |
 * | 单键上限 | **64 KB** |
 * | 命名空间上限 | **1 MB** |
 * | 键名 | 不得以 `__` 开头（**留给宿主**） |
 * | 卸载 | **保留**数据（契约 §6.2） |
 *
 * ── 为什么限额在宿主 ──
 *
 * 卡片是 AI 写的：它可能不小心（或故意）往里塞一个巨大的值。
 * **没有限额，一张卡就能把用户的磁盘写满**——
 * 这是宿主必须替用户挡住的，不该由卡片自觉。
 */
export interface StorageResult {
  ok: boolean;
  reason?: 'quota_exceeded' | 'not_serializable';
}

/** 单键上限（字节） */
export const KEY_LIMIT_BYTES = 64 * 1024;
/** 一个命名空间的上限（字节） */
export const NAMESPACE_LIMIT_BYTES = 1024 * 1024;

export class CardStorage {
  /** 每张卡的命名空间（内存里的那份，落盘是它的镜像） */
  private readonly cache = new Map<string, Record<string, unknown>>();

  constructor(private readonly deps: { dir: string }) {}

  /** 读一个键 */
  get(cardId: string, key: string): unknown {
    const ns = this.namespace(cardId);
    return ns[key];
  }

  /** 写一个键 */
  set(cardId: string, key: string, value: unknown): StorageResult {
    if (key.startsWith('__')) return { ok: false, reason: 'not_serializable' };

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

  /** 删一个键 */
  remove(cardId: string, key: string): StorageResult {
    const ns = { ...this.namespace(cardId) };
    if (!(key in ns)) return { ok: true };
    delete ns[key];
    this.cache.set(cardId, ns);
    this.persist(cardId, ns);
    return { ok: true };
  }

  /** 这个命名空间的全部键 */
  keys(cardId: string): string[] {
    return Object.keys(this.namespace(cardId)).sort();
  }

  /** 清空这个命名空间 */
  clear(cardId: string): StorageResult {
    this.cache.set(cardId, {});
    this.persist(cardId, {});
    return { ok: true };
  }

  /** 取（并读盘）一个命名空间 */
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
        // **文件坏了 → 当空的**（不是崩溃的理由）
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
