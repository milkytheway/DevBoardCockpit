import { describe, it, expect } from 'vitest';
import type { CardInstanceInfo } from '../../src/shared/ipc-contract';
import type { RuntimeStatus } from '../../src/shared/runtime-status';
import { secondaryGroupsFor, type SecondaryContext } from '../../src/renderer/shell/nav';
import { slotKey } from '../../src/renderer/shell/layout-utils';

/**
 * The data behind the secondary sidebar (`nav.ts`).
 *
 * ── Why it is data, and why that deserves a unit test ──
 *
 * "Which rows there are, in which state, and what a click does" is all data,
 * so it can be checked by reading it, without starting the application. And
 * this is exactly where a silent failure once lived:
 *
 * "already in the work area" used to be decided by the card id alone, while
 * the layout key is (card id, connection id) — the same card on two
 * connections is two instances, each occupying its own cell.
 * → After a connection switch the unit of the old connection was still in the
 * file, so the catalogue said "already in the work area" while the work area
 * did not hold it.
 * → The next click only tried to remove it (filtered by the current connection
 * key, so nothing was removed) →
 * **the card could never be placed on the new connection again**.
 */

function card(cardId: string, connectionId: string | null): CardInstanceInfo {
  return {
    instanceId: `${cardId}@${connectionId ?? 'none'}`,
    cardId,
    url: `cockpit://card/${cardId}@${connectionId ?? 'none'}/index.html`,
    connectionId,
    degraded: false,
  };
}

const RUNTIME: RuntimeStatus = { state: 'idle' };

function context(overrides: Partial<SecondaryContext> = {}): SecondaryContext {
  return {
    locale: 'zh-Hans',
    runtime: RUNTIME,
    connections: [],
    cards: [],
    placedSlotKeys: [],
    sessions: [],
    activeSessionId: null,
    activity: [],
    activityFilter: 'all',
    onActivityFilter: () => undefined,
    onPlaceCard: () => undefined,
    onRemoveCard: () => undefined,
    onOpenSession: () => undefined,
    onSelectSession: () => undefined,
    onCloseSession: () => undefined,
    ...overrides,
  };
}

function cardItems(ctx: SecondaryContext) {
  const group = secondaryGroupsFor('workbench', ctx).find((g) => g.id === 'cards');
  expect(group).toBeDefined();
  return group!.items;
}

describe('Shell · the card catalogue (the work area is decided by the instance key)', () => {
  it('the card that is placed in the work area is hinted as "already in the work area"', () => {
    const items = cardItems(
      context({
        cards: [card('cpu-curve', 'conn-a')],
        placedSlotKeys: [slotKey('cpu-curve', 'conn-a')],
      }),
    );
    expect(items[0]?.hint?.['zh-Hans']).toContain('已在主区');
    expect(items[0]?.tone).toBe('active');
  });

  it('the same card on another connection is not "already in the work area" (it has not been placed there yet)', () => {
    const items = cardItems(
      context({
        cards: [card('cpu-curve', 'conn-b')],
        // The unit of the old connection is still in the layout file
        placedSlotKeys: [slotKey('cpu-curve', 'conn-a')],
      }),
    );
    expect(items[0]?.hint?.['zh-Hans']).toContain('点击摆进主区');
    expect(items[0]?.tone).toBe('default');
  });

  it('clicking a placed card a second time removes it — the hint says so (without it the removal would be silent)', () => {
    const items = cardItems(
      context({
        cards: [card('cpu-curve', 'conn-a')],
        placedSlotKeys: [slotKey('cpu-curve', 'conn-a')],
      }),
    );
    expect(items[0]?.hint?.['zh-Hans']).toContain('撤下');
  });

  it('the card row carries a stable e2e hook (no class names)', () => {
    const items = cardItems(context({ cards: [card('cpu-curve', 'conn-a')] }));
    expect(items[0]?.cardId).toBe('cpu-curve');
  });
});

describe('Shell · the sessions of the terminal page', () => {
  it('the session row has a close button (a serial or SSH connection is exclusive; without a way to close it, it holds the port for good)', () => {
    const ctx = context({
      sessions: [{ sessionId: 's-1', profileId: 'board-serial', label: 'Board · Serial' }],
      activeSessionId: 's-1',
    });
    const group = secondaryGroupsFor('terminal', ctx).find((g) => g.id === 'sessions');
    expect(group).toBeDefined();
    const item = group!.items[0]!;
    expect(item.sessionId).toBe('s-1');
    expect(item.onClose).toBeTypeOf('function');
    expect(item.onSelect).toBeTypeOf('function');
  });

  it('the session row of the files page has a close button too', () => {
    const ctx = context({
      sessions: [{ sessionId: 's-2', profileId: 'board-adb', label: 'Board · ADB' }],
    });
    const group = secondaryGroupsFor('files', ctx).find((g) => g.id === 'sessions');
    expect(group).toBeDefined();
    expect(group!.items[0]?.onClose).toBeTypeOf('function');
  });
});

describe('Shell · the card catalogue (English)', () => {
  it('the same hint has an English wording (the language option of the interface really switches the text)', () => {
    const items = cardItems(
      context({
        locale: 'en',
        cards: [card('cpu-curve', 'conn-a')],
        placedSlotKeys: [slotKey('cpu-curve', 'conn-a')],
      }),
    );
    expect(items[0]?.hint?.en).toContain('click to remove');
    expect(items[0]?.label?.en).not.toContain('已在主区');
  });
});
