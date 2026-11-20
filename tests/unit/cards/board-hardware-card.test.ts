import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseManifest } from '../../../src/main/cards/manifest';
import { validateCard } from '../../../src/main/cards/validate';

/**
 * The "board hardware" card (it comes with the product — **it is made from the
 * manual**).
 *
 * What it is:
 *
 * → The hardware list of the *ATK-DLRK3588 Buildroot System Quick Start
 *   Manual V1.1*: **what is on the board** and **how to verify every entry
 *   yourself** (the manual gives the commands).
 * → It is **written into the card statically** (the manual is static), so it
 *   **does not pretend to read the board**.
 *
 * Why it needs guards:
 *
 * → A built-in card is **part of the product**; if it is broken, the user
 *   sees a broken card the first time the application is opened.
 * → **More important**: it states **what this board has**, so a wrong entry
 *   would be lying to the user, and the **key facts need guards** (every one
 *   of them is checked against the manual).
 */
const REPO_ROOT = resolve(__dirname, '../../..');
const CARD_DIR = join(REPO_ROOT, 'cards', 'board-hardware');

/**
 * The key facts of the manual (**every one of them has to be in the card**).
 *
 * These were picked out adversarially: pins, baud rates, chip models, device
 * nodes — **one wrong value and the user wastes their time following it**.
 */
const FACTS: readonly [string, string][] = [
  ['the pin of the user LED', 'GPIO1_A3'],
  ['the baud rate of the debug serial port', '1500000'],
  ['the RTC chip', 'AT8563T'],
  ['the audio CODEC', 'ES8388'],
  ['the camera model', 'IMX415'],
  ['the camera node', '/dev/video62'],
  ['the six-axis sensor', 'SH3001'],
  ['the on-board WiFi chip', 'RTL8733BU'],
  ['the PCIe WiFi chip', 'RTL8852BE'],
  ['the thermal node', 'thermal_zone0'],
  ['the NPU node', '/sys/kernel/debug/rknpu/load'],
  ['the speed of the Ethernet port', '1000M'],
  ['the TF node', 'mmcblk1p1'],
  ['the eMMC node', 'mmcblk0p8'],
];

describe('the "board hardware" card', () => {
  it('**it is under `cards/`** (the location of contract §8, the built-in root)', () => {
    expect(existsSync(join(CARD_DIR, 'manifest.json'))).toBe(true);
    expect(existsSync(join(CARD_DIR, 'index.html'))).toBe(true);
  });

  it('the manifest **parses** (closed schema: a misspelled field cannot be silently ignored)', () => {
    const raw = JSON.parse(readFileSync(join(CARD_DIR, 'manifest.json'), 'utf8')) as unknown;
    const manifest = parseManifest(raw, 'cards/board-hardware');
    expect(manifest.id).toBe('board-hardware');
    expect(manifest.entry).toBe('index.html');
  });

  it('**every validation rule passes** (offline: rule 5 is "not verified", not an error)', () => {
    const raw = JSON.parse(readFileSync(join(CARD_DIR, 'manifest.json'), 'utf8')) as unknown;
    const manifest = parseManifest(raw, 'cards/board-hardware');
    const result = validateCard(manifest, {
      availableTags: null,
      availableActions: null,
      availableWorkflows: null,
      installedCardIds: [],
      fileExists: (rel) => existsSync(join(CARD_DIR, rel)),
    });
    expect(result.errors).toEqual([]);
  });

  it('**it only reads, it never writes** (**it is a card that explains** — **it does not touch the board**)', () => {
    const raw = JSON.parse(readFileSync(join(CARD_DIR, 'manifest.json'), 'utf8')) as unknown;
    const manifest = parseManifest(raw, 'cards/board-hardware');
    expect(manifest.permissions.write).toEqual([]);
    expect(manifest.permissions.workflows ?? []).toEqual([]);
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

  it('**the key facts of the manual are all there** (**a wrong one would be lying to the user**)', () => {
    const js = readFileSync(join(CARD_DIR, 'card.js'), 'utf8');
    for (const [what, fact] of FACTS) {
      expect(js, `${what} (${fact}) is not in the card`).toContain(fact);
    }
  });

  it('**every entry names the section it comes from** (**the manual can be looked up**)', () => {
    const js = readFileSync(join(CARD_DIR, 'card.js'), 'utf8');
    // **§2.1 to §2.26** — the 26 subsections of the second chapter of the manual
    for (let section = 1; section <= 26; section += 1) {
      expect(js, `§2.${section} has no source`).toContain(`§2.${section}`);
    }
  });
});
