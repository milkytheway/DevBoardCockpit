import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchCardRoots } from '../../../src/main/cards/watcher';

/**
 * The hot-plug watcher of the card directory.
 *
 * These two were once genuinely wrong:
 *
 * ① **When the user root did not exist it was simply not watched** — on the
 *   first run of the application
 *   `%LOCALAPPDATA%\DevBoardCockpit\cards` **does not exist yet**, so the
 *   operator (or the agent) puts a card in → **the application never learns
 *   about it** → the card area stays empty until the application is
 *   restarted. **The most common step of "a card is a file" was broken.**
 *
 * ② **The directory of a card that was installed after the startup was not
 *   watched** — the watcher was only attached once at the startup, and a card
 *   directory that appeared later **was only brought up once by an event of
 *   the root**, so changing a file in it **did not trigger a refresh** → "edit
 *   the file and it takes effect" did not hold for it.
 *
 * Both of them were **only exposed by the end-to-end tests** (the unit tests
 * cannot cover "does the directory exist").
 */
function scene(): { base: string; root: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'card-watch-'));
  return {
    base,
    root: join(base, 'cards'),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** Waits until the condition holds (the watcher has a debounce of 200ms, so it has to be waited for) */
async function waitFor(cond: () => boolean, ms = 5000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

describe('the watcher of the card directory', () => {
  it('**the user root is created when it does not exist** ("a card is a file" needs a place to put the cards)', () => {
    const { root, cleanup } = scene();
    try {
      const stop = watchCardRoots([{ dir: root, kind: 'user' }], () => undefined);
      try {
        expect(existsSync(root)).toBe(true);
      } finally {
        stop();
      }
    } finally {
      cleanup();
    }
  });

  it('**a card that was put in while the root did not exist is found as well** (the first installation may not ask for a restart)', async () => {
    const { root, cleanup } = scene();
    try {
      let changed = 0;
      const stop = watchCardRoots([{ dir: root, kind: 'user' }], () => {
        changed += 1;
      });
      try {
        mkdirSync(join(root, 'c1'), { recursive: true });
        writeFileSync(join(root, 'c1', 'manifest.json'), '{}', 'utf8');
        expect(await waitFor(() => changed > 0)).toBe(true);
      } finally {
        stop();
      }
    } finally {
      cleanup();
    }
  });

  it('**the directory of a card that was installed after the startup is watched as well** (edit the file and it takes effect)', async () => {
    const { base, root, cleanup } = scene();
    try {
      mkdirSync(root, { recursive: true });
      let changed = 0;
      const stop = watchCardRoots([{ dir: root, kind: 'user' }], () => {
        changed += 1;
      });
      try {
        // It installs a card
        mkdirSync(join(root, 'c1'), { recursive: true });
        writeFileSync(join(root, 'c1', 'manifest.json'), '{}', 'utf8');
        expect(await waitFor(() => changed > 0)).toBe(true);
        // After the watcher is attached again, a **file inside the card** is changed
        await new Promise((r) => setTimeout(r, 400));
        const before = changed;
        writeFileSync(join(root, 'c1', 'card.js'), '// one character changed', 'utf8');
        expect(await waitFor(() => changed > before)).toBe(true);
        expect(base).toBeTruthy();
      } finally {
        stop();
      }
    } finally {
      cleanup();
    }
  });

  it('the built-in root is **not created** (that is the installation directory of the application, it is read-only)', () => {
    const { base, root, cleanup } = scene();
    try {
      const builtin = join(base, 'app', 'cards');
      const stop = watchCardRoots([{ dir: builtin, kind: 'builtin' }], () => undefined);
      try {
        expect(existsSync(builtin)).toBe(false);
      } finally {
        stop();
      }
      expect(root).toContain('cards');
    } finally {
      cleanup();
    }
  });
});
