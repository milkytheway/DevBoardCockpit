import { watch, type FSWatcher } from 'node:fs';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CardRoot } from './roots';

/**
 * Watching the card directories (hot plug).
 *
 * ── Why not chokidar ──
 *
 * A dependency would buy "recursive watching + debounce + cross-platform",
 * while all that is needed here is "the card root changed + each card
 * directory changed".
 * **`fs.watch` is enough** (Electron runs on Node, which has a `recursive`
 * option, but **not every platform supports it** — so watch one level and
 * attach one watcher per card directory).
 *
 * ── Debounce ──
 *
 * A single save may fire **several** events (file write, rename, permission
 * change). Without debouncing → one save refreshes three times → the card
 * flickers three times.
 */
export function watchCardRoots(roots: CardRoot[], onChange: () => void): () => void {
  /** The watchers already attached (per directory — the same directory is never watched twice) */
  const watchers = new Map<string, FSWatcher>();
  const pending = new Set<NodeJS.Timeout>();

  const fire = (): void => {
    // **Debounced by 200ms**: one save refreshes once
    const timer = setTimeout(() => {
      pending.delete(timer);
      // **Everything is attached again on every change**: the directory of a newly installed card only exists by then
      // (without re-attaching → a change in its files goes unnoticed → "edit a file and it takes effect" does not hold for it)
      ensureWatching();
      onChange();
    }, 200);
    pending.add(timer);
  };

  const watchDir = (dir: string): void => {
    if (watchers.has(dir)) return;
    if (!existsSync(dir)) return;
    try {
      watchers.set(dir, watch(dir, fire));
    } catch {
      // The directory is gone / not accessible → do not watch it (**not an error**: the directory may legitimately not exist)
    }
  };

  /**
     * Attaches every directory that needs watching.
     *
     * ── Why everything is redone after every change ──
     *
     * `fs.watch` is **not recursive** → a file **inside** a card directory does
     * not produce an event on the root. So every card directory needs a watcher
     * of its own; and a card **installed after startup** does not have its
     * directory yet → it can only be watched once it appears (an event on the
     * root) ✓.
     */
  const ensureWatching = (): void => {
    for (const root of roots) {
      // **The user root is created if it is missing**
      //
      // On the first run of the application it does not exist yet → not created → not watched →
      // the user drops a card in → **the application never learns of it** → the card area stays empty (unless it is restarted).
      // And the first step of "cards are files" is "there is a place to put the cards" —
      // that place **should be prepared by the application**, the user should not have to create it.
      //
      // **The built-in root is not created**: that is the installation directory, and it is **read-only** (it lives in Program Files).
      if (root.kind === 'user') {
        try {
          mkdirSync(root.dir, { recursive: true });
        } catch {
          // It cannot be created (permissions) → not created, and no watcher can be attached either (not an error)
        }
      }
      watchDir(root.dir);
      if (!existsSync(root.dir)) continue;
      // Every installed card directory gets a watcher of its own as well (a change inside a card directory counts as a hot update)
      for (const entry of readdirSync(root.dir, { withFileTypes: true })) {
        if (entry.isDirectory()) watchDir(join(root.dir, entry.name));
      }
    }
  };

  ensureWatching();

  return () => {
    for (const timer of pending) clearTimeout(timer);
    pending.clear();
    for (const watcher of watchers.values()) {
      try {
        watcher.close();
      } catch {
        // Already closed
      }
    }
    watchers.clear();
  };
}
