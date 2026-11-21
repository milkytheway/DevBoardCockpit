import type { CardInstanceInfo, ConnectionInfo, FileEndpointInfo } from '../../shared/ipc-contract';
import type { RuntimeStatus } from '../../shared/runtime-status';
import { cardLook, CARD_GROUPS, type CardLook } from './cards';
import {
  boardOfSession,
  boardsIn,
  currentBoard,
  machineConnections,
} from './board-scope';
import { pick, type Localised } from './i18n';
import { slotKey } from './layout-utils';
import type { ActivityEntry, ActivityLevel, PageId, TerminalTab } from './types';

/**
 * The **secondary sidebar**: what you can pick, for the page you are on.
 *
 * ── why it is data, not components ──
 *
 * Every page needs its own list of options, but they all behave the same
 * way (a list of rows, one of them selected). So the *content* is data and
 * the *renderer* is one component. Adding a page means adding a data
 * function, not a new component.
 *
 * ── the shape of every page's sidebar ──
 *
 * 1. **Status** — always first, always the same: who we are talking to and
 *    whether the link is alive. It answers "is the board up?" before any
 *    list is read.
 * 2. **The page's own options** — the cards you can place, the connections
 *    you can open, the sessions that are running.
 */
export interface SecondaryItem {
  id: string;
  label: Localised;
  /** A second line: the transport, the card id, the exit code… */
  hint?: Localised;
  /** Visual weight. `active` marks the current selection. */
  tone?: 'default' | 'active' | 'muted';
  /** A short counter on the right (e.g. how many cards). */
  badge?: string;
  /** Called when the row is clicked. */
  onSelect?: () => void;
  /**
   * A **close** button on the row.
   *
   * **Why a session needs it**: a serial or SSH connection is **exclusive** —
   * without a way to close it, the connection keeps holding the port and the
   * only way out is to restart the application.
   */
  onClose?: () => void;
  /** The card id — the stable e2e hook (`data-cockpit-card-id`). */
  cardId?: string;
  /** Card family tone/icon: the catalogue draws the same pictogram as the card. */
  cardTone?: CardLook['tone'];
  cardIcon?: CardLook['icon'];
  /** Whether this card is currently placed in the main area. */
  placed?: boolean;
  /** The session id — the stable e2e hook (`data-cockpit-session-id`). */
  sessionId?: string;
  /** Whether this card is pinned to the top of the catalogue. */
  pinned?: boolean;
  /** Toggle the pin. Drawn as a star outside the row button. */
  onPin?: () => void;
}

export interface SecondaryGroup {
  id: string;
  title: Localised;
  items: SecondaryItem[];
}

