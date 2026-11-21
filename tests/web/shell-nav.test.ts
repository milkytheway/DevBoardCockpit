import { describe, it, expect, vi } from 'vitest';
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
  return secondaryGroupsFor('workbench', ctx).flatMap((group) => group.items);
}

describe('Shell · the card catalogue (the work area is decided by the instance key)', () => {
  it('draws semantic card groups instead of one collapsible cards group', () => {
    const groups = secondaryGroupsFor(
      'workbench',
      context({
        cards: [
          card('cpu-usage', 'conn-a'),
          card('core-load', 'conn-a'),
          card('memory', 'conn-a'),
          card('build-deploy', 'conn-a'),
          card('own-card', 'conn-a'),
        ],
      }),
    );
    expect(groups.find((group) => group.id === 'cards')).toBeUndefined();
    expect(groups.find((group) => group.id === 'cards:performance')?.items.map((item) => item.cardId)).toEqual(
      expect.arrayContaining(['cpu-usage', 'core-load']),
    );
    expect(groups.find((group) => group.id === 'cards:memory')?.items.map((item) => item.cardId)).toEqual([
      'memory',
    ]);
    expect(groups.find((group) => group.id === 'cards:system')?.items.map((item) => item.cardId)).toContain(
      'build-deploy',
    );
    expect(groups.find((group) => group.id === 'cards:custom')?.items.map((item) => item.cardId)).toEqual([
      'own-card',
    ]);
  });

  it('a pinned card has its own group and is not duplicated in its semantic group', () => {
    const groups = secondaryGroupsFor(
      'workbench',
      context({
        cards: [card('cpu-usage', 'conn-a'), card('core-load', 'conn-a')],
        pinnedCardIds: ['cpu-usage'],
      }),
    );
    expect(groups.find((group) => group.id === 'cards:pinned')?.items.map((item) => item.cardId)).toEqual([
      'cpu-usage',
    ]);
    expect(groups.find((group) => group.id === 'cards:performance')?.items.map((item) => item.cardId)).toEqual([
      'core-load',
    ]);
  });

  it('the placed card is marked by state and shows its card id, not an explanatory sentence', () => {
    const items = cardItems(
      context({
        cards: [card('cpu-curve', 'conn-a')],
        placedSlotKeys: [slotKey('cpu-curve', 'conn-a')],
      }),
    );
    expect(items[0]?.hint?.['zh-Hans']).toBe('cpu-curve');
    expect(items[0]?.tone).toBe('active');
    expect(items[0]?.placed).toBe(true);
  });

  it('the same card on another connection is not marked as placed', () => {
    const items = cardItems(
      context({
        cards: [card('cpu-curve', 'conn-b')],
        // The unit of the old connection is still in the layout file
        placedSlotKeys: [slotKey('cpu-curve', 'conn-a')],
      }),
    );
    expect(items[0]?.hint?.['zh-Hans']).toBe('cpu-curve');
    expect(items[0]?.tone).toBe('default');
    expect(items[0]?.placed).toBe(false);
  });

  it('clicking a placed card removes it; the minus action communicates the result', () => {
    const onRemoveCard = vi.fn();
    const items = cardItems(
      context({
        cards: [card('cpu-curve', 'conn-a')],
        placedSlotKeys: [slotKey('cpu-curve', 'conn-a')],
        onRemoveCard,
      }),
    );
    items[0]?.onSelect?.();
    expect(onRemoveCard).toHaveBeenCalledTimes(1);
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
    const group = secondaryGroupsFor('terminal', ctx).find((g) => g.id.startsWith('sessions'));
    expect(group).toBeDefined();
    const item = group!.items[0]!;
    expect(item.sessionId).toBe('s-1');
    expect(item.onClose).toBeTypeOf('function');
    expect(item.onSelect).toBeTypeOf('function');
  });

  it('the files page names the link the host picked (a transfer that goes somewhere else is a surprise)', () => {
    // → **The files page does not need a terminal session** ✓ → the host
    //   picks the link ✓ → the sidebar says which one ✓.
    const ctx = context({
      fileEndpoint: {
        id: 'file-endpoint',
        profileId: 'board-adb',
        label: 'Board · ADB',
        transport: 'adb',
        capabilities: { exec: true, pty: false, files: true, exitCode: true },
      },
    });
    const group = secondaryGroupsFor('files', ctx).find((g) => g.id === 'endpoint');
    expect(group).toBeDefined();
    expect(group!.items[0]?.label['zh-Hans']).toBe('Board · ADB');
    expect(group!.items[0]?.hint?.['zh-Hans']).toBe('adb');
  });

  it('the files page draws no group when there is no link (an empty group says nothing)', () => {
    expect(secondaryGroupsFor('files', context({ fileEndpoint: null }))).toEqual([]);
  });
});

