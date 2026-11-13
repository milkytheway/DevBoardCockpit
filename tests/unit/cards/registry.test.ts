import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCardDir, listCardDirs, type CardRoot } from '../../../src/main/cards/roots';
import { CardRegistry } from '../../../src/main/cards/registry';
import { parseManifest, type CardManifest } from '../../../src/main/cards/manifest';
import { validateCard, type CardIssue } from '../../../src/main/cards/validate';

/**
 * 卡片的目录发现与注册表。
 *
 * ── 双根与「用户优先」 ──
 *
 * 卡片有两个根：内置目录（产品自带的）与用户目录（人自己放的）。
 * **同一个 id 两边都有 → 用户目录赢**——用户能**改**内置卡，
 * 这是「卡片即文件」的前提（改文件即生效）。
 *
 * ── 「不合法就保留上一版」 ──
 *
 * agent 写卡写到一半，manifest 可能是坏的。
 * 这时候**不能把卡片从工作台上撤走**——它上一版还是好的，
 * 撤走 = 用户眼睁睁看着自己刚做的仪表消失。
 * → 保留上一版，把问题**记下来**显示出来。
 */

/** 造一张卡的目录（只写 manifest.json） */
function makeCard(root: string, cardId: string, manifest?: Record<string, unknown>): string {
  const dir = join(root, cardId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(
      manifest ?? {
        apiVersion: 'devboard/v1',
        kind: 'Card',
        id: cardId,
        name: cardId,
        version: '1.0.0',
        entry: 'index.html',
        permissions: { read: [], write: [] },
      },
      null,
      2,
    ),
    'utf8',
  );
  return dir;
}

function tempRoots(): { roots: CardRoot[]; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'cards-'));
  const builtin = join(base, 'builtin');
  const user = join(base, 'user');
  mkdirSync(builtin, { recursive: true });
  mkdirSync(user, { recursive: true });
  return {
    roots: [
      { dir: builtin, kind: 'builtin' },
      { dir: user, kind: 'user' },
    ],
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** 注册表用的两个依赖（真解析器 + 真校验器） */
function deps() {
  return {
    loadManifest: (dir: string): CardManifest => {
      const raw = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as unknown;
      return parseManifest(raw, dir);
    },
    validate: (m: CardManifest): CardIssue[] => {
      const r = validateCard(m, {
        availableTags: null,
        availableActions: null,
        installedCardIds: [],
        fileExists: () => true,
      });
      return [...r.errors, ...r.warnings];
    },
  };
}

describe('卡片目录的双根查找', () => {
  it('同一个 id 两边都有 → **用户目录赢**', () => {
    const { roots, cleanup } = tempRoots();
    try {
      makeCard(roots[0].dir, 'cpu-usage');
      makeCard(roots[1].dir, 'cpu-usage');
      const dir = findCardDir(roots, 'cpu-usage');
      expect(dir).toBe(join(roots[1].dir, 'cpu-usage'));
    } finally {
      cleanup();
    }
  });

  it('只有内置根有 → 用内置的', () => {
    const { roots, cleanup } = tempRoots();
    try {
      makeCard(roots[0].dir, 'target-switcher');
      expect(findCardDir(roots, 'target-switcher')).toBe(join(roots[0].dir, 'target-switcher'));
    } finally {
      cleanup();
    }
  });

  it('找不到 → null（**不猜**）', () => {
    const { roots, cleanup } = tempRoots();
    try {
      expect(findCardDir(roots, 'nope')).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('目录里没有 manifest.json → **跳过**，不算一张卡', () => {
    const { roots, cleanup } = tempRoots();
    try {
      mkdirSync(join(roots[1].dir, 'not-a-card'), { recursive: true });
      makeCard(roots[1].dir, 'real-card');
      const list = listCardDirs(roots);
      expect(list.map((c) => c.cardId)).toEqual(['real-card']);
    } finally {
      cleanup();
    }
  });
});

describe('卡片注册表', () => {
  it('刷新：发现卡片；manifest 不合法就**保留上一版**并记下问题', () => {
    const { roots, cleanup } = tempRoots();
    try {
      const dir = makeCard(roots[1].dir, 'cpu-usage');
      const registry = new CardRegistry({ roots, ...deps() });

      // 第一遍：好的
      expect(registry.refresh().map((c) => c.cardId)).toEqual(['cpu-usage']);
      expect(registry.cards()[0]?.issues).toEqual([]);

      // 第二遍：agent 把 manifest 写坏了（apiVersion 不认识 → 规则 1）
      writeFileSync(
        join(dir, 'manifest.json'),
        JSON.stringify({
          apiVersion: 'devboard/v9',
          kind: 'Card',
          id: 'cpu-usage',
          name: 'cpu-usage',
          version: '1.0.1',
          entry: 'index.html',
          permissions: { read: [], write: [] },
        }),
        'utf8',
      );
      const cards = registry.refresh();
      expect(cards).toHaveLength(1);
      // **上一版还在**（不是把卡片撤走）
      expect(cards[0]?.manifest.apiVersion).toBe('devboard/v1');
      // 问题被记下来了
      expect(cards[0]?.issues.length).toBeGreaterThan(0);
      expect(cards[0]?.issues.some((i) => i.rule === 1)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('实例：同一个 (卡片, 连接) 永远同一个 instanceId', () => {
    const { roots, cleanup } = tempRoots();
    try {
      makeCard(roots[1].dir, 'cpu-usage');
      const registry = new CardRegistry({ roots, ...deps() });
      registry.refresh();

      const a = registry.instanceFor('cpu-usage', 'board-adb');
      const b = registry.instanceFor('cpu-usage', 'board-adb');
      expect(b.instanceId).toBe(a.instanceId);

      // 不同连接 → 不同实例（契约 §7.8：连接上下文在 iframe 创建时注入）
      const c = registry.instanceFor('cpu-usage', 'board-serial');
      expect(c.instanceId).not.toBe(a.instanceId);
    } finally {
      cleanup();
    }
  });

  it('实例的 URL 形如 cockpit://card/<uuid>/index.html', () => {
    const { roots, cleanup } = tempRoots();
    try {
      makeCard(roots[1].dir, 'cpu-usage');
      const registry = new CardRegistry({ roots, ...deps() });
      registry.refresh();
      const url = registry.instanceFor('cpu-usage', null).url;
      expect(url).toMatch(/^cockpit:\/\/card\/[0-9a-f-]{36}\/index\.html$/);
    } finally {
      cleanup();
    }
  });

  it('没装的卡 → dirOf 是 null（不猜）', () => {
    const { roots, cleanup } = tempRoots();
    try {
      const registry = new CardRegistry({ roots, ...deps() });
      registry.refresh();
      expect(registry.dirOf('nope')).toBeNull();
    } finally {
      cleanup();
    }
  });
});