/** Everything the sidebar needs to build its lists. */
export interface SecondaryContext {
  /** The interface language. The sidebar builds its labels from it. */
  locale: import('./i18n').Locale;
  runtime: RuntimeStatus;
  connections: ConnectionInfo[];
  cards: CardInstanceInfo[];
  /**
   * The **slot keys** of the cards that are placed in the main area right now.
   *
   * **The key is (cardId, connectionId), not cardId** —
   * a card has one instance per connection (contract §7.8), and each occupies
   * its own cell. Judging by cardId alone, after a connection switch the
   * catalogue would say "already in the main area" while the main area does
   * not hold it, and the next click would only try to remove it (filtered by
   * the current connection key, nothing is removed) →
   * **the card could never be placed on the new connection**.
   */
  placedSlotKeys: string[];
  sessions: TerminalTab[];
  activeSessionId: string | null;
  /**
   * **The link that carries the files** ✓ (`null` = there is none ✓).
   *
   * → The files page does not need a terminal session ✓ → the host picks
   *   the link ✓ → the sidebar says which one ✓.
   */
  fileEndpoint?: FileEndpointInfo | null;
  activity: ActivityEntry[];
  activityFilter: 'all' | ActivityLevel;
  onActivityFilter: (filter: 'all' | ActivityLevel) => void;
  onPlaceCard: (card: CardInstanceInfo) => void;
  onRemoveCard: (card: CardInstanceInfo) => void;
  onOpenSession: (profileId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  /** Card ids the user pinned to the top of the catalogue (optional). */
  pinnedCardIds?: string[];
  onTogglePin?: (cardId: string) => void;
}

/** The card catalogue: every installed card, placed or not. */
function cardCatalogue(ctx: SecondaryContext): SecondaryGroup[] {
  const placed = new Set(ctx.placedSlotKeys);
  const pinned = new Set(ctx.pinnedCardIds ?? []);
  const groupOf = new Map(
    ctx.cards.map((card) => [card.instanceId, cardLook(card.cardId).group['zh-Hans']]),
  );
  const items: SecondaryItem[] = ctx.cards.map((card) => {
    const key = slotKey(card.cardId, card.connectionId);
    const isPlaced = placed.has(key);
    const look = cardLook(card.cardId);
    const isPinned = pinned.has(card.cardId);
    return {
      id: card.instanceId,
      label: look.name,
      hint: { 'zh-Hans': card.cardId, en: card.cardId },
      tone: isPlaced ? 'active' : 'default',
      cardId: card.cardId,
      cardTone: look.tone,
      cardIcon: look.icon,
      placed: isPlaced,
      pinned: isPinned,
      onPin: ctx.onTogglePin ? () => ctx.onTogglePin?.(card.cardId) : undefined,
      onSelect: () => {
        if (isPlaced) ctx.onRemoveCard(card);
        else ctx.onPlaceCard(card);
      },
    };
  });
  const pinnedLabel = { 'zh-Hans': '置顶', en: 'Pinned' };
  const byLabel = (a: SecondaryItem, b: SecondaryItem): number =>
    pick(a.label, ctx.locale).localeCompare(pick(b.label, ctx.locale), ctx.locale);
  const groups: SecondaryGroup[] = [];
  const pinnedItems = items.filter((item) => item.pinned).sort(byLabel);
  if (pinnedItems.length > 0) {
    groups.push({ id: 'cards:pinned', title: pinnedLabel, items: pinnedItems });
  }
  const groupIds = ['performance', 'memory', 'system', 'custom'];
  for (const [index, group] of CARD_GROUPS.entries()) {
    const groupItems = items
      .filter(
        (item) =>
          item.pinned !== true && groupOf.get(item.id) === group['zh-Hans'],
      )
      .sort(byLabel);
    if (groupItems.length > 0) {
      groups.push({ id: `cards:${groupIds[index] ?? 'custom'}`, title: group, items: groupItems });
    }
  }
  return groups;
}

/**
 * The terminal page: how you connect, and what you already opened.
 *
 * "Connections" are the profiles you can attach to; "sessions" are the
 * terminals that are actually running. One profile can have several
 * sessions, so the two lists are not the same thing.
 *
 * ── every group says which board it is** ✓
 *
 * → A board has three connections ✓ and the machine may have **several
 *   boards** ✓ (the real one ✓ and the synthetic one ✓) → a flat list puts
 *   the terminal of one board **under the other** ✓ → the user cannot tell
 *   whose terminal they are looking at ✓.
 * → So the connections and the sessions are **grouped by board** ✓ and the
 *   group heading carries the board's identity ✓ (`device_key` ✓ — **not an
 *   invented name** ✓).
 * → The connections that are not boards (the host's own shell ✓ · the guest
 *   ✓) are a group of their own ✓ — they are **machines** ✓.
 */
function terminalGroups(ctx: SecondaryContext): SecondaryGroup[] {
  const groups: SecondaryGroup[] = [];

  const boardTitle = (board: string): Localised => ({
    'zh-Hans': `板子 · ${board}`,
    en: `Board · ${board}`,
  });
  const machineTitle: Localised = { 'zh-Hans': '机器', en: 'Machines' };

  /** One row per connection ✓ */
  const connectionRow = (connection: ConnectionInfo): SecondaryItem => ({
    id: connection.id,
    label: { 'zh-Hans': connection.label, en: connection.label },
    hint: {
      'zh-Hans': `${connection.transport}${connection.boardPack ? ` · ${connection.boardPack}` : ''}`,
      en: `${connection.transport}${connection.boardPack ? ` · ${connection.boardPack}` : ''}`,
    },
    onSelect: () => ctx.onOpenSession(connection.id),
  });

  /** One row per session ✓ */
  const sessionRow = (session: TerminalTab): SecondaryItem => ({
    id: session.sessionId,
    label: { 'zh-Hans': session.label, en: session.label },
    hint: { 'zh-Hans': session.sessionId.slice(0, 8), en: session.sessionId.slice(0, 8) },
    tone:
      session.sessionId === ctx.activeSessionId ? ('active' as const) : ('default' as const),
    sessionId: session.sessionId,
    onSelect: () => ctx.onSelectSession(session.sessionId),
    // **A session has to be closable**: a serial or SSH connection is exclusive,
    // and without a way to close it the port stays held.
    onClose: () => ctx.onCloseSession(session.sessionId),
  });

  // ── The connections, one group per board ✓ ──
  // → **Only the board that is current** ✓ (plus the machines ✓) → a
  //   connection of another board would open a session that the page does
  //   not show ✓ → that is confusing ✗ → **you switch the board first** ✓
  //   (the picker at the top ✓).
  const board = currentBoard(ctx.connections);
  for (const key of board === null ? boardsIn(ctx.connections) : [board]) {
    const items: SecondaryItem[] = ctx.connections
      .filter(
        (connection) =>
          connection.boardPack !== null && connection.deviceKey === key,
      )
      .map(connectionRow);
    // → **A group with no rows is not drawn** ✓ (an empty group says nothing
    //   ✓ and it looks like a board that is there but has nothing ✗).
    if (items.length === 0) continue;
    groups.push({ id: `connections:${key}`, title: boardTitle(key), items });
  }
  const machines = machineConnections(ctx.connections);
  if (machines.length > 0) {
    groups.push({
      id: 'connections:machines',
      title: machineTitle,
      items: machines.map(connectionRow),
    });
  }

  // ── The sessions ✓ ──
  // → **The board that is current** ✓ (its own group ✓) · **the machines** ✓
  //   (their own group ✓ — they are not boards ✓) · **the other boards** ✓
  //   (one group ✓ — they have to stay closable ✓ · a serial port is
  //   exclusive ✓) → **no board is a peer of the board that is current** ✓
  //   (the fake board's terminal used to sit next to the 3588's ✓ — found on
  //   2026-11-21 ✓).
  const currentSessions = ctx.sessions.filter(
    (session) => boardOfSession(ctx.connections, session) === board,
  );
  if (board !== null && currentSessions.length > 0) {
    groups.push({
      id: `sessions:${board}`,
      title: boardTitle(board),
      items: currentSessions.map(sessionRow),
    });
  }
  const machineSessions = ctx.sessions.filter(
    (session) => boardOfSession(ctx.connections, session) === null,
  );
  if (machineSessions.length > 0) {
    groups.push({ id: 'sessions:machines', title: machineTitle, items: machineSessions.map(sessionRow) });
  }
  const otherSessions = ctx.sessions.filter((session) => {
    const owner = boardOfSession(ctx.connections, session);
    return owner !== null && owner !== board;
  });
  if (otherSessions.length > 0) {
    groups.push({
      id: 'sessions:other-boards',
      title: { 'zh-Hans': '其他板子的会话', en: 'Sessions of other boards' },
      items: otherSessions.map(sessionRow),
    });
  }

  return groups;
}

/**
 * The files page: file transfer needs a **live session** — the host keeps
 * connections by session id, not by profile id.
 */
/**
 * The files page: **the link the host picked** ✓.
 *
 * → The page used to list the **sessions** that could transfer files ✓ →
 *   and it needed one of them to be open ✓ → **the page was empty until
 *   the user opened a terminal** ✗.
 * → Now **the host picks the link** ✓ (ADB → SSH → serial ✓) → the sidebar
 *   says **which link it is** ✓ (a transfer that goes somewhere else is a
 *   surprise ✗).
 */
function fileGroups(ctx: SecondaryContext): SecondaryGroup[] {
  const endpoint = ctx.fileEndpoint;
  if (endpoint === undefined || endpoint === null) return [];
  return [
    {
      id: 'endpoint',
      title: { 'zh-Hans': '传输通道', en: 'Transfer link' },
      items: [
        {
          id: endpoint.profileId,
          label: { 'zh-Hans': endpoint.label, en: endpoint.label },
          hint: {
            'zh-Hans': endpoint.transport,
            en: endpoint.transport,
          },
          tone: 'active' as const,
        },
      ],
    },
  ];
}

function logGroups(ctx: SecondaryContext): SecondaryGroup[] {
  const filters: SecondaryItem[] = (
    [
      ['all', { 'zh-Hans': '全部', en: 'All' }],
      ['info', { 'zh-Hans': '信息', en: 'Info' }],
      ['warn', { 'zh-Hans': '警告', en: 'Warning' }],
      ['error', { 'zh-Hans': '错误', en: 'Error' }],
    ] as const
  ).map(([id, label]) => ({
    id: `filter-${id}`,
    label,
    tone: ctx.activityFilter === id ? ('active' as const) : ('default' as const),
    onSelect: () => ctx.onActivityFilter(id),
  }));
  return [{ id: 'filter', title: { 'zh-Hans': '筛选', en: 'Filter' }, items: filters }];
}

function libraryGroups(ctx: SecondaryContext): SecondaryGroup[] {
  const degraded = ctx.cards.filter((card) => card.degraded).length;
  return [
    {
      id: 'library',
      title: { 'zh-Hans': '筛选', en: 'Filter' },
      items: [
        {
          id: 'all',
          label: { 'zh-Hans': '全部卡片', en: 'All cards' },
          badge: String(ctx.cards.length),
        },
        {
          id: 'degraded',
          label: { 'zh-Hans': '降级的', en: 'Degraded' },
          badge: String(degraded),
          tone: degraded > 0 ? 'muted' : 'default',
        },
      ],
    },
  ];
}

/** The sidebar content for one page. */
export function secondaryGroupsFor(page: PageId, ctx: SecondaryContext): SecondaryGroup[] {
  switch (page) {
    case 'workbench':
      return cardCatalogue(ctx);
    case 'terminal':
      return terminalGroups(ctx);
    case 'files':
      return fileGroups(ctx);
    case 'logs':
      return logGroups(ctx);
    case 'library':
      return libraryGroups(ctx);
    case 'settings':
      return [];
    default:
      return [];
  }
}
