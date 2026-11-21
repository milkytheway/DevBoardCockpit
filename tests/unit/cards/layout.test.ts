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
 * The **writing of the layout** (the part of the core track).
 *
 * What it is:
 *
 * "Which cards are in the main area and how large they are" is **the ledger of
 * the host**: the contract says in §7 "where the binding happens: **the layout
 * layer**: a layout cell records `(cardId, connectionId)`". The card does
 * not know where it is, and the page may not keep that on its own (it is gone
 * after a reload).
 *
 * The key is `(cardId, connectionId)`:
 *
 * Contract §7.8: one card may have an instance on several connections → every
 * instance **takes a cell of its own**. Recording only by `cardId` would
 * clash (two cards in the same cell).
 *
 * v3: one layout, no views:
 *
 * The main area is empty by default, and you place a card by clicking it in
 * the card directory. The old files can still be read (v1 is used directly;
 * v2 takes the one of the **"current view"** — **the layout of the other views
 * is lost**, because the "view" has left the stage).
 *
 * Why writing it has to survive a broken file:
 *
 * The layout file lives in the user directory and may have been written half
 * or broken by hand. **One broken file may not keep the application from
 * starting** — that would turn a problem of the layout of the user into a
 * problem of the application. → If it cannot be read it counts as an empty
 * layout (the operator places the cards again), and the broken file is left
 * as it is (it is not overwritten, so that the scene of the user is not
 * destroyed).
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

describe('the layout store', () => {
  it('**no layout file → an empty layout** (the main area is empty, you place the cards)', () => {
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

  it('**after a set, get returns the same value** (what was written and what is read back agree)', () => {
    const { file, cleanup } = scene();
    try {
      const store = new LayoutStore({ file, now: () => 1000 });
      store.set({ version: 3, units: [UNIT], density: 'comfortable', updatedAt: 1000 });
      expect(store.get().units).toEqual([UNIT]);
      // **A new store is opened** (it simulates a restart) → it is still there
      const again = new LayoutStore({ file, now: () => 2000 });
      expect(again.get().units).toEqual([UNIT]);
    } finally {
      cleanup();
    }
  });

  it('**the position is recorded** (after a drag it is not the default position any more)', () => {
    const { file, cleanup } = scene();
    try {
      const store = new LayoutStore({ file, now: () => 1000 });
      store.set({ version: 3, units: [{ ...UNIT, x: 5, y: 7 }], density: 'comfortable', updatedAt: 1000 });
      expect(store.get().units[0]).toMatchObject({ x: 5, y: 7 });
    } finally {
      cleanup();
    }
  });

  it('**a broken layout file → it returns empty and does not throw** (one file may not keep the application from starting)', () => {
    const { file, cleanup } = scene();
    try {
      writeFileSync(file, '{ this is not JSON', 'utf8');
      const store = new LayoutStore({ file, now: () => 1000 });
      expect(store.get().units).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('**the density is stored** (it is global, it is changed on the settings page)', () => {
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

describe('the version migration of the layout shape', () => {
  it('**an old v1 file can be read** (`{units, updatedAt}`)', () => {
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

  it('**a v2 file with several views can be read** (the one of the "current view" is taken; the layout of the other views is not kept)', () => {
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
      // **The one of the current view** (debug) → not the one of overview
      expect(state.units).toHaveLength(1);
      expect(state.units[0]).toMatchObject({ cardId: 'debug-card', x: 6, y: 3 });
      // The density follows the current view as well
      expect(state.density).toBe('compact');
    } finally {
      cleanup();
    }
  });

  it('**a broken field falls back to the default and does not throw** (broken units / broken density / broken updatedAt)', () => {
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

describe('the pure functions of the layout shape', () => {
  it('**defaultUnit takes the size the card reports itself** (the default is 3×2)', () => {
    expect(defaultUnit('cpu-usage', null, { w: 4, h: 3 })).toMatchObject({ w: 4, h: 3 });
    expect(defaultUnit('cpu-usage', 'board-a')).toMatchObject({
      w: 3,
      h: 2,
      connectionId: 'board-a',
    });
  });

  it('**withUnits / withDensity do not change the original**', () => {
    const base = emptyLayout(1);
    const next = withUnits(base, [UNIT]);
    expect(next.units).toEqual([UNIT]);
    expect(base.units).toEqual([]);
    expect(withDensity(base, 'compact').density).toBe('compact');
    expect(base.density).toBe('comfortable');
  });

  it('**normalizeLayout narrows the shape** (it keeps only the cells whose shape is right)', () => {
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

/**
 * **The board changed** ✓ → the cells follow ✓.
 *
 * → A cell is bound to `(cardId, connectionId)` ✓ → the instances of the
 *   new board carry the new connection id ✓ → the cells of the old one
 *   would not match any more ✓ → **the cards would disappear from the main
 *   area** ✓ (found on 2026-11-21 ✓).
 */
describe('the layout store · the board changes', () => {
  it('**the cells are re-bound to the new connection** ✓', () => {
    const { file, cleanup } = scene();
    try {
      const store = new LayoutStore({ file, now: () => 1000 });
      store.set({
        version: 3,
        units: [{ ...UNIT, connectionId: 'board-adb' }],
        density: 'comfortable',
        updatedAt: 1000,
      });

      store.rebind('board-adb', 'other-board-adb');

      const units = store.get().units;
      expect(units).toHaveLength(1);
      expect(units[0]?.connectionId).toBe('other-board-adb');
      // → **The position is the position of the card** ✓ (it does not move ✓)
      expect(units[0]?.x).toBe(UNIT.x);
      expect(units[0]?.w).toBe(UNIT.w);
    } finally {
      cleanup();
    }
  });

  it('**a cell of another board is not touched** ✓', () => {
    const { file, cleanup } = scene();
    try {
      const store = new LayoutStore({ file, now: () => 1000 });
      store.set({
        version: 3,
        units: [
          { ...UNIT, cardId: 'a', connectionId: 'board-adb' },
          { ...UNIT, cardId: 'b', connectionId: 'other-board' },
        ],
        density: 'comfortable',
        updatedAt: 1000,
      });

      store.rebind('board-adb', 'new-board');
      const units = store.get().units;
      expect(units.find((u) => u.cardId === 'a')?.connectionId).toBe('new-board');
      expect(units.find((u) => u.cardId === 'b')?.connectionId).toBe('other-board');
    } finally {
      cleanup();
    }
  });
});
