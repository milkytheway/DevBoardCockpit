import type { LayoutState, LayoutUnit } from '../../shared/layout';

/**
 * **Promotes a card to full screen** (contract `spec/04` §2.5 ✓ · ADR-D40 ✓).
 *
 * ── What it changes is the layout ** ✓ ──
 *
 * → **Full screen is a state of the layout** ✓ (`LayoutState.promoted` ✓),
 * **not** a one-off rendering instruction ✓.
 *
 * ── Why the host does **not** compute "how many rows it fills" ──
 *
 * **Only the renderer knows the row height and the height of the viewport** ✓
 * (`ROW_HEIGHT` is a constant of the rendering layer ✓).
 * → **The host records "who wants to be full screen" ✓, the rendering layer
 *   computes "how many rows it fills" ✓** — **neither side guesses** ✓.
 *
 * → **This trade-off has to be written into the contract** ✓ (v5 says "the
 *   host computes it from the viewport" ✓ → **changed to "the rendering layer
 *   computes it from the viewport"** ✓).
 *
 * ── How "make room" is expressed in the layout model ──
 *
 * A `LayoutUnit` has only 6 fields ✓ — there is **no "hidden" concept** ✓ →
 * **nothing is removed and nothing is hidden** ✓
 * → the other cells **keep their own w/h** ✓ and their `y` is **moved down
 *   uniformly** ✓.
 */
export interface PromoteResult {
  ok: boolean;
  mode?: 'fullscreen';
  reason?: 'not_found' | 'invalid_params' | 'failed';
  detail?: string;
  /** The layout after the change ✓ (**the caller has to store it** ✓) */
  layout?: LayoutState;
}

/**
 * Promotes to full screen.
 *
 * @param state the current layout
 * @param cardId which card to promote
 * @param connectionId which connection (**the default = the only instance of
 *        that card** ✓ · **an error when there is more than one** ✓ — no
 *        guessing ✓)
 */
export function promoteCard(
  state: LayoutState,
  cardId: string,
  connectionId: string | undefined,
): PromoteResult {
  // ── Find that cell ──
  const candidates = state.units.filter((u) => u.cardId === cardId);
  if (candidates.length === 0) {
    return { ok: false, reason: 'not_found', detail: `This card is not in the main area: ${cardId}` };
  }

  let target: LayoutUnit;
  if (connectionId !== undefined) {
    const found = candidates.find((u) => u.connectionId === connectionId);
    if (found === undefined) {
      return { ok: false, reason: 'not_found', detail: `This card is not on that connection: ${connectionId}` };
    }
    target = found;
  } else {
    // **The default = the only instance of that card** ✓ — **an error when there is more than one** ✓ (no guessing ✓)
    if (candidates.length > 1) {
      return {
        ok: false,
        reason: 'invalid_params',
        detail: `This card has ${candidates.length} instances, so it is ambiguous which one to promote (give connectionId)`,
      };
    }
    target = candidates[0] as LayoutUnit;
  }

  // ── Record "who wants to be full screen" ✓ (**the rendering layer computes how many rows it fills** ✓) ──
  return {
    ok: true,
    mode: 'fullscreen',
    layout: { ...state, promoted: { ...target } },
  };
}
