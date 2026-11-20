import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCardDir, listCardDirs, type CardRoot } from '../../../src/main/cards/roots';
import { CardRegistry } from '../../../src/main/cards/registry';
import { parseManifest, type CardManifest } from '../../../src/main/cards/manifest';
import { validateCard, type CardIssue } from '../../../src/main/cards/validate';

/**
 * The discovery of card directories and the registry.
 *
 * Two roots, and the user comes first:
 *
 * A card has two roots: the built-in directory (shipped with the product) and
 * the user directory (put there by the operator). **The same id on both sides
 * → the user directory wins**, so that the operator can **change** a built-in
 * card; that is the premise of "a card is a file" (edit the file and it takes
 * effect).
 *
 * "An invalid manifest keeps the previous version":
 *
 * An agent may write half a card and leave a broken manifest. The card must
 * **not be withdrawn from the workbench** then — its previous version is still
 * good, and withdrawing it means the operator watches the instrument they just
 * built disappear. Therefore the previous version is kept and the problem is
 * **recorded** and shown.
 */

/** Creates the directory of a card (it writes only manifest.json) */
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

/** The two dependencies of the registry (the real parser and the real validator) */
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
        availableWorkflows: null,
        installedCardIds: [],
        fileExists: () => true,
      });
      return [...r.errors, ...r.warnings];
    },
  };
}

describe('the lookup of a card directory over the two roots', () => {
  it('the same id on both sides → **the user directory wins**', () => {
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

  it('only the built-in root has it → the built-in one is used', () => {
    const { roots, cleanup } = tempRoots();
    try {
      makeCard(roots[0].dir, 'target-switcher');
      expect(findCardDir(roots, 'target-switcher')).toBe(join(roots[0].dir, 'target-switcher'));
    } finally {
      cleanup();
    }
  });

  it('not found → null (**it does not guess**)', () => {
    const { roots, cleanup } = tempRoots();
    try {
      expect(findCardDir(roots, 'nope')).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('the directory has no manifest.json → **it is skipped**, it is not a card', () => {
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

describe('the card registry', () => {
  it('a refresh: it discovers the cards; an invalid manifest keeps **the previous version** and the problem is recorded', () => {
    const { roots, cleanup } = tempRoots();
    try {
      const dir = makeCard(roots[1].dir, 'cpu-usage');
      const registry = new CardRegistry({ roots, ...deps() });

      // The first pass: it is valid
      expect(registry.refresh().map((c) => c.cardId)).toEqual(['cpu-usage']);
      expect(registry.cards()[0]?.issues).toEqual([]);

      // The second pass: the agent has broken the manifest (an unknown apiVersion → rule 1)
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
      // **the previous version is still there** (the card is not withdrawn)
      expect(cards[0]?.manifest.apiVersion).toBe('devboard/v1');
      // The problem was recorded
      expect(cards[0]?.issues.length).toBeGreaterThan(0);
      expect(cards[0]?.issues.some((i) => i.rule === 1)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('**the card file was changed → the instance id changed** (so the iframe reloads, which is the hot reload of "edit the file and it takes effect")', () => {
    const { roots, cleanup } = tempRoots();
    try {
      const dir = makeCard(roots[1].dir, 'cpu-usage');
      writeFileSync(join(dir, 'card.js'), 'export const x = 1;', 'utf8');
      const registry = new CardRegistry({ roots, ...deps() });
      registry.refresh();

      const before = registry.instanceFor('cpu-usage', 'board-adb');
      // The content did not change → the same instance
      registry.refresh();
      expect(registry.instanceFor('cpu-usage', 'board-adb').instanceId).toBe(before.instanceId);

      // **One character was changed** → the fingerprint of the content changed → the
// instance id has to change
      writeFileSync(join(dir, 'card.js'), 'export const x = 2;', 'utf8');
      registry.refresh();
      const after = registry.instanceFor('cpu-usage', 'board-adb');
      expect(after.instanceId).not.toBe(before.instanceId);
      // The URL changes as well → the browser does not use the old cache
      expect(after.url).not.toBe(before.url);
    } finally {
      cleanup();
    }
  });

  it('an instance: the same (card, connection) always has the same instanceId', () => {
    const { roots, cleanup } = tempRoots();
    try {
      makeCard(roots[1].dir, 'cpu-usage');
      const registry = new CardRegistry({ roots, ...deps() });
      registry.refresh();

      const a = registry.instanceFor('cpu-usage', 'board-adb');
      const b = registry.instanceFor('cpu-usage', 'board-adb');
      expect(b.instanceId).toBe(a.instanceId);

      // A different connection → a different instance (contract §7.8: the connection
// context is injected when the iframe is created)
      const c = registry.instanceFor('cpu-usage', 'board-serial');
      expect(c.instanceId).not.toBe(a.instanceId);
    } finally {
      cleanup();
    }
  });

  it('the URL of an instance has the form cockpit://card/<uuid>/index.html', () => {
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

  it('a card that is not installed → dirOf is null (it does not guess)', () => {
    const { roots, cleanup } = tempRoots();
    try {
      const registry = new CardRegistry({ roots, ...deps() });
      registry.refresh();
      expect(registry.dirOf('nope')).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('**instance → card** can be looked up the other way (the protocol handler needs it to find the card directory)', () => {
    const { roots, cleanup } = tempRoots();
    try {
      makeCard(roots[1].dir, 'cpu-usage');
      const registry = new CardRegistry({ roots, ...deps() });
      registry.refresh();

      const { instanceId } = registry.instanceFor('cpu-usage', 'board-adb');
      expect(registry.cardOfInstance(instanceId)).toBe('cpu-usage');
      expect(registry.dirOfInstance(instanceId)).toBe(join(roots[1].dir, 'cpu-usage'));
      expect(registry.entryOfInstance(instanceId)).toBe('index.html');
      // An instance that was never registered → null (it does not guess)
      expect(registry.cardOfInstance('nope')).toBeNull();
      expect(registry.dirOfInstance('nope')).toBeNull();
    } finally {
      cleanup();
    }
  });
});
