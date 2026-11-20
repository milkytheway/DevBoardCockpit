import type { CardInstanceInfo, ConnectionInfo } from '../../shared/ipc-contract';
import type { RuntimeStatus } from '../../shared/runtime-status';
import { cardLook, CARD_GROUPS, type CardLook } from './cards';
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
  /**
   * A sub-heading inside the group. The card catalogue uses this to draw
   * "Pinned" first, then the card's own bucket (performance / memory and
   * temperature / ...).
   * The group id itself stays `cards` so the rows keep their one data shape.
   */
  section?: Localised;
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

/** The status block — the same on every page. */
/** The card catalogue: every installed card, placed or not. */
function cardCatalogue(ctx: SecondaryContext): SecondaryGroup {
  const placed = new Set(ctx.placedSlotKeys);
  const pinned = new Set(ctx.pinnedCardIds ?? []);
  const items: SecondaryItem[] = ctx.cards.map((card) => {
    const key = slotKey(card.cardId, card.connectionId);
    const isPlaced = placed.has(key);
    const look = cardLook(card.cardId);
    const isPinned = pinned.has(card.cardId);
    return {
      id: card.instanceId,
      label: look.name,
      // **Say what the second click will do** —
      // clicking a placed card again removes it; without saying so, that is a
      // **silent deletion**.
      hint: {
        'zh-Hans': `${card.cardId} · ${isPlaced ? '已在主区 · 点击撤下' : '点击摆进主区'}`,
        en: `${card.cardId} · ${isPlaced ? 'in the work area · click to remove' : 'click to place'}`,
      },
      tone: isPlaced ? 'active' : 'default',
      cardId: card.cardId,
      cardTone: look.tone,
      cardIcon: look.icon,
      placed: isPlaced,
      section: isPinned ? { 'zh-Hans': '置顶', en: 'Pinned' } : look.group,
      pinned: isPinned,
      onPin: ctx.onTogglePin ? () => ctx.onTogglePin?.(card.cardId) : undefined,
      onSelect: () => {
        if (isPlaced) ctx.onRemoveCard(card);
        else ctx.onPlaceCard(card);
      },
    };
  });
  // Pinned first, then the card's own bucket, then name. Sorting happens in
  // the data, so the renderer only has to draw the section headings.
  const pinnedLabel = { 'zh-Hans': '置顶', en: 'Pinned' };
  const isPinnedSection = (section: Localised | undefined): boolean =>
    section?.['zh-Hans'] === pinnedLabel['zh-Hans'];
  items.sort((a, b) => {
    const pin = Number(isPinnedSection(b.section)) - Number(isPinnedSection(a.section));
    if (pin !== 0) return pin;
    const group =
      CARD_GROUPS.findIndex((g) => g['zh-Hans'] === a.section?.['zh-Hans']) -
      CARD_GROUPS.findIndex((g) => g['zh-Hans'] === b.section?.['zh-Hans']);
    if (group !== 0) return group;
    return pick(a.label, ctx.locale).localeCompare(pick(b.label, ctx.locale), ctx.locale);
  });
  return { id: 'cards', title: { 'zh-Hans': '卡片', en: 'Cards' }, items };
}

/**
 * The terminal page: how you connect, and what you already opened.
 *
 * "Connections" are the profiles you can attach to; "sessions" are the
 * terminals that are actually running. One profile can have several
 * sessions, so the two lists are not the same thing.
 */
function terminalGroups(ctx: SecondaryContext): SecondaryGroup[] {
  const connections: SecondaryItem[] = ctx.connections.map((connection) => ({
    id: connection.id,
    label: { 'zh-Hans': connection.label, en: connection.label },
    hint: {
      'zh-Hans': `${connection.transport}${connection.boardPack ? ` · ${connection.boardPack}` : ''}`,
      en: `${connection.transport}${connection.boardPack ? ` · ${connection.boardPack}` : ''}`,
    },
    onSelect: () => ctx.onOpenSession(connection.id),
  }));
  const sessions: SecondaryItem[] = ctx.sessions.map((session) => ({
    id: session.sessionId,
    label: { 'zh-Hans': session.label, en: session.label },
    hint: { 'zh-Hans': session.sessionId.slice(0, 8), en: session.sessionId.slice(0, 8) },
    tone: session.sessionId === ctx.activeSessionId ? ('active' as const) : ('default' as const),
    sessionId: session.sessionId,
    onSelect: () => ctx.onSelectSession(session.sessionId),
    // **A session has to be closable**: a serial or SSH connection is exclusive,
    // and without a way to close it the port stays held.
    onClose: () => ctx.onCloseSession(session.sessionId),
  }));
  return [
    {
      id: 'connections',
      title: { 'zh-Hans': '连接方式', en: 'Connections' },
      items: connections,
    },
    { id: 'sessions', title: { 'zh-Hans': '会话', en: 'Sessions' }, items: sessions },
  ];
}

/**
 * The files page: file transfer needs a **live session** — the host keeps
 * connections by session id, not by profile id.
 */
function fileGroups(ctx: SecondaryContext): SecondaryGroup[] {
  const sessions: SecondaryItem[] = ctx.sessions.map((session) => ({
    id: session.sessionId,
    label: { 'zh-Hans': session.label, en: session.label },
    hint: { 'zh-Hans': session.sessionId.slice(0, 8), en: session.sessionId.slice(0, 8) },
    tone: session.sessionId === ctx.activeSessionId ? ('active' as const) : ('default' as const),
    sessionId: session.sessionId,
    onSelect: () => ctx.onSelectSession(session.sessionId),
    onClose: () => ctx.onCloseSession(session.sessionId),
  }));
  return [
    {
      id: 'sessions',
      title: { 'zh-Hans': '对象（可传文件的会话）', en: 'Targets (sessions that can transfer files)' },
      items: sessions,
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

function settingsGroups(ctx: SecondaryContext): SecondaryGroup[] {
  return [
    {
      id: 'settings',
      title: { 'zh-Hans': '设置', en: 'Settings' },
      items: [
        {
          id: 'appearance',
          label: { 'zh-Hans': '外观', en: 'Appearance' },
          hint: { 'zh-Hans': '深色 / 浅色', en: 'Dark / light' },
        },
        {
          id: 'cards',
          label: { 'zh-Hans': '卡片目录', en: 'Card catalogue' },
          hint: {
            'zh-Hans': `${ctx.cards.length} 张已装`,
            en: `${ctx.cards.length} installed`,
          },
        },
        {
          id: 'connections',
          label: { 'zh-Hans': '连接', en: 'Connections' },
          hint: {
            'zh-Hans': `${ctx.connections.length} 个 profile`,
            en: `${ctx.connections.length} profiles`,
          },
        },
      ],
    },
  ];
}

/** The sidebar content for one page. */
export function secondaryGroupsFor(page: PageId, ctx: SecondaryContext): SecondaryGroup[] {
  switch (page) {
    case 'workbench':
      return [cardCatalogue(ctx)];
    case 'terminal':
      return terminalGroups(ctx);
    case 'files':
      return fileGroups(ctx);
    case 'logs':
      return logGroups(ctx);
    case 'library':
      return libraryGroups(ctx);
    case 'settings':
      return settingsGroups(ctx);
    default:
      return [];
  }
}
