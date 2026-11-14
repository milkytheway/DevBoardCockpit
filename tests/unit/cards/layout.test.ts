import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LayoutStore, type LayoutUnit } from '../../../src/main/cards/layout';
import { unitsForView, viewConfigFor, withViewConfig, withViewUnits } from '../../../src/shared/layout';

/**
 * 布局的**落盘**（core 轨的部分）。
 *
 * ── 为什么布局要有自己的存储 ──
 *
 * 契约 §七说「绑定发生处：**布局层**：布局单元记录 `(cardId, connectionId)`」——
 * 也就是说「哪张卡在哪个格子里」是**宿主的账**，不是卡片的，也不是页面的。
 *
 * ── 为什么落盘要稳 ──
 *
 * 布局是用户**摆出来**的东西（拖了半天）→ 丢了就是白干。
 * 而布局文件是**用户目录里的一个文件**——它可能：
 * - 不存在（第一次跑）→ 空布局
 * - 坏了（写了一半 / 被人手改坏）→ **不能抛**（抛了 = 应用起不来）
 */
function scene(): { file: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'card-layout-'));
  return {
    file: join(base, 'layout.json'),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

const UNIT: LayoutUnit = {
  cardId: 'cpu-usage',
  connectionId: null,
  x: 0,
  y: 0,
  w: 3,
  h: 2,
};

describe('布局存储', () => {
  it('**没有布局文件 → 空布局**（第一次跑）', () => {
    const { file, cleanup } = scene();
    try {
      const store = new LayoutStore({ file, now: () => 1000 });
      expect(store.get().units).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('**set 之后 get 等值**（落盘与读回一致）', () => {
    const { file, cleanup } = scene();
    try {
      const store = new LayoutStore({ file, now: () => 1000 });
      store.set({ units: [UNIT], updatedAt: 1000 });
      expect(store.get().units).toEqual([UNIT]);
      // **重新开一个 store**（模拟重启）→ 还在
      const again = new LayoutStore({ file, now: () => 2000 });
      expect(again.get().units).toEqual([UNIT]);
    } finally {
      cleanup();
    }
  });

  it('**布局文件坏了 → 返回空而且不抛**（不能因为一个文件让应用起不来）', () => {
    const { file, cleanup } = scene();
    try {
      writeFileSync(file, '{ 这不是 JSON', 'utf8');
      const store = new LayoutStore({ file, now: () => 1000 });
      expect(store.get().units).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('**默认单元用 manifest 的 layout.w/h**（缺省 3×2）', () => {
    const { file, cleanup } = scene();
    try {
      const store = new LayoutStore({ file, now: () => 1000 });
      expect(store.defaultFor('cpu-usage', null, { w: 4, h: 3 })).toMatchObject({
        cardId: 'cpu-usage',
        connectionId: null,
        x: 0,
        y: 0,
        w: 4,
        h: 3,
      });
      // 缺省：3×2（契约 §2.4 的默认格）
      expect(store.defaultFor('cpu-usage', 'board-a')).toMatchObject({
        w: 3,
        h: 2,
        connectionId: 'board-a',
      });
    } finally {
      cleanup();
    }
  });

  it('**同一张卡 + 同一连接 = 同一个单元**（布局的键是 `(cardId, connectionId)`）', () => {
    const { file, cleanup } = scene();
    try {
      const store = new LayoutStore({ file, now: () => 1000 });
      const a = store.defaultFor('cpu-usage', 'board-a');
      const b = store.defaultFor('cpu-usage', 'board-a');
      expect(a).toEqual(b);
      // 不同连接 → 不同的单元（契约 §7.8：一张卡在两条连接上各有一个实例）
      expect(store.defaultFor('cpu-usage', 'board-b')).not.toEqual(a);
    } finally {
      cleanup();
    }
  });

  it('**位置会被记下来**（拖过就不是默认位置了）', () => {
    const { file, cleanup } = scene();
    try {
      const store = new LayoutStore({ file, now: () => 1000 });
      store.set({ units: [{ ...UNIT, x: 5, y: 7 }], updatedAt: 1000 });
      expect(store.get().units[0]).toMatchObject({ x: 5, y: 7 });
    } finally {
      cleanup();
    }
  });
});

/**
 * v2：布局按视图各存一份。
 *
 * 旧 v1 文件只有 `{units, updatedAt}` → 落到「总览」，其余视图空。
 * 写出去一律 v2；`units` 是「当前视图」的镜像（旧调用方与 e2e 读它）。
 */
describe('多视图布局', () => {
  it('**v1 旧文件读得出来**（落到总览，不丢格子）', () => {
    const { file, cleanup } = scene();
    try {
      writeFileSync(file, JSON.stringify({ units: [UNIT], updatedAt: 1000 }), 'utf8');
      const state = new LayoutStore({ file, now: () => 2000 }).get();
      expect(state.version).toBe(2);
      expect(state.activeViewId).toBe('overview');
      expect(unitsForView(state, 'overview')).toEqual([UNIT]);
      expect(unitsForView(state, 'debug')).toEqual([]);
      expect(state.units).toEqual([UNIT]);
    } finally {
      cleanup();
    }
  });

  it('**每个视图各存一份**（切视图不互相覆盖）', () => {
    const { file, cleanup } = scene();
    try {
      const store = new LayoutStore({ file, now: () => 1000 });
      const empty = store.get();
      // 总览摆一格、调试摆另一格
      const overview = withViewUnits(empty, 'overview', [UNIT]);
      const both = withViewUnits(overview, 'debug', [
        { cardId: 'cpu-usage', connectionId: null, x: 6, y: 3, w: 4, h: 2 },
      ]);
      store.set(both);

      const again = new LayoutStore({ file, now: () => 2000 }).get();
      expect(unitsForView(again, 'overview')).toEqual([UNIT]);
      expect(unitsForView(again, 'debug')[0]).toMatchObject({ x: 6, y: 3 });
      // 当前视图（最后摆的是 debug）→ units 镜像它
      expect(again.activeViewId).toBe('debug');
      expect(again.units).toEqual(unitsForView(again, 'debug'));
    } finally {
      cleanup();
    }
  });

  it('**坏字段回默认、不抛**（坏 views 回退旧 units；坏 activeViewId 回总览）', () => {
    const { file, cleanup } = scene();
    try {
      writeFileSync(
        file,
        JSON.stringify({ views: 'nope', activeViewId: 42, units: [UNIT] }),
        'utf8',
      );
      const state = new LayoutStore({ file, now: () => 1000 }).get();
      expect(state.version).toBe(2);
      expect(state.activeViewId).toBe('overview');
      // views 坏了，但旧 units 还在 → 按 v1 迁移落到总览，而不是丢掉。
      expect(unitsForView(state, 'overview')).toEqual([UNIT]);
    } finally {
      cleanup();
    }
  });

  it('**视图配置存得住**（隐藏卡 / 密度 / 读数过滤各视图独立）', () => {
    const { file, cleanup } = scene();
    try {
      const store = new LayoutStore({ file, now: () => 1000 });
      const base = store.get();
      const withHidden = withViewConfig(base, 'overview', {
        hidden: ['cpu-curve::conn-1'],
        density: 'compact',
        tagFilter: ['cpu.*', 'gpu.*'],
      });
      store.set(withHidden);

      const again = new LayoutStore({ file, now: () => 2000 }).get();
      expect(viewConfigFor(again, 'overview')).toEqual({
        hidden: ['cpu-curve::conn-1'],
        density: 'compact',
        tagFilter: ['cpu.*', 'gpu.*'],
      });
      // 别的视图没被带上
      expect(viewConfigFor(again, 'debug')).toEqual({});
      // 配置不动布局（units 镜像也不变）
      expect(unitsForView(again, 'overview')).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('**坏配置回默认、不抛**（密度不认/字符串数组混坏值）', () => {
    const { file, cleanup } = scene();
    try {
      writeFileSync(
        file,
        JSON.stringify({
          version: 2,
          activeViewId: 'overview',
          views: [
            {
              id: 'overview',
              units: [UNIT],
              config: {
                hidden: ['cpu-curve::conn-1', 42, '', 'cpu-curve::conn-1'],
                density: 'tiny',
                tagFilter: [' cpu.* ', 'cpu.*', null],
              },
            },
          ],
          updatedAt: 1000,
        }),
        'utf8',
      );
      const config = viewConfigFor(new LayoutStore({ file, now: () => 1000 }).get(), 'overview');
      expect(config.hidden).toEqual(['cpu-curve::conn-1']);
      expect(config.density).toBeUndefined();
      expect(config.tagFilter).toEqual(['cpu.*']);
    } finally {
      cleanup();
    }
  });
});
