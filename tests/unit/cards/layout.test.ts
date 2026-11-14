import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LayoutStore } from '../../../src/main/cards/layout';
import {
  defaultUnit,
  emptyLayout,
  normalizeLayout,
  withDensity,
  withUnits,
  type LayoutUnit,
} from '../../../src/shared/layout';

/**
 * 布局的**落盘**（core 轨的部分）。
 *
 * ── 它是什么 ──
 *
 * 「主区摆了哪些卡、每张多大」是**宿主的账**：
 * 契约 §七说「绑定发生处：**布局层**：布局单元记录 `(cardId, connectionId)`」。
 * 卡片不知道自己在哪，页面也不该自己记（刷新就没了）。
 *
 * ── 键是 `(cardId, connectionId)` ──
 *
 * 契约 §7.8：一张卡可以在多条连接上各有一个实例 → 每个实例**各占一格**。
 * 所以只按 `cardId` 记会撞车（两张卡挤进同一格）。
 *
 * ── v3：一个布局，没有视图 ──
 *
 * 主区默认是空的，你从卡片目录里点哪张才摆进来。
 * 旧文件照样读得出来（v1 直接用；v2 取**当前视图**那份——
 * **其余视图的布局会丢**，因为「视图」已经退场了）✓。
 *
 * ── 为什么落盘要「坏了也不抛」 ──
 *
 * 布局文件在用户目录里，可能被写了一半、被人手改坏。
 * **一个文件坏了不该让应用起不来**——那等于用户的布局问题变成了应用的问题。
 * → 读不出来就当空布局（用户重新摆一次），并把坏文件原样留着（不覆盖它，
 * 免得把用户的现场毁掉）。
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
  it('**没有布局文件 → 空布局**（主区空的，你摆）', () => {
    const { file, cleanup } = scene();
    try {
      const store = new LayoutStore({ file, now: () => 1000 });
      const state = store.get();
      expect(state.version).toBe(3);
      expect(state.units).toEqual([]);
      expect(state.density).toBe('comfortable');
    } finally {
      cleanup();
    }
  });

  it('**set 之后 get 等值**（落盘与读回一致）', () => {
    const { file, cleanup } = scene();
    try {
      const store = new LayoutStore({ file, now: () => 1000 });
      store.set({ version: 3, units: [UNIT], density: 'comfortable', updatedAt: 1000 });
      expect(store.get().units).toEqual([UNIT]);
      // **重新开一个 store**（模拟重启）→ 还在
      const again = new LayoutStore({ file, now: () => 2000 });
      expect(again.get().units).toEqual([UNIT]);
    } finally {
      cleanup();
    }
  });

  it('**位置会被记下来**（拖过就不是默认位置了）', () => {
    const { file, cleanup } = scene();
    try {
      const store = new LayoutStore({ file, now: () => 1000 });
      store.set({ version: 3, units: [{ ...UNIT, x: 5, y: 7 }], density: 'comfortable', updatedAt: 1000 });
      expect(store.get().units[0]).toMatchObject({ x: 5, y: 7 });
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

  it('**密度存得住**（全局的，放设置页改）', () => {
    const { file, cleanup } = scene();
    try {
      const store = new LayoutStore({ file, now: () => 1000 });
      store.set(withDensity(emptyLayout(1000), 'compact'));
      expect(new LayoutStore({ file, now: () => 2000 }).get().density).toBe('compact');
    } finally {
      cleanup();
    }
  });
});

describe('布局形状的版本迁移', () => {
  it('**v1 旧文件读得出来**（`{units, updatedAt}`）', () => {
    const { file, cleanup } = scene();
    try {
      writeFileSync(file, JSON.stringify({ units: [UNIT], updatedAt: 1000 }), 'utf8');
      const state = new LayoutStore({ file, now: () => 2000 }).get();
      expect(state.version).toBe(3);
      expect(state.units).toEqual([UNIT]);
    } finally {
      cleanup();
    }
  });

  it('**v2 多视图文件读得出来**（取「当前视图」那份；其余视图的布局不保留）', () => {
    const { file, cleanup } = scene();
    try {
      writeFileSync(
        file,
        JSON.stringify({
          version: 2,
          activeViewId: 'debug',
          units: [UNIT],
          updatedAt: 1000,
          views: [
            { id: 'overview', units: [{ ...UNIT, cardId: 'overview-card' }], config: {} },
            {
              id: 'debug',
              units: [{ ...UNIT, cardId: 'debug-card', x: 6, y: 3 }],
              config: { density: 'compact' },
            },
          ],
        }),
        'utf8',
      );
      const state = new LayoutStore({ file, now: () => 2000 }).get();
      expect(state.version).toBe(3);
      // **当前视图那份**（debug）→ 不是 overview 那份
      expect(state.units).toHaveLength(1);
      expect(state.units[0]).toMatchObject({ cardId: 'debug-card', x: 6, y: 3 });
      // 密度也跟着当前视图来
      expect(state.density).toBe('compact');
    } finally {
      cleanup();
    }
  });

  it('**坏字段回默认、不抛**（坏 units / 坏 density / 坏 updatedAt）', () => {
    const { file, cleanup } = scene();
    try {
      writeFileSync(
        file,
        JSON.stringify({
          version: 3,
          units: 'nope',
          density: 'tiny',
          updatedAt: 'soon',
        }),
        'utf8',
      );
      const state = new LayoutStore({ file, now: () => 2000 }).get();
      expect(state.units).toEqual([]);
      expect(state.density).toBe('comfortable');
      expect(state.updatedAt).toBe(2000);
    } finally {
      cleanup();
    }
  });
});

describe('布局形状的纯函数', () => {
  it('**defaultUnit 用卡片自报的尺寸**（缺省 3×2）', () => {
    expect(defaultUnit('cpu-usage', null, { w: 4, h: 3 })).toMatchObject({ w: 4, h: 3 });
    expect(defaultUnit('cpu-usage', 'board-a')).toMatchObject({
      w: 3,
      h: 2,
      connectionId: 'board-a',
    });
  });

  it('**withUnits / withDensity 不改原来的**', () => {
    const base = emptyLayout(1);
    const next = withUnits(base, [UNIT]);
    expect(next.units).toEqual([UNIT]);
    expect(base.units).toEqual([]);
    expect(withDensity(base, 'compact').density).toBe('compact');
    expect(base.density).toBe('comfortable');
  });

  it('**normalizeLayout 收形状**（只留形状对的单元）', () => {
    const state = normalizeLayout({
      version: 3,
      units: [
        UNIT,
        { cardId: 'x', connectionId: null, x: 'a', y: 0, w: 1, h: 1 },
        { cardId: 42, connectionId: null, x: 0, y: 0, w: 1, h: 1 },
        null,
      ],
      density: 'comfortable',
      updatedAt: 5,
    });
    expect(state.units).toEqual([UNIT]);
  });
});
