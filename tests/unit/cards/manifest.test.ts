import { describe, it, expect } from 'vitest';
import { parseManifest } from '../../../src/main/cards/manifest';

/**
 * The **closed schema of a card manifest** (contract §2.5).
 *
 * > An unknown field is always reported, **on every level**.
 *
 * Why:
 *
 * A field that is silently ignored is a **misspelled field**. A card writes
 * `"permissons": {...}` (one i missing) → it is silently ignored → the card
 * **has no read permission** → nothing is shown and the author **never finds
 * the cause**.
 *
 * The wording is the same as in the loader of the board packs
 * (`src/main/tags/pack.ts`).
 */

/** A valid manifest (the example of contract §1) */
function valid(): Record<string, unknown> {
  return {
    apiVersion: 'devboard/v1',
    kind: 'Card',
    id: 'cpu-usage',
    name: 'CPU usage',
    version: '1.0.0',
    description: 'shows the total CPU usage and the usage of every core',
    entry: 'index.html',
    requires: { tags: ['cpu.usage', 'cpu.core.*.usage'], actions: [], min_board_pack: '>=1.0.0' },
    layout: { w: 3, h: 2, min_w: 2, min_h: 1 },
    permissions: { read: ['cpu.usage', 'cpu.core.*.usage'], write: [] },
    actions: [],
  };
}

describe('the closed schema of a card manifest', () => {
  it('a valid manifest → it is parsed as it is', () => {
    const manifest = parseManifest(valid(), 'cpu-usage');
    expect(manifest.id).toBe('cpu-usage');
    expect(manifest.kind).toBe('Card');
    expect(manifest.entry).toBe('index.html');
    expect(manifest.permissions.read).toEqual(['cpu.usage', 'cpu.core.*.usage']);
    expect(manifest.layout).toEqual({ w: 3, h: 2, min_w: 2, min_h: 1 });
  });

  it('one field too many at the top level → it is reported (the field is named)', () => {
    const raw = { ...valid(), network: true };
    expect(() => parseManifest(raw, 'cpu-usage')).toThrow(/network/);
  });

  it('one field too many in the permissions level → it is reported (**every level** is closed)', () => {
    const raw = { ...valid(), permissions: { read: [], write: [], network: true } };
    expect(() => parseManifest(raw, 'cpu-usage')).toThrow(/network/);
  });

  it('one field too many in actions[] → it is reported (the card does **not** declare danger)', () => {
    const raw = {
      ...valid(),
      actions: [{ id: 'toggle', label: 'the switch', target: 'x.set', danger: 'destructive' }],
    };
    expect(() => parseManifest(raw, 'cpu-usage')).toThrow(/danger/);
  });

  it('a missing mandatory field → it is reported', () => {
    const raw = valid();
    delete raw['entry'];
    expect(() => parseManifest(raw, 'cpu-usage')).toThrow(/entry/);
  });

  it('it is not an object → it is reported', () => {
    expect(() => parseManifest('not a manifest', 'cpu-usage')).toThrow();
  });
});