/**
 * **One board at a time** ✓ — the sidebar must not make the fake board look
 * like a peer of the 3588 ✓ (found on 2026-11-21 ✓).
 */
function boardConnection(id: string, deviceKey: string, current = false) {
  return {
    id,
    label: id,
    transport: 'adb' as const,
    boardPack: 'rk3588-atk',
    deviceKey,
    current,
    capabilities: { exec: true, pty: false, files: false, exitCode: true },
  };
}

const MACHINE = {
  id: 'local',
  label: 'Local machine',
  transport: 'local' as const,
  boardPack: null,
  deviceKey: 'local',
  current: false,
  capabilities: { exec: true, pty: true, files: true, exitCode: true },
};

describe('Shell · the terminal sidebar (one board at a time)', () => {
  const connections = [
    boardConnection('board-adb', 'ATK-DLRK3588', true),
    boardConnection('fake-board', 'fake-board'),
    MACHINE,
  ];

  it('**a group with no rows is not drawn** ✓ (an empty group looks like a board that is there but has nothing ✓)', () => {
    const groups = secondaryGroupsFor(
      'terminal',
      context({ connections, sessions: [{ sessionId: 's-1', profileId: 'fake-board', label: 'fake' }] }),
    );
    // → The connections of the fake board are not listed ✓ (the board that is
    //   current is the 3588 ✓) → no empty group ✓
    expect(groups.find((g) => g.id === 'connections:fake-board')).toBeUndefined();
    // → Every group that is drawn has rows ✓
    for (const group of groups) {
      expect(group.items.length).toBeGreaterThan(0);
    }
  });

  it('**the sessions of the other boards are in one group** ✓ (they have to stay closable ✓)', () => {
    const groups = secondaryGroupsFor(
      'terminal',
      context({
        connections,
        sessions: [
          { sessionId: 's-real', profileId: 'board-adb', label: 'Board · ADB' },
          { sessionId: 's-fake', profileId: 'fake-board', label: 'fake board' },
        ],
      }),
    );
    const other = groups.find((g) => g.id === 'sessions:other-boards');
    expect(other).toBeDefined();
    expect(other!.items.map((item) => item.sessionId)).toEqual(['s-fake']);
    expect(other!.items[0]?.onClose).toBeTypeOf('function');
  });

  it('**the sessions of the machines are in their own group** ✓', () => {
    const groups = secondaryGroupsFor(
      'terminal',
      context({
        connections,
        sessions: [{ sessionId: 's-local', profileId: 'local', label: 'Local machine' }],
      }),
    );
    const machines = groups.find((g) => g.id === 'sessions:machines');
    expect(machines).toBeDefined();
    expect(machines!.items.map((item) => item.sessionId)).toEqual(['s-local']);
  });
});

describe('Shell · the card catalogue (English)', () => {
  it('the card label switches language while the id stays stable', () => {
    const items = cardItems(
      context({
        locale: 'en',
        cards: [card('cpu-usage', 'conn-a')],
        placedSlotKeys: [slotKey('cpu-usage', 'conn-a')],
      }),
    );
    expect(items[0]?.hint?.en).toBe('cpu-usage');
    expect(items[0]?.label?.en).toBe('CPU usage');
  });
});
