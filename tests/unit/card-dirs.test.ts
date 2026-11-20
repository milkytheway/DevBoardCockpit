import { describe, it, expect } from 'vitest';
import { relative, isAbsolute } from 'node:path';
import { cardRootsDir, cardStorageDir } from '../../src/main/util/paths';

/**
 * The **convention of the location** of the directories that belong to the
 * cards.
 *
 * A rule that may not be broken:
 *
 * **The storage directory may not lie inside the card root.**
 *
 * The card root is watched with `fs.watch` (the hot plug: "edit the file and
 * it takes effect"). If the storage is written into the root:
 *
 * ```
 * the card writes the storage once  →  storage.json lands on the disk  →  fs.watch fires
 *                      →  refresh() + broadcast(cardsChanged)
 *                      →  the page fetches the list again  →  the card writes once more  →  …
 * ```
 *
 * → A **loop**. One card that likes to store things can light it up (the CPU
 *   spins, the IPC floods the screen).
 *
 * Therefore the storage goes into a **sibling directory**: `cards/` and
 * `card-storage/` each mind their own.
 */
describe('the location of the card directories', () => {
  it('**the storage directory is not inside the card root** (otherwise every write of the storage triggers a hot refresh)', () => {
    const roots = cardRootsDir('DevBoardCockpit-test');
    const storage = cardStorageDir('DevBoardCockpit-test');
    const rel = relative(roots, storage);
    // A relative path that does not start with `..` = **outside the root**
    expect(rel.startsWith('..')).toBe(true);
    expect(isAbsolute(rel)).toBe(false);
  });

  it('both directories are in the user data directory', () => {
    expect(cardRootsDir('X').includes('X')).toBe(true);
    expect(cardStorageDir('X').includes('X')).toBe(true);
  });

  it('the two directories are **not the same**', () => {
    expect(cardRootsDir('X')).not.toBe(cardStorageDir('X'));
  });
});
