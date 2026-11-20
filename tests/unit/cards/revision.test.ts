import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cardRevision } from '../../../src/main/cards/revision';

/**
 * The **fingerprint of the content** of a card directory.
 *
 * It is the foundation of "edit the file and it takes effect":
 *
 * Contract §8 and the acceptance list both promise that "one character
 * changed in a card → no restart, the card has changed". And **refreshing the
 * list is not enough** — the URL of the iframe does not change → the browser
 * does not reload → the card still runs the **old code**.
 *
 * → Therefore "the content of the card changed" has to show up in the
 *   **instance id**: the instance id changes → the URL changes → the key of
 *   React changes → **the iframe is rebuilt** → the new code takes effect.
 *
 * Why a hash of the **content** and not the mtime:
 *
 * The granularity of the timestamps of the file system differs (in some
 * places it is one second), so "written and changed again in a moment" may
 * fall into the **same second** → the mtime is the same → no reload. The
 * files of a card are small, so hashing the content is the most reliable.
 */
function scene(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'card-rev-'));
  writeFileSync(join(dir, 'index.html'), '<html></html>', 'utf8');
  writeFileSync(join(dir, 'card.js'), 'export const x = 1;', 'utf8');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('the fingerprint of the content of a card directory', () => {
  it('**the same content → the same fingerprint** (it may not get a new id on every refresh, otherwise the card reloads for ever)', () => {
    const { dir, cleanup } = scene();
    try {
      expect(cardRevision(dir)).toBe(cardRevision(dir));
    } finally {
      cleanup();
    }
  });

  it('**the content changed → the fingerprint changed** (this is what triggers the hot reload)', () => {
    const { dir, cleanup } = scene();
    try {
      const before = cardRevision(dir);
      writeFileSync(join(dir, 'card.js'), 'export const x = 2;', 'utf8');
      expect(cardRevision(dir)).not.toBe(before);
    } finally {
      cleanup();
    }
  });

  it('**two changes in the same second are recognised as well** (the mtime is unreliable, the content is not)', () => {
    const { dir, cleanup } = scene();
    try {
      const before = cardRevision(dir);
      writeFileSync(join(dir, 'card.js'), 'export const x = 2;', 'utf8');
      const middle = cardRevision(dir);
      writeFileSync(join(dir, 'card.js'), 'export const x = 3;', 'utf8');
      expect(middle).not.toBe(before);
      expect(cardRevision(dir)).not.toBe(middle);
    } finally {
      cleanup();
    }
  });

  it('**an added file counts as a change as well**', () => {
    const { dir, cleanup } = scene();
    try {
      const before = cardRevision(dir);
      writeFileSync(join(dir, 'style.css'), 'body{}', 'utf8');
      expect(cardRevision(dir)).not.toBe(before);
    } finally {
      cleanup();
    }
  });

  it('`node_modules` / `.git` **do not count** (they are large and unrelated to the code of the card)', () => {
    const { dir, cleanup } = scene();
    try {
      const before = cardRevision(dir);
      mkdirSync(join(dir, 'node_modules'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', 'x.js'), 'x', 'utf8');
      mkdirSync(join(dir, '.git'), { recursive: true });
      writeFileSync(join(dir, '.git', 'HEAD'), 'ref', 'utf8');
      expect(cardRevision(dir)).toBe(before);
    } finally {
      cleanup();
    }
  });

  it('**the files of a subdirectory count as well** (the resources of a card are often in a subdirectory)', () => {
    const { dir, cleanup } = scene();
    try {
      const before = cardRevision(dir);
      mkdirSync(join(dir, 'assets'), { recursive: true });
      writeFileSync(join(dir, 'assets', 'a.css'), 'a{}', 'utf8');
      expect(cardRevision(dir)).not.toBe(before);
    } finally {
      cleanup();
    }
  });
});
