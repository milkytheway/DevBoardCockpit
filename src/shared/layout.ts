/**
 * The pure data shape of the layout (the copy that crosses the process
 * boundary).
 *
 * ── v3: one layout, no more "views" ──
 *
 * v2 stored one copy per view (overview / monitoring / debugging / demo).
 * The concept of a view has now left the stage entirely: the main area is
 * a grid of cards, the second level on the left is the card catalogue, and
 * a card is placed into it only when you click it. One layout is enough
 * (`units` = which cards are placed in the main area).
 *
 * | Shape | Fields | What happens to it |
 * |---|---|---|
 * | v3 (now) | `version` `units` `density` `updatedAt` | — |
 * | v2 | `views[]` `activeViewId` | The copy of the "current view" is taken; the layouts of the other views are lost (the view has left the stage, there is nowhere to put them) |
 * | v1 | `units` `updatedAt` | Used as it is |
 *
 * ── The retired fields and where they went ──
 *
 * | Retired | Where it went |
 * |---|---|
 * | `views` / `activeViewId` | There are no views any more → one layout |
 * | `config.hidden` (the cards hidden in this view) | "Placed" means "in `units`", so whatever is not in `units` was not placed into the main area |
 * | `config.tagFilter` (the filter on the readings) | The readings went to the cards entirely → the host does not draw readings any more → this filter has no consumer left |
 * | `config.density` | Promoted to the global `density` (it lives on the settings page) |
 *
 * ── Old files can still be read ──
 *
 * The layout file lives in the user directory. Failing to read it means
 * the user arranged everything for nothing, so both v1 and v2 have to be
 * readable (v2 contributes the copy of the current view).
 */

