import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * **Persistence** of the layout (the core-track part).
 *
 * ── What it is ──
 *
 * "Which card sits in which cell" is **the host's book**: the contract
 * `spec/03` §7 says "where the binding happens: in the layout layer, a layout
 * cell records `(cardId, connectionId)`". A card does not know where it is, and
 * the page must not keep track of it either (a refresh would lose it).
 *
 * ── The key is `(cardId, connectionId)` ──
 *
 * The contract `spec/03` §7.8: one card can have an instance on each of
 * several connections → each instance **occupies its own cell**. Keying on
 * `cardId` alone would collide (two cards pushed into the same cell).
 *
 * ── One layout (no more views) ──
 *
 * From v3 the layout is a single one (which cards are placed in the main area).
 * Older files are still readable: v1 (`{units, updatedAt}`) is used as is,
 * v2 (multiple views) takes **the current view**.
 *
 * ── Why persistence must not throw on a broken file ──
 *
 * The layout file lives in the user directory; it may be half-written or
 * hand-edited into a broken state.
 * **One broken file must not stop the app from starting** — that would turn a
 * layout problem of the user into a problem of the application.
 * → If it cannot be read, treat it as an empty layout (the user places the
 * cards again) and leave the broken file as it is (do not overwrite it, so the
 * user's state is not destroyed).
 */

// **The shape lives in `shared/`** (it has to cross IPC) — it is re-exported here so that callers do not have to change their import
export type { LayoutUnit, LayoutState } from '../../shared/layout';

import { normalizeLayout } from '../../shared/layout';
import type { LayoutState, LayoutStateInput } from '../../shared/layout';

export class LayoutStore {
  constructor(private readonly deps: { file: string; now: () => number }) {}

  /** Reads the layout. **If it cannot be read the layout is empty** (no throw; v1/v2 files are still readable) */
  get(): LayoutState {
    const now = this.deps.now();
    if (!existsSync(this.deps.file)) return normalizeLayout(undefined, now);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.deps.file, 'utf8'));
    } catch {
      // **A broken file → treated as empty** (not a reason to crash)
      return normalizeLayout(undefined, now);
    }
    return normalizeLayout(parsed, now);
  }

  /** Stores the layout (**atomic write**: write a temporary file and rename it — a power cut halfway through must not corrupt it) */
  set(state: LayoutStateInput): void {
    state = normalizeLayout(state, this.deps.now());
    const file = this.deps.file;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    // **The rename is atomic** (within the same filesystem)
    renameSync(tmp, file);
  }
}
