import type { CardInstanceInfo } from '../../shared/ipc-contract';
import { defaultUnit, type LayoutUnit } from '../../shared/layout';

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
      : defaultUnit(card.cardId, card.connectionId);
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
