import { describe, it, expect } from 'vitest';
import { promoteCard } from '../../../src/main/mcp/promote';
import type { LayoutState } from '../../../src/shared/layout';

/**
 * Promoting a card to full screen (contract `spec/04` §2.5).
 *
 * What these criteria guard:
 *
 * | Criterion | Why |
 * |---|---|
 * | **the host only records "who wants full screen"** | **only the renderer knows how many rows to fill** (the row height is a constant of the rendering layer), so the host **does not guess** |
 * | **the other cells are not touched** | **making room is the business of the rendering layer** — a host that changes the layout **destroys the arrangement of the user** |
 * | **more than one instance → an error** | **it does not guess** |
 * | **not found → `not_found`** | |
 */
function layout(units: LayoutState['units']): LayoutState {
  return { version: 3, units, density: 'comfortable', promoted: null, updatedAt: 0 };
}

describe('MCP · promote_card', () => {
  it('**it records "who wants full screen"** (**the host does not guess how many rows to fill** — only the renderer knows that)', () => {
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

  it('**not one of the other cells is touched** (**making room is the business of the rendering layer** — a host that changes it destroys the arrangement of the user)', () => {
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

  it('**the number of cells does not change** (**nothing is removed or hidden** — the layout model has no such concept)', () => {
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

  it('**the same card on two connections → an error** (**it does not guess**)', () => {
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

  it('**a connectionId is given → that one is promoted**', () => {
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

  it('**the card is not in the main area → `not_found`**', () => {
    const res = promoteCard(layout([]), 'nope', undefined);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not_found');
  });

  it('**the original cell is promoted** (**not a newly created one** — its position and its connection are kept)', () => {
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
