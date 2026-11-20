/**
 * The criterion of the self-check of the package that asks "**is the code
 * inside the package the newest one**" (added on 2026-11-19).
 *
 * Which bugs it prevents (**this one was hammered out by a real event**):
 *
 * → **2026-11-19**: the operator installed the build → I looked at it →
 *   **the package was running the code from before the fix** (the installer
 *   **00:55**, the fix was committed at **21:38** → **the package was 21
 *   hours older than the fix**).
 * → **The consequence**: in the installed build every card that can write to
 *   the board **permanently showed "degraded"**, while **everything was green
 *   during the development and in the sandbox** — **it is only visible once
 *   it is installed**.
 * → **`check:package` could not see that** — it verified "are the cards
 *   there", and **not "is the code the newest one"**.
 *
 * How the criterion is defined:
 *
 * → **The `out/main/index.js` of the asar and the `out/main/index.js` of the
 *   disk are equal byte by byte** (`npm run dist` runs `electron-vite
 *   build` first → **`out/` is the fresh build** → **the two differ = the
 *   package is stale**).
 * → **The bytes are compared**, not the timestamps (**the timestamps are
 *   changed by `cp`** — unreliable).
 */
import { describe, it, expect } from 'vitest';
import { compareCards, compareBundle } from '../../scripts/check-package';

describe('the self-check of the package · the built-in cards', () => {
  it('**the two sides are identical → it passes**', () => {
    const r = compareCards(['a', 'b'], ['a', 'b']);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.extra).toEqual([]);
  });

  it('**one card is missing in the asar → it fails** (**a stale asar** — that is exactly the kind to catch)', () => {
    const r = compareCards(['a', 'b', 'c'], ['a', 'b']);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['c']);
    expect(r.extra).toEqual([]);
  });

  it('**one card too many in the asar → it fails** (**a stale asar, an old card that was not deleted**)', () => {
    const r = compareCards(['a'], ['a', 'b']);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([]);
    expect(r.extra).toEqual(['b']);
  });

  it('**there is not a single card in `cards/` → it fails** (**not "zero cards also passes"**)', () => {
    expect(compareCards([], []).ok).toBe(false);
  });

  it('**a different order is also right** (**what is compared is the set, not the order**)', () => {
    expect(compareCards(['a', 'b'], ['b', 'a']).ok).toBe(true);
  });
});

describe('the self-check of the package · **is the code inside the package the newest one** (added on 2026-11-19)', () => {
  it('**the two sides are equal byte by byte → it passes**', () => {
    const r = compareBundle(Buffer.from('same bytes'), Buffer.from('same bytes'));
    expect(r.ok).toBe(true);
  });

  it('**the bytes differ → it fails** (**the package is stale** — that is exactly the one the installed build of 2026-11-19 ran into)', () => {
    const r = compareBundle(Buffer.from('old code'), Buffer.from('new code'));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('stale');
  });

  it('**it is not on the disk → it fails** (**not "it is skipped when it is missing"** — that would make the criterion void)', () => {
    const r = compareBundle(Buffer.from('code'), undefined);
    expect(r.ok).toBe(false);
  });

  it('**it is not in the asar → it fails** (**the package carries no main artefact**)', () => {
    const r = compareBundle(undefined, Buffer.from('code'));
    expect(r.ok).toBe(false);
  });

  it('**neither of them is there → it fails** (**"both are missing, never mind" is not allowed**)', () => {
    const r = compareBundle(undefined, undefined);
    expect(r.ok).toBe(false);
  });
});