/** One cell of the layout */
export interface LayoutUnit {
  /** The card id */
  cardId: string;
  /** Which connection this cell is bound to (`null` = no connection context) */
  connectionId: string | null;
  /** The position and the size of the cell (a grid of 12 columns) */
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The display density (global, not per view).
 *
 * - `comfortable`: the cards have room to breathe, row height 72
 * - `compact`: more cards fit on one screen, row height 48
 */
export type ViewDensity = 'comfortable' | 'compact';

/** The whole layout file (v3) */
export interface LayoutState {
  /** The format version; v1 has no such field, v2 is `2` */
  version: 3;
  /** Which cards are placed in the main area (cards that were not placed are not here) */
  units: LayoutUnit[];
  /** The display density (global) */
  density: ViewDensity;
  /**
   * The cell that has been promoted to full screen (`null` when there is
   * none).
   *
   * → Why it is part of the layout: contract section 2.5 says that
   *   `promote_card` changes the layout — full screen is a layout state, not
   *   a one-off rendering instruction.
   * → Why the host side does not compute "how many rows to fill" itself: it
   *   cannot compute it — only the renderer knows the row height and the
   *   viewport height (`ROW_HEIGHT` is a constant of the rendering layer).
   *   → The host records "who wants to be full screen" and the rendering
   *   layer computes "how many rows"; neither side guesses.
   * → It is nullable: old layout files do not have this field, so it reads
   *   as `null`, which does not mean "broken".
   */
  promoted?: LayoutUnit | null;
  /** The moment of the last save (for diagnostics) */
  updatedAt: number;
}

/** The shape of v1 (`{units, updatedAt}`) */
export interface LegacyLayoutState {
  units?: unknown;
  updatedAt?: unknown;
}

/** The shape of v2 (multiple views) */
export interface LegacyLayoutStateV2 {
  version?: 2;
  units?: unknown;
  updatedAt?: unknown;
  activeViewId?: unknown;
  views?: unknown;
}

/** The input shape for writing a layout: both the new and the old formats are accepted */
export type LayoutStateInput = LayoutState | LegacyLayoutState | LegacyLayoutStateV2;

/** Whether a cell is a unit of the right shape (the layout file is something the user can touch, so the shape has to be narrowed before it comes in) */
export function isLayoutUnit(raw: unknown): raw is LayoutUnit {
  if (raw === null || typeof raw !== 'object') return false;
  const unit = raw as Record<string, unknown>;
  if (typeof unit['cardId'] !== 'string') return false;
  if (unit['connectionId'] !== null && typeof unit['connectionId'] !== 'string') return false;
  const isNumber = (key: string): boolean =>
    typeof unit[key] === 'number' && Number.isFinite(unit[key]);
  return isNumber('x') && isNumber('y') && isNumber('w') && isNumber('h');
}

/** An empty layout (the main area is empty — you place the cards yourself) */
export function emptyLayout(now = 0): LayoutState {
  return { version: 3, units: [], density: 'comfortable', promoted: null, updatedAt: now };
}

/**
 * Narrows any input into the v3 shape (it never throws: a broken file and an
 * old file both come through here).
 *
 * - v3: taken as it is
 * - v2 (multiple views): the cells and the density of the "current view"
 *   are taken. The layouts of the other views are lost — the concept of a
 *   view has left the stage (v3 has one layout only and nowhere to put the
 *   cells of a second view). This is not a "merge", it is "only one copy
 *   is left"; it is spelled out so that nobody assumes the data is still
 *   there. (There is no legacy data: M5 was never released, see L5 in the
 *   implementation-layer ledger.)
 * - v1: `units` is used as it is
 */
export function normalizeLayout(raw: unknown, now = 0): LayoutState {
  if (raw === null || typeof raw !== 'object') return emptyLayout(now);
  const record = raw as Record<string, unknown>;

  // v2: multiple views → take the copy of the "current view"
  if (Array.isArray(record['views'])) {
    const views = record['views'] as {
      id?: unknown;
      units?: unknown;
      config?: { density?: unknown } | null;
    }[];
    const activeId = typeof record['activeViewId'] === 'string' ? record['activeViewId'] : null;
    const active =
      views.find((v) => v !== null && typeof v === 'object' && v.id === activeId) ??
      views.find((v) => v !== null && typeof v === 'object') ??
      null;
    const density = readDensity(active?.config?.density);
    const units = active === null ? normalizeUnits(record['units']) : normalizeUnits(active.units);
    return {
      version: 3,
      units,
      density,
      promoted: readPromoted(record['promoted']),
      updatedAt: readUpdatedAt(record['updatedAt'], now),
    };
  }

  // v1 / v3: taken as it is
  return {
    version: 3,
    units: normalizeUnits(record['units']),
    density: readDensity(record['density']),
    promoted: readPromoted(record['promoted']),
    updatedAt: readUpdatedAt(record['updatedAt'], now),
  };
}

/** Replaces the cells of the main area (the drag writes through here) */
export function withUnits(state: LayoutState, units: LayoutUnit[]): LayoutState {
  return { ...state, units: units.map((u) => ({ ...u })) };
}

/** Replaces the density (the settings page changes it through here) */
export function withDensity(state: LayoutState, density: ViewDensity): LayoutState {
  return { ...state, density };
}

/**
 * The default cell of a card (used when it is placed into the main area).
 *
 * The size comes from the `layout.w/h` the manifest reports for itself
 * (the author's wish); without one it is 3×2.
 *
 * ── Why it lives in `shared/` ──
 *
 * "How large is it when it is placed" is something both sides have to
 * know: the host computes the default and the page places the cell.
 * Keeping it in one place means nobody writes a 3×2 of their own and lets
 * the two drift apart slowly.
 */
export function defaultUnit(
  cardId: string,
  connectionId: string | null,
  layout?: { w?: number; h?: number },
): LayoutUnit {
  return {
    cardId,
    connectionId,
    x: 0,
    y: 0,
    w: layout?.w ?? DEFAULT_W,
    h: layout?.h ?? DEFAULT_H,
  };
}

/** The default cell: 3×2 */
const DEFAULT_W = 3;
const DEFAULT_H = 2;

function normalizeUnits(raw: unknown): LayoutUnit[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isLayoutUnit).map((u) => ({ ...u }));
}

function readDensity(raw: unknown): ViewDensity {
  return raw === 'compact' ? 'compact' : 'comfortable';
}

/**
 * Reads "the cell that has been promoted to full screen".
 *
 * → Old layout files do not have this field, so the result is `null`
 *   (which does not mean "broken").
 * → A shape that does not fit yields `null` as well (never guess).
 */
function readPromoted(raw: unknown): LayoutUnit | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const unit = raw as Record<string, unknown>;
  if (typeof unit['cardId'] !== 'string') return null;
  const conn = unit['connectionId'];
  const x = unit['x'];
  const y = unit['y'];
  const w = unit['w'];
  const h = unit['h'];
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof w !== 'number' ||
    typeof h !== 'number'
  ) {
    return null;
  }
  return {
    cardId: unit['cardId'],
    connectionId: typeof conn === 'string' ? conn : null,
    x,
    y,
    w,
    h,
  };
}

function readUpdatedAt(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}
