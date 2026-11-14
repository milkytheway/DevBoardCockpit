import { describe, it, expect } from 'vitest';
import type { CardInstanceInfo } from '../../src/shared/ipc-contract';
import type { LayoutUnit } from '../../src/shared/layout';
import { resolveLayout, slotKey, splitKey } from '../../src/renderer/shell/layout-utils';

function card(cardId: string, connectionId: string | null = null): CardInstanceInfo {
  return {
    instanceId: `${cardId}-${connectionId ?? 'none'}`,
    cardId,
    url: `cockpit://card/${cardId}-${connectionId ?? 'none'}/index.html`,
    connectionId,
    degraded: false,
  };
}

function overlaps(a: LayoutUnit, b: LayoutUnit): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe('外壳 · 栅格槽位键', () => {
  it('cardId 和 connectionId 都能从键里还原（含未连接）', () => {
    expect(splitKey(slotKey('cpu-curve', 'conn-1'))).toEqual({
      cardId: 'cpu-curve',
      connectionId: 'conn-1',
    });
    expect(splitKey(slotKey('cpu-curve', null))).toEqual({
      cardId: 'cpu-curve',
      connectionId: null,
    });
  });
});

describe('外壳 · 布局兜底（main 给每张卡都返回一个格子）', () => {
  it('多张从未移动过的卡不能叠在 (0,0)', () => {
    const cards = [card('b-card'), card('a-card'), card('c-card')];
    const units: LayoutUnit[] = cards.map((item) => ({
      cardId: item.cardId,
      connectionId: item.connectionId,
      x: 0,
      y: 0,
      w: 4,
      h: 2,
    }));
    const placed = resolveLayout(cards, units);
    expect(placed).toHaveLength(3);
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        expect(overlaps(placed[i], placed[j]), `${placed[i].cardId} 与 ${placed[j].cardId} 重叠`).toBe(false);
      }
    }
  });

  it('已有格子原样保留（用户的布局优先）', () => {
    const cards = [card('cpu-curve')];
    const units: LayoutUnit[] = [{ cardId: 'cpu-curve', connectionId: null, x: 6, y: 4, w: 5, h: 3 }];
    expect(resolveLayout(cards, units)).toEqual(units);
  });

  it('没有格子的卡补默认格子（**默认尺寸只有一处**：shared 的 defaultUnit）', () => {
    const placed = resolveLayout([card('new-card')], []);
    expect(placed[0]).toMatchObject({ cardId: 'new-card', x: 0, y: 0, w: 3, h: 2 });
  });

  it('按 cardId 稳定排序（同一份输入渲染顺序一致）', () => {
    const cards = [card('b'), card('a')];
    const placed = resolveLayout(cards, []);
    expect(placed.map((unit) => unit.cardId)).toEqual(['a', 'b']);
  });
});
