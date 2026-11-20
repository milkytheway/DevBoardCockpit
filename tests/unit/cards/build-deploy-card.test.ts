import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseManifest } from '../../../src/main/cards/manifest';
import { validateCard } from '../../../src/main/cards/validate';

/**
 * The card "compile and flash" (it comes with the product).
 *
 * Why it needs guards:
 *
 * → A built-in card is **part of the product** — if it is broken, the operator
 *   sees a broken card the first time the application is opened.
 * → And this card **runs workflows**, and **a workflow can execute commands on
 *   the machine of the operator**, so **a wrong manifest means a wrong
 *   authorisation surface** → **it has to be guarded**.
 *
 * What it guards:
 *
 * | # | Rule | Why |
 * |---|---|---|
 * | 1 | **the manifest parses** | closed schema — a misspelled field cannot be silently ignored |
 * | 2 | **every validation rule passes** | rule 3 (requires ⊆ permissions) · rule 14 (the workflow id is exact) |
 * | 3 | **the script is in a separate file** | the `script-src 'self'` of contract §6.1 — an inline script is stopped by the CSP |
 * | 4 | **the styles use only `--cockpit-*`** | otherwise reskinning does not hold |
 * | 5 | **the workflows it declares are exactly the three compile / upload / run workflows** | **no more and no less** — one more means a bigger authorisation surface |
 */
const REPO_ROOT = resolve(__dirname, '../../..');
const CARD_DIR = join(REPO_ROOT, 'cards', 'build-deploy');

/** The workflows this card **needs** (**the exact ids** — contract `spec/03`, rule 14) */
const WANTED = [
  'hello-kernel.compile',
  'hello-kernel.upload',
  'hello-kernel.load',
];

describe('the card "compile and flash"', () => {
  it('**it is under `cards/`** (the location of contract §8, the built-in root)', () => {
    expect(existsSync(join(CARD_DIR, 'manifest.json'))).toBe(true);
    expect(existsSync(join(CARD_DIR, 'index.html'))).toBe(true);
  });

  it('the manifest **parses** (closed schema: a misspelled field cannot be silently ignored)', () => {
    const raw = JSON.parse(readFileSync(join(CARD_DIR, 'manifest.json'), 'utf8')) as unknown;
    const manifest = parseManifest(raw, 'cards/build-deploy');
    expect(manifest.id).toBe('build-deploy');
    expect(manifest.entry).toBe('index.html');
  });

  it('**every validation rule passes** (offline: rule 14 is "not verified", not an error)', () => {
    const raw = JSON.parse(readFileSync(join(CARD_DIR, 'manifest.json'), 'utf8')) as unknown;
    const manifest = parseManifest(raw, 'cards/build-deploy');
    const result = validateCard(manifest, {
      availableTags: null,
      availableActions: null,
      availableWorkflows: null,
      installedCardIds: [],
      fileExists: (rel) => existsSync(join(CARD_DIR, rel)),
    });
    expect(result.errors).toEqual([]);
  });

  it('**the workflows it declares are exactly the three compile / upload / run workflows** (**no more and no less**)', () => {
    const raw = JSON.parse(readFileSync(join(CARD_DIR, 'manifest.json'), 'utf8')) as unknown;
    const manifest = parseManifest(raw, 'cards/build-deploy');
    expect(manifest.permissions.workflows).toEqual(WANTED);
    // **requires ⊆ permissions** (rule 3) — a wish may not go beyond the authorisation
    expect(manifest.requires?.workflows).toEqual(WANTED);
  });

  it('**it asks for no write permission** (**it only triggers a workflow** — the action goes through `actions.invoke`)', () => {
    const raw = JSON.parse(readFileSync(join(CARD_DIR, 'manifest.json'), 'utf8')) as unknown;
    const manifest = parseManifest(raw, 'cards/build-deploy');
    expect(manifest.permissions.write).toEqual([]);
    expect(manifest.permissions.read).toEqual([]);
  });

  it('**the script is in a separate file** (the script-src of contract §6.1 allows the same origin only, no inline script)', () => {
    const html = readFileSync(join(CARD_DIR, 'index.html'), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/);
    expect(html).toContain('src="./card.js"');
  });

  it('**the styles use only the `--cockpit-*` variables** (no hard-coded colour, otherwise reskinning does not hold)', () => {
    const css = readFileSync(join(CARD_DIR, 'style.css'), 'utf8');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/rgba?\(/);
    expect(css).toContain('--cockpit-');
  });

  it('**it really calls the workflow API** (**it is not an empty shell**)', () => {
    const js = readFileSync(join(CARD_DIR, 'card.js'), 'utf8');
    expect(js).toContain('workflows.list');
    expect(js).toContain('workflows.run');
    expect(js).toContain('workflows.status');
  });
});
