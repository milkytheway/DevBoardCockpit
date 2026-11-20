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

describe('Shell · the grid slot key', () => {
  it('the card id and the connection id can be recovered from the key (including the unconnected case)', () => {
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

describe('Shell · the layout fallback (main returns a cell for every card)', () => {
  it('cards that were never moved must not stack at (0,0)', () => {
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
        expect(overlaps(placed[i], placed[j]), `${placed[i].cardId} overlaps ${placed[j].cardId}`).toBe(false);
      }
    }
  });

  it('an existing cell is kept as it is (the layout of the user wins)', () => {
    const cards = [card('cpu-curve')];
    const units: LayoutUnit[] = [{ cardId: 'cpu-curve', connectionId: null, x: 6, y: 4, w: 5, h: 3 }];
    expect(resolveLayout(cards, units)).toEqual(units);
  });

  it('a card without a cell gets the default cell (the default size has one home: the shared defaultUnit)', () => {
    const placed = resolveLayout([card('new-card')], []);
    expect(placed[0]).toMatchObject({ cardId: 'new-card', x: 0, y: 0, w: 3, h: 2 });
  });

  it('sorted by card id (the same input always renders in the same order)', () => {
    const cards = [card('b'), card('a')];
    const placed = resolveLayout(cards, []);
    expect(placed.map((unit) => unit.cardId)).toEqual(['a', 'b']);
  });
});
