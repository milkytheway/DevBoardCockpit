import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseManifest } from '../../../src/main/cards/manifest';
import { validateCard } from '../../../src/main/cards/validate';

/**
 * The **first built-in card** (the one that comes with the product).
 *
 * Why it has guards:
 *
 * Contract §8 says that the shape of the card directory is `cards/<card
 * id>/…`, and the **built-in root** of the host is `join(app.getAppPath(),
 * 'cards')` — during the development and in the package `app.getAppPath()`
 * is the **root of the repository / of the application**.
 *
 * → Therefore this card has to be in **`cards/cpu-usage/`** (and not in
 *   `fixtures/` — that holds the golden test vectors, not the assets of the
 *   product).
 *
 * Why "it does not pass its own validation" would be a problem:
 *
 * A built-in card is **part of the product**: if it is broken, the operator
 * sees a broken card the first time the application is opened. And it is
 * **not** overridden by a card of the same name in the user directory (the user
 * directory wins, but the operator has to put one there first).
 *
 * → Therefore there have to be guards: this card has to **parse and pass all
 *   13 validations**.
 */
const REPO_ROOT = resolve(__dirname, '../../..');
const CARD_DIR = join(REPO_ROOT, 'cards', 'cpu-usage');

describe('the first built-in card', () => {
  it('**it is under `cards/`** (the location of contract §8, the built-in root)', () => {
    expect(existsSync(join(CARD_DIR, 'manifest.json'))).toBe(true);
    expect(existsSync(join(CARD_DIR, 'index.html'))).toBe(true);
  });

  it('the manifest **parses** (closed schema: a misspelled field cannot be silently ignored)', () => {
    const raw = JSON.parse(readFileSync(join(CARD_DIR, 'manifest.json'), 'utf8')) as unknown;
    const manifest = parseManifest(raw, 'cards/cpu-usage');
    expect(manifest.id).toBe('cpu-usage');
    expect(manifest.entry).toBe('index.html');
  });

  it('**all 13 validations pass** (offline: rule 5 is "not verified", not an error)', () => {
    const raw = JSON.parse(readFileSync(join(CARD_DIR, 'manifest.json'), 'utf8')) as unknown;
    const manifest = parseManifest(raw, 'cards/cpu-usage');
    const result = validateCard(manifest, {
      availableTags: null,
      availableActions: null,
      availableWorkflows: null,
      installedCardIds: [],
      fileExists: (rel) => existsSync(join(CARD_DIR, rel)),
    });
    expect(result.errors).toEqual([]);
  });

  it('**the script is in a separate file** (the script-src of contract §6.1 allows the same origin only, no inline script)', () => {
    const html = readFileSync(join(CARD_DIR, 'index.html'), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/);
    expect(html).toContain('src="./card.js"');
  });

  it('**the styles use only the `--cockpit-*` variables** (no hard-coded colour, otherwise reskinning does not hold)', () => {
    const css = readFileSync(join(CARD_DIR, 'style.css'), 'utf8');
    // Neither a hexadecimal colour nor rgb() may be there
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/rgba?\(/);
    expect(css).toContain('--cockpit-');
  });
});
