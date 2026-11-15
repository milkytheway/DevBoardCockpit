import { describe, it, expect } from 'vitest';
import { promoteCard } from '../../../src/main/mcp/promote';
import type { LayoutState } from '../../../src/shared/layout';

/**
 * **把一张卡提为全屏**（契约 `spec/04` §2.5 ✓ · ADR-D40 ✓）。
 *
 * ── 这组判据守什么 ──
 *
 * | 判据 | 为什么 |
 * |---|---|
 * | **宿主只记「谁要全屏」** ✓ | **铺满几行只有 renderer 知道** ✓（行高是渲染层的常量 ✓）→ 宿主**不猜** ✓ |
 * | **别的格不动** ✓ | **让开是渲染层的事** ✓ —— 宿主改了布局就**毁掉用户的排布** ✗ |
 * | **多于一个实例 → 报错** ✓ | **不猜** ✓ |
 * | **找不到 → `not_found`** ✓ | |
 */
function layout(units: LayoutState['units']): LayoutState {
  return { version: 3, units, density: 'comfortable', promoted: null, updatedAt: 0 };
}

describe('MCP · promote_card', () => {
  it('**记下「谁要全屏」** ✓（**宿主不猜铺几行** ✓ —— 那只有 renderer 知道 ✓）', () => {
    const res = promoteCard(
      layout([{ cardId: 'a', connectionId: null, x: 2, y: 3, w: 4, h: 2 }]),
      'a',
      undefined,
    );
    expect(res.ok).toBe(true);
    expect(res.mode).toBe('fullscreen');
    expect(res.layout?.promoted?.cardId).toBe('a');
    expect(res.layout?.promoted?.connectionId).toBeNull();
  });

  it('**别的格一个都不动** ✓（**让开是渲染层的事** ✓ —— 宿主改了就是毁用户排布 ✗）', () => {
    const res = promoteCard(
      layout([
        { cardId: 'a', connectionId: null, x: 0, y: 0, w: 4, h: 2 },
        { cardId: 'b', connectionId: null, x: 6, y: 1, w: 3, h: 2 },
      ]),
      'a',
      undefined,
    );
    const other = res.layout?.units.find((u) => u.cardId === 'b');
    expect(other?.x).toBe(6);
    expect(other?.y).toBe(1);
    expect(other?.w).toBe(3);
    expect(other?.h).toBe(2);
  });

  it('**格子的数量不变** ✓（**不删、不隐藏** ✓ —— 布局模型里没那个概念 ✓）', () => {
    const res = promoteCard(
      layout([
        { cardId: 'a', connectionId: null, x: 0, y: 0, w: 4, h: 2 },
        { cardId: 'b', connectionId: null, x: 6, y: 0, w: 3, h: 2 },
      ]),
      'a',
      undefined,
    );
    expect(res.layout?.units).toHaveLength(2);
  });

  it('**同一张卡在两条连接上 → 报错** ✓（**不猜** ✓）', () => {
    const res = promoteCard(
      layout([
        { cardId: 'a', connectionId: 'c1', x: 0, y: 0, w: 4, h: 2 },
        { cardId: 'a', connectionId: 'c2', x: 4, y: 0, w: 4, h: 2 },
      ]),
      'a',
      undefined,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('invalid_params');
  });

  it('**给了 connectionId → 提那一个** ✓', () => {
    const res = promoteCard(
      layout([
        { cardId: 'a', connectionId: 'c1', x: 0, y: 0, w: 4, h: 2 },
        { cardId: 'a', connectionId: 'c2', x: 4, y: 0, w: 4, h: 2 },
      ]),
      'a',
      'c2',
    );
    expect(res.ok).toBe(true);
    expect(res.layout?.promoted?.connectionId).toBe('c2');
  });

  it('**主区里没有这张卡 → `not_found`** ✓', () => {
    const res = promoteCard(layout([]), 'nope', undefined);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not_found');
  });

  it('**提的是原来那一格** ✓（**不是新建一格** ✓ —— 要保它的位置与连接 ✓）', () => {
    const res = promoteCard(
      layout([{ cardId: 'a', connectionId: 'c1', x: 3, y: 5, w: 6, h: 2 }]),
      'a',
      'c1',
    );
    expect(res.layout?.promoted?.x).toBe(3);
    expect(res.layout?.promoted?.y).toBe(5);
    expect(res.layout?.promoted?.w).toBe(6);
  });
});
