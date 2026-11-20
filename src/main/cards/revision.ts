import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A **content fingerprint** of a card directory.
 *
 * ── What it carries ──
 *
 * The contract `spec/03` §8 and the acceptance checklist promise: "change one
 * character in a card → no restart, the card changes" ("cards are files" is
 * the core claim of this product).
 *
 * **Refreshing the manifest is not enough**: the iframe's `src` has not
 * changed → the browser **does not reload** → the card still runs **the old
 * code**. The manifest was refreshed, the card did not change — the user sees
 * "I changed it and nothing happened".
 *
 * → So "the card content changed" must be reflected in the **instance id**:
 * the instance id changes → the URL changes → the React key changes → the
 * **iframe is rebuilt** → the new code takes effect ✓
 *
 * ── Why a **content** hash and not mtime ──
 *
 * Filesystem timestamp granularity varies (some places resolve only to one
 * second), so "write it and change it again right away" may land **within the
 * same second** → mtime is unchanged → **no reload**. Card files are small, so
 * hashing the content directly is the most reliable choice.
 *
 * ── `node_modules` / `.git` are skipped ──
 *
 * They are large and unrelated to the card code (an `npm i` should not reload
 * every card).
 */
const SKIP_DIRS = new Set(['node_modules', '.git']);

/**
 * Computes the content fingerprint of a card directory.
 *
 * @returns the same content → the same string; different content → a different
 *          string
 */
export function cardRevision(dir: string): string {
  const hash = createHash('sha1');
  const files: string[] = [];

  const walk = (current: string, prefix: string): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      // Unreadable (the directory is gone / no permission) → treat it as absent
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(current, entry.name), `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = `${prefix}${entry.name}`;
      files.push(rel);
      hash.update(rel);
      try {
        hash.update(readFileSync(join(current, entry.name)));
      } catch {
        // Content unreadable → fall back to the file names (good enough: if the content changed, the names usually changed too)
      }
    }
  };

  walk(dir, '');
  // **The file order must be stable** too (the order of `readdir` is not guaranteed)
  files.sort();
  hash.update(files.join('\n'));
  return hash.digest('hex').slice(0, 12);
}
