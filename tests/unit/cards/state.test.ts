import { describe, it, expect } from 'vitest';
import {
  cardState,
  missingTags,
  unreadableTags,
  patternCovered,
} from '../../../src/main/cards/state';
import type { CardManifest } from '../../../src/main/cards/manifest';
import type { PackView } from '../../../src/main/tags/pack-view';
import type { TagReading } from '../../../src/shared/tag-reading';

/**
 * **卡片在当前板上的状态**（契约 `spec/04` §2.2 ✓ · ADR-D40 ✓）。
 *
 * ── 这组判据守住的核心 ──
 *
 * | 判据 | 为什么 |
 * |---|---|
 * | `missing_tags` 与 `unreadable_tags` **分开** | 混在一起 → **agent 被骗** ✓ |
 * | **通配实例在读数里缺席 → 不算 missing** | 采样器**不猜具体实例名** ✓ |
 * | `invalid` 的卡**仍然列出来** | agent 要知道「我上次装的那张卡坏了」✓ |
 * | `installed_at` 是**目录 mtime** | 宿主**从没记过安装时间** ✓ |
 */

const MANIFEST: CardManifest = {
  apiVersion: 'devboard/v1',
  kind: 'Card',
  id: 'demo',
  name: '演示卡',
  version: '1.0.0',
  entry: 'index.html',
  permissions: { read: ['cpu.usage', 'mem.usage'], write: [] },
};

const PACK: PackView = {
  id: 'demo-pack',
  name: '演示包',
  version: '1.0.0',
  poll_groups: [],
  readers: [
    {
      id: 'cpu',
      kind: 'proc_stat',
      args: {},
      provides: ['cpu.usage'],
      poll_group: 'fast',
      interval_ms: 1000,
    },
    {
      id: 'mem',
      kind: 'meminfo',
      args: {},
      provides: ['mem.usage'],
      poll_group: 'fast',
      interval_ms: 1000,
    },
  ],
  actions: [],
};

function reading(tag: string, status: TagReading['status'], value: number | null = 1): TagReading {
  return { tag, value, unit: '%', status, at: 1000, seq: 1 };
}

describe('卡片状态 · 模式覆盖判定', () => {
  it('**通配的一侧覆盖字面的一侧** ✓', () => {
    expect(patternCovered('cpu.*.usage', 'cpu.core.usage')).toBe(true);
    expect(patternCovered('cpu.core.usage', 'cpu.core.usage')).toBe(true);
  });

  it('**段数不同 → 不覆盖** ✓', () => {
    expect(patternCovered('cpu.core.*.usage', 'cpu.usage')).toBe(false);
  });

  it('**字面不同 → 不覆盖** ✓', () => {
    expect(patternCovered('cpu.usage', 'mem.usage')).toBe(false);
  });
});

describe('卡片状态 · missing_tags（板上根本没有）', () => {
  it('**包里有的 → 不算缺** ✓', () => {
    expect(missingTags(MANIFEST, PACK)).toEqual([]);
  });

  it('**包里没有的 → 记进去** ✓（记模式本身 ✓）', () => {
    const manifest: CardManifest = {
      ...MANIFEST,
      permissions: { read: ['cpu.usage', 'npu.usage'], write: [] },
    };
    expect(missingTags(manifest, PACK)).toEqual(['npu.usage']);
  });

  it('**通配的读权限 → 被包提供 → 不算缺** ✓', () => {
    const manifest: CardManifest = {
      ...MANIFEST,
      permissions: { read: ['cpu.core.*.usage'], write: [] },
    };
    const pack: PackView = {
      ...PACK,
      readers: [{ ...(PACK.readers[0] as PackView['readers'][number]), provides: ['cpu.core.*.usage'] }],
    };
    expect(missingTags(manifest, pack)).toEqual([]);
  });

  it('**没有包 → 不判「板上根本没有」** ✓（那是「还不知道」✓ 不是「没有」✓）', () => {
    expect(missingTags(MANIFEST, null)).toEqual([]);
  });
});

describe('卡片状态 · unreadable_tags（现在读不出来）', () => {
  it('**状态不是 ok 的 → 记进去** ✓', () => {
    const readings = [reading('cpu.usage', 'error', null), reading('mem.usage', 'ok')];
    expect(unreadableTags(MANIFEST, PACK, readings)).toEqual(['cpu.usage']);
  });

  it('**这张卡不读的 → 不记** ✓', () => {
    const readings = [reading('gpu.usage', 'error', null)];
    expect(unreadableTags(MANIFEST, PACK, readings)).toEqual([]);
  });

  it('**通配实例在读数里缺席 → 不列** ✓（那是「板上就没有 / 还没采到」✓）', () => {
    const manifest: CardManifest = {
      ...MANIFEST,
      permissions: { read: ['cpu.core.*.usage'], write: [] },
    };
    // **读数里只有 cpu.core.0.usage（ok）** —— cpu.core.7.usage **不在**读数里 ✓
    const readings = [reading('cpu.core.0.usage', 'ok')];
    expect(unreadableTags(manifest, PACK, readings)).toEqual([]);
  });

  it('**stale 也算「读不出来」** ✓（拿到的是旧值 ✓ ≠ 现在读得到 ✓）', () => {
    const readings = [reading('cpu.usage', 'stale', 5)];
    expect(unreadableTags(MANIFEST, PACK, readings)).toEqual(['cpu.usage']);
  });
});

describe('卡片状态 · 整体', () => {
  const base = {
    cardId: 'demo',
    dir: '/tmp/cards/demo',
    manifest: MANIFEST,
    issues: [],
    pack: PACK,
    readings: [] as TagReading[],
  };

  it('**干净 → `ok`** ✓', () => {
    const state = cardState(base);
    expect(state.status).toBe('ok');
    expect(state.degraded).toBe(false);
    expect(state.missing_tags).toEqual([]);
    expect(state.unreadable_tags).toEqual([]);
  });

  it('**有 tag 读不到 → `degraded`** ✓', () => {
    const state = cardState({ ...base, readings: [reading('mem.usage', 'error', null)] });
    expect(state.status).toBe('degraded');
    expect(state.degraded).toBe(true);
    expect(state.unreadable_tags).toEqual(['mem.usage']);
  });

  it('**manifest 不合法 → `invalid`** ✓（**但它仍然被列出来** ✓）', () => {
    const state = cardState({ ...base, issues: [{ severity: 'error' }] });
    expect(state.status).toBe('invalid');
    expect(state.id).toBe('demo');
  });

  it('**只有警告 → `degraded`** ✓', () => {
    const state = cardState({ ...base, issues: [{ severity: 'warning' }] });
    expect(state.status).toBe('degraded');
  });

  it('**`id` 是目录名、`manifest_id` 是 manifest 声明的** ✓（两者可以不同 ✓）', () => {
    const state = cardState({ ...base, cardId: 'demo-dir', manifest: { ...MANIFEST, id: 'demo' } });
    expect(state.id).toBe('demo-dir');
    expect(state.manifest_id).toBe('demo');
  });

  it('**`path` 是绝对路径** ✓', () => {
    expect(cardState(base).path).toBe('/tmp/cards/demo');
  });

  it('**`installed_at` 是目录 mtime** ✓（**不是**「装上的时刻」✓）', () => {
    // **目录不存在 → 0** ✓（不猜 ✓）
    expect(cardState(base).installed_at).toBe(0);
  });
});
