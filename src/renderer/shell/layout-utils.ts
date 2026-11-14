import type { CardInstanceInfo } from '../../shared/ipc-contract';
import type { LayoutUnit } from '../../shared/layout';

export function slotKey(cardId: string, connectionId: string | null): string {
  return cardId + '::' + (connectionId ?? '');
}

export function splitKey(key: string): { cardId: string; connectionId: string | null } {
  const at = key.indexOf('::');
  if (at < 0) return { cardId: key, connectionId: null };
  const connectionId = key.slice(at + 2);
  return { cardId: key.slice(0, at), connectionId: connectionId === '' ? null : connectionId };
}

function overlaps(a: LayoutUnit, b: LayoutUnit): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Tag filter pattern (`*` is the only wildcard). Matching ignores case because
 * tag names are lower-case by convention but users type what they remember.
 */
export function matchTagPattern(tag: string, pattern: string): boolean {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return false;
  const source = trimmed.split('*').map(escapeRegExp).join('.*');
  return new RegExp('^' + source + '$', 'i').test(tag);
}

/** Empty filter list means "show everything" (not "show nothing"). */
export function matchesTagFilters(tag: string, filters: readonly string[]): boolean {
  return filters.length === 0 || filters.some((pattern) => matchTagPattern(tag, pattern));
}

/** Drop cards hidden in the current view (keys are `slotKey`). */
export function filterCardsByHidden(
  cards: readonly CardInstanceInfo[],
  hidden: readonly string[],
): CardInstanceInfo[] {
  if (hidden.length === 0) return [...cards];
  const set = new Set(hidden);
  return cards.filter((card) => !set.has(slotKey(card.cardId, card.connectionId)));
}

export function filterUnitsByHidden(
  units: readonly LayoutUnit[],
  hidden: readonly string[],
): LayoutUnit[] {
  if (hidden.length === 0) return [...units];
  const set = new Set(hidden);
  return units.filter((unit) => !set.has(slotKey(unit.cardId, unit.connectionId)));
}

/**
 * Main returns a unit for every installed card, but cards that were never moved
 * all share (0,0) — the grid must not render them on top of each other.
 * This is a pure helper so the packing rule can be unit-tested.
 */
export function resolveLayout(cards: CardInstanceInfo[], units: LayoutUnit[]): LayoutUnit[] {
  const byKey = new Map<string, LayoutUnit>();
  for (const unit of units) byKey.set(slotKey(unit.cardId, unit.connectionId), unit);

  const placed: LayoutUnit[] = [];
  const ordered = [...cards].sort((a, b) => a.cardId.localeCompare(b.cardId));
  for (const card of ordered) {
    const key = slotKey(card.cardId, card.connectionId);
    const found = byKey.get(key);
    const unit: LayoutUnit = found
      ? { ...found }
      : { cardId: card.cardId, connectionId: card.connectionId, x: 0, y: 0, w: 4, h: 2 };
    // Stack colliding cards downward; the user can drag them anywhere afterwards.
    let guard = 0;
    while (placed.some((other) => overlaps(unit, other)) && guard < 64) {
      unit.y += 1;
      guard += 1;
    }
    placed.push(unit);
  }
  return placed;
}
