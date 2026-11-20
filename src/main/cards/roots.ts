import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The two roots of the card directories.
 *
 * | Root | Where | Who writes |
 * |---|---|---|
 * `builtin` | `cards/` under the application directory | shipped with the product (the target switcher, for instance) |
 * `user` | `cards/` under the user data directory | **people** and agents |
 *
 * ── "User first" is a precondition of "cards are files" ──
 *
 * A person (or an agent) who edits a built-in card places a directory with the
 * **same id** in the user directory.
 * **The user root wins** — otherwise the claim "edit a file and it takes
 * effect" would be false for the built-in cards.
 */
export interface CardRoot {
  dir: string;
  kind: 'builtin' | 'user';
}

/**
 * Finds the directory of a card.
 *
 * @returns `null` when there is none (**no guessing** — the contract's "do not
 * guess" stance)
 */
export function findCardDir(roots: CardRoot[], cardId: string): string | null {
  // **The user root comes first**: the order of the roots does not decide the priority, the kind does
  const ordered = [...roots].sort((a, b) => (a.kind === 'user' ? -1 : 1) - (b.kind === 'user' ? -1 : 1));
  for (const root of ordered) {
    const dir = join(root.dir, cardId);
    if (existsSync(join(dir, 'manifest.json'))) return dir;
  }
  return null;
}

/**
 * Lists all cards (only a directory that holds a `manifest.json` counts).
 *
 * For the same id the **user root wins** — a card has exactly one directory
 * in one manifest, otherwise the protocol handler would have to guess which
 * one to serve.
 */
export function listCardDirs(
  roots: CardRoot[],
): { cardId: string; dir: string; rootKind: 'builtin' | 'user' }[] {
  const found = new Map<string, { cardId: string; dir: string; rootKind: 'builtin' | 'user' }>();
  // **The user root first**, so that a built-in card with the same id does **not** overwrite it
  const ordered = [...roots].sort((a, b) => (a.kind === 'user' ? -1 : 1) - (b.kind === 'user' ? -1 : 1));
  for (const root of ordered) {
    if (!existsSync(root.dir)) continue;
    for (const entry of readdirSync(root.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root.dir, entry.name);
      if (!existsSync(join(dir, 'manifest.json'))) continue;
      if (!found.has(entry.name)) {
        found.set(entry.name, { cardId: entry.name, dir, rootKind: root.kind });
      }
    }
  }
  return [...found.values()].sort((a, b) => a.cardId.localeCompare(b.cardId));
}
