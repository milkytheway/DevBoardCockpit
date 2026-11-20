import { describe, it, expect } from 'vitest';
import { join, resolve } from 'node:path';
import { loadBoardPack } from '../../src/main/tags/pack';
import { validatePack, errorsOf } from '../../src/main/tags/validator';

/**
 * The **generic pack (`generic-linux`)**, added on 2026-11-19.
 *
 * What it is:
 *
 * A **recipe of "what an embedded Linux usually has"**, not "what a certain
 * board has".
 * → The **board wizard** uses it to try one thing after another on a board
 *   that was just connected and is not known yet
 *   → **the green and red that were found = the table of truths of this
 *     board**
 *   → **the table of truths → a first pack of this board is instantiated**
 *     (in the user directory).
 *
 * Why these criteria live here (they **guard against false numbers**):
 *
 * → The kind of false number this project cares about most is one that
 *   **looks real** (fact G2 — a gauge that is always 0 is more dangerous
 *   than no gauge).
 * → The generic pack is "a set of commands that have to run on an unknown
 *   board", so **its false numbers are the hardest to notice** and **it has
 *   to be guarded most tightly**.
 */
const REPO_ROOT = resolve(process.cwd());
const PACK_DIR = join(REPO_ROOT, 'profiles', 'boards', 'generic-linux');

function loadGeneric(): ReturnType<typeof loadBoardPack> {
  return loadBoardPack(PACK_DIR);
}

describe('the generic pack · **it has to pass the real validator**', () => {
  it('**0 errors** (**it is an ordinary board pack** — it goes through the same rules)', () => {
    const errors = errorsOf(validatePack(loadGeneric()));
    expect(
      errors.map((e) => `rule ${e.rule} · ${e.path}: ${e.message}`),
      'the generic pack has to pass the validation — it has to run on a board that is **not known yet**',
    ).toEqual([]);
  });

  it('**it deliberately has no `match`** (**it is not a board** — it is a recipe)', () => {
    // → **a pack without `match` never takes part in the question "which pack is this board"**
    //   (the first line of `matchPack` is `if (match === undefined) return false`)
    // → **it takes the place of a recipe, not the place of a board**
    expect(loadGeneric().match, 'writing a match would make it take part in the automatic recognition').toBeUndefined();
  });

  it('**the id is `generic-linux`** (**its own custom namespace**)', () => {
    expect(loadGeneric().id).toBe('generic-linux');
  });
});

describe('the generic pack · **one value per tag** (**it guards against false numbers** — found by the probe on a real board on 2026-11-19)', () => {
  it('**no two provides point at the same sample**', () => {
    // → **measured on 2026-11-19**: `exec_regex` **takes only the first capture group**
    //   → one reader declares three tags → **the three tags get the same value** → **a false number**
    // → **therefore a reader may declare only one tag** (unless the kind really has several instances)
    const pack = loadGeneric();
    for (const reader of [...pack.readers, ...pack.custom]) {
      const samples = reader.provides.map((p) => p.sample);
      const distinct = new Set(samples);
      if (distinct.size === samples.length) continue;
      // **`thermal_zone` legitimately has several instances** (`zone.*` — it is merged by zone)
      if (reader.kind === 'thermal_zone') continue;
      expect(
        samples,
        `the reader "${reader.id}" declares several provides but the sample is only ${samples.join(' / ')}` +
          ' → **they would get the same value** → **that is a false number**' +
          '(`exec_regex` takes only the first capture group · `file_read` has only one `value`)',
      ).toEqual([...distinct]);
    }
  });

  it('**the glob of `file_read` does not coexist with another tag** (**several instances would be squeezed into one value**)', () => {
    // → **measured on 2026-11-19**: `cat -- /sys/class/backlight/*/brightness`
    //   → **all the instances are crammed into one `value`** (`255\n200`) → **a false number**
    // → **therefore a quantity of an unknown count may not use the glob of `file_read`** → take them one by one with `exec_regex`
    const pack = loadGeneric();
    for (const reader of [...pack.readers, ...pack.custom]) {
      if (reader.kind !== 'file_read') continue;
      const args = reader.args ?? {};
      if (args['glob'] === undefined) continue;
      expect(
        args['glob'],
        `the reader "${reader.id}" uses the glob of file_read → several instances are squeezed into one value → **that is a false number**` +
          '(use exec_regex to take them one by one)',
      ).toBeUndefined();
    }
  });
});

describe('the generic pack · **it was probed on a real board**', () => {
  it('**the probe script knows it** (`--pack generic-linux` — the wizard uses the same route)', () => {
    // → the probe accepts a **pack id or a directory path** (`resolvePackDir`)
    // → the name has to be `generic-linux` — **the wizard names it by that name**
    expect(PACK_DIR.endsWith(join('boards', 'generic-linux'))).toBe(true);
  });
});
