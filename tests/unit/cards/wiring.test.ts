import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCardWiring } from '../../../src/main/cards/wiring';
import type { CardPermissions } from '../../../src/main/cards/permissions';

/**
 * 卡片宿主的**接线**。
 *
 * ── 这层为什么要有测试 ──
 *
 * 单个模块都对，接起来还是错的——这不是假设，是本轮真实发生过的事：
 *
 * | 症状 | 哪个模块的错 |
 * |---|---|
 * | 卡片区一片空白 | 外壳 CSP 的 `frame-src`（不在卡片模块里） |
 * | `window.cockpit` 恒 undefined | 注入的 URL 少了实例 id（不在卡片模块里） |
 * | 改了文件卡片就「不合法」 | 接线层传给校验器的 id 名单 |
 *
 * → 单模块测试覆盖不到**接线**，接线要有自己的测试。
 */

interface Fixture {
  roots: string;
  storageDir: string;
  cleanup: () => void;
}

function fixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'card-wiring-'));
  const roots = join(base, 'cards');
  const storageDir = join(base, 'card-storage');
  mkdirSync(join(roots, 'cpu-usage'), { recursive: true });
  writeFileSync(
    join(roots, 'cpu-usage', 'manifest.json'),
    JSON.stringify({
      apiVersion: 'devboard/v1',
      kind: 'Card',
      id: 'cpu-usage',
      name: 'CPU 占用率',
      version: '1.0.0',
      description: '显示 CPU 总占用',
      entry: 'index.html',
      requires: { tags: ['cpu.usage'] },
      layout: { w: 3, h: 2, min_w: 2, min_h: 1 },
      permissions: { read: ['cpu.usage'], write: [] },
      actions: [],
    }),
    'utf8',
  );
  writeFileSync(join(roots, 'cpu-usage', 'index.html'), '<!doctype html><html></html>', 'utf8');
  return { roots, storageDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const PERMS: CardPermissions = { read: ['cpu.usage'], write: [] };

function wiringOf(fx: Fixture, opts: { connectionId?: () => string | null } = {}) {
  return createCardWiring({
    roots: [{ dir: fx.roots, kind: 'user' }],
    runtime: { readings: () => [], subscribe: () => () => undefined },
    broadcast: () => undefined,
    currentConnectionId: opts.connectionId ?? (() => 'board-a'),
    permsFor: () => PERMS,
    storageDir: fx.storageDir,
  });
}

describe('卡片接线 · 规则 2（id 全局唯一）', () => {
  it('**第二次刷新不会把卡片自己判成重名**', () => {
    const fx = fixture();
    try {
      const wiring = wiringOf(fx);
      wiring.refresh();
      expect(wiring.list()[0]?.degraded).toBe(false);
      // **再来一次**——「改了文件就热更新」是核心动作，
      // 而热更新必然触发第二次 refresh
      wiring.refresh();
      expect(wiring.list()[0]?.degraded).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  it('两张卡**真的**重名 → 第二个要报出来', () => {
    const fx = fixture();
    try {
      mkdirSync(join(fx.roots, 'other'), { recursive: true });
      writeFileSync(
        join(fx.roots, 'other', 'manifest.json'),
        JSON.stringify({
          apiVersion: 'devboard/v1',
          kind: 'Card',
          id: 'cpu-usage', // ← **同一个 id**
          name: '另一个',
          version: '1.0.0',
          description: 'x',
          entry: 'index.html',
          permissions: { read: [], write: [] },
          actions: [],
        }),
        'utf8',
      );
      writeFileSync(join(fx.roots, 'other', 'index.html'), '<!doctype html><html></html>', 'utf8');
      const wiring = wiringOf(fx);
      wiring.refresh();
      const degraded = wiring.list().filter((c) => c.degraded);
      expect(degraded.length).toBeGreaterThan(0);
    } finally {
      fx.cleanup();
    }
  });
});

describe('卡片接线 · 会话的生命周期', () => {
  it('连接变了 → **旧实例的会话被关掉**（订阅不会一直挂着）', () => {
    const fx = fixture();
    try {
      let connectionId: string | null = 'board-a';
      const wiring = wiringOf(fx, { connectionId: () => connectionId });
      wiring.refresh();
      const first = wiring.list()[0];
      expect(first).toBeDefined();
      wiring.sessions.open(first!.instanceId, 'cpu-usage', connectionId);

      connectionId = 'board-b';
      const second = wiring.list()[0];
      expect(second?.instanceId).not.toBe(first?.instanceId);
      expect(wiring.sessions.get(first!.instanceId)).toBeUndefined();
    } finally {
      fx.cleanup();
    }
  });
});
