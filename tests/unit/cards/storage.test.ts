import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStorage, KEY_LIMIT_BYTES, NAMESPACE_LIMIT_BYTES } from '../../../src/main/cards/storage';

/**
 * 卡片的存储（契约 §6.2）。
 *
 * ── 三条硬约束 ──
 *
 * 1. **每张卡一个命名空间**——卡片之间互不可见。
 * 2. **有配额**——单键 64 KB、一个命名空间 1 MB。
 *    卡片是 AI 写的，它可能不小心塞一个巨大的值；
 *    **没有限额，一张卡就能把用户的磁盘写满**。
 * 3. **键名不得以 `__` 开头**——那是留给宿主的。
 */
function tempStorage(): { storage: CardStorage; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'card-store-'));
  return {
    storage: new CardStorage({ dir }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('卡片存储', () => {
  it('写进去读得出来', () => {
    const { storage, cleanup } = tempStorage();
    try {
      expect(storage.set('cpu-usage', 'zoom', 2)).toEqual({ ok: true });
      expect(storage.get('cpu-usage', 'zoom')).toBe(2);
    } finally {
      cleanup();
    }
  });

  it('**卡之间互不可见**', () => {
    const { storage, cleanup } = tempStorage();
    try {
      storage.set('card-a', 'k', 'A');
      expect(storage.get('card-b', 'k')).toBeUndefined();
      expect(storage.keys('card-b')).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('单键超过 64 KB → quota_exceeded', () => {
    const { storage, cleanup } = tempStorage();
    try {
      const big = 'x'.repeat(KEY_LIMIT_BYTES + 10);
      expect(storage.set('cpu-usage', 'big', big)).toEqual({ ok: false, reason: 'quota_exceeded' });
    } finally {
      cleanup();
    }
  });

  it('命名空间超过 1 MB → quota_exceeded', () => {
    const { storage, cleanup } = tempStorage();
    try {
      const chunk = 'y'.repeat(KEY_LIMIT_BYTES - 100);
      for (let i = 0; i < 20; i += 1) {
        const res = storage.set('cpu-usage', `k${i}`, chunk);
        if (!res.ok) {
          expect(res.reason).toBe('quota_exceeded');
          return;
        }
      }
      throw new Error('额度没有被拦住');
    } finally {
      cleanup();
    }
  });

  it('键名以 `__` 开头 → 拒绝', () => {
    const { storage, cleanup } = tempStorage();
    try {
      expect(storage.set('cpu-usage', '__x', 1).ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('值不能 JSON 序列化 → 拒绝（函数、循环引用）', () => {
    const { storage, cleanup } = tempStorage();
    try {
      expect(storage.set('cpu-usage', 'fn', () => 1)).toEqual({
        ok: false,
        reason: 'not_serializable',
      });
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;
      expect(storage.set('cpu-usage', 'circ', circular).reason).toBe('not_serializable');
    } finally {
      cleanup();
    }
  });

  it('删键与清空', () => {
    const { storage, cleanup } = tempStorage();
    try {
      storage.set('cpu-usage', 'a', 1);
      storage.set('cpu-usage', 'b', 2);
      storage.remove('cpu-usage', 'a');
      expect(storage.keys('cpu-usage')).toEqual(['b']);
      storage.clear('cpu-usage');
      expect(storage.keys('cpu-usage')).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('**重启后还在**（卸载保留数据，契约 §6.2）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'card-store-'));
    try {
      const first = new CardStorage({ dir });
      first.set('cpu-usage', 'zoom', 3);
      // 新的实例 = 重启后
      const second = new CardStorage({ dir });
      expect(second.get('cpu-usage', 'zoom')).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('命名空间上限是 1 MB（别把它写错）', () => {
    expect(NAMESPACE_LIMIT_BYTES).toBe(1024 * 1024);
    expect(KEY_LIMIT_BYTES).toBe(64 * 1024);
  });
});
