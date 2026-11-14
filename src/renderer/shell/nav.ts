import type { CardInstanceInfo, ConnectionInfo } from '../../shared/ipc-contract';
import type { RuntimeStatus } from '../../shared/runtime-status';
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
  label: string;
  /** A second line: the transport, the card id, the exit code… */
  hint?: string;
  /** Visual weight. `active` marks the current selection. */
  tone?: 'default' | 'active' | 'muted';
  /** A short counter on the right (e.g. how many cards). */
  badge?: string;
  /** Called when the row is clicked. */
  onSelect?: () => void;
  /**
   * A **close** button on the row.
   *
   * **为什么会话需要它**：串口与 SSH 的连接是**独占**的——
   * 没有关闭路径，那个连接就一直占着（用户只能重启应用）。
   */
  onClose?: () => void;
  /** The card id — the stable e2e hook (`data-cockpit-card-id`). */
  cardId?: string;
  /** The session id — the stable e2e hook (`data-cockpit-session-id`). */
  sessionId?: string;
}

export interface SecondaryGroup {
  id: string;
  title: string;
  items: SecondaryItem[];
}

/** Everything the sidebar needs to build its lists. */
export interface SecondaryContext {
  runtime: RuntimeStatus;
  connections: ConnectionInfo[];
  cards: CardInstanceInfo[];
  /**
   * The **slot keys** of the cards that are placed in the main area right now.
   *
   * **键是 (cardId, connectionId)，不是 cardId**——
   * 一张卡在每条连接上各有一个实例（契约 §7.8），各占一个格子。
   * 按 cardId 判的话，换了连接之后目录会说「已在主区」而主区里没有它，
   * 再点只会去移除（按当前连接键过滤 → 什么也没移除）→
   * **这张卡在新连接上再也摆不进去**。
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
}

/** The status block — the same on every page. */
function statusGroup(ctx: SecondaryContext): SecondaryGroup {
  const link =
    ctx.runtime.state === 'running'
      ? '采样中'
      : ctx.runtime.state === 'no-pack'
        ? '未识别板型'
        : ctx.runtime.state === 'error'
          ? '连接失败'
          : '空闲';
  return {
    id: 'status',
    title: '状态',
    items: [
      {
        id: 'status-link',
        label: link,
        hint: ctx.runtime.detail ?? ctx.runtime.profileId ?? '还没有连上任何连接',
        tone: ctx.runtime.state === 'error' ? 'muted' : 'default',
      },
    ],
  };
}

/** The card catalogue: every installed card, placed or not. */
function cardCatalogue(ctx: SecondaryContext): SecondaryGroup {
  const placed = new Set(ctx.placedSlotKeys);
  const items = ctx.cards.map((card) => {
    const key = slotKey(card.cardId, card.connectionId);
    const isPlaced = placed.has(key);
    return {
      id: card.instanceId,
      label: card.cardId,
      // **说清楚第二次点击会发生什么** ——
      // 摆好的卡再点一次是「撤下」，不写出来的话那是一次**静默的删除**。
      hint: isPlaced ? '已在主区 · 点击撤下' : '点击摆进主区',
      tone: isPlaced ? ('active' as const) : ('default' as const),
      cardId: card.cardId,
      onSelect: () => {
        if (isPlaced) ctx.onRemoveCard(card);
        else ctx.onPlaceCard(card);
      },
    };
  });
  return { id: 'cards', title: '卡片', items };
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
    label: connection.label,
    hint: `${connection.transport}${connection.boardPack ? ` · ${connection.boardPack}` : ''}`,
    onSelect: () => ctx.onOpenSession(connection.id),
  }));
  const sessions: SecondaryItem[] = ctx.sessions.map((session) => ({
    id: session.sessionId,
    label: session.label,
    hint: session.sessionId.slice(0, 8),
    tone: session.sessionId === ctx.activeSessionId ? ('active' as const) : ('default' as const),
    sessionId: session.sessionId,
    onSelect: () => ctx.onSelectSession(session.sessionId),
    // **会话要能关**：串口与 SSH 的连接是独占的，没有关闭路径就一直占着。
    onClose: () => ctx.onCloseSession(session.sessionId),
  }));
  return [
    statusGroup(ctx),
    { id: 'connections', title: '连接方式', items: connections },
    { id: 'sessions', title: '会话', items: sessions },
  ];
}

/**
 * The files page: file transfer needs a **live session** — the host keeps
 * connections by session id, not by profile id.
 */
function fileGroups(ctx: SecondaryContext): SecondaryGroup[] {
  const sessions: SecondaryItem[] = ctx.sessions.map((session) => ({
    id: session.sessionId,
    label: session.label,
    hint: session.sessionId.slice(0, 8),
    tone: session.sessionId === ctx.activeSessionId ? ('active' as const) : ('default' as const),
    sessionId: session.sessionId,
    onSelect: () => ctx.onSelectSession(session.sessionId),
    onClose: () => ctx.onCloseSession(session.sessionId),
  }));
  return [
    statusGroup(ctx),
    { id: 'sessions', title: '对象（可传文件的会话）', items: sessions },
  ];
}

function logGroups(ctx: SecondaryContext): SecondaryGroup[] {
  const filters: SecondaryItem[] = (
    [
      ['all', '全部'],
      ['info', '信息'],
      ['warn', '警告'],
      ['error', '错误'],
    ] as const
  ).map(([id, label]) => ({
    id: `filter-${id}`,
    label,
    tone: ctx.activityFilter === id ? ('active' as const) : ('default' as const),
    onSelect: () => ctx.onActivityFilter(id),
  }));
  return [statusGroup(ctx), { id: 'filter', title: '筛选', items: filters }];
}

function libraryGroups(ctx: SecondaryContext): SecondaryGroup[] {
  const degraded = ctx.cards.filter((card) => card.degraded).length;
  return [
    statusGroup(ctx),
    {
      id: 'library',
      title: '筛选',
      items: [
        { id: 'all', label: '全部卡片', badge: String(ctx.cards.length) },
        { id: 'degraded', label: '降级的', badge: String(degraded), tone: degraded > 0 ? 'muted' : 'default' },
      ],
    },
  ];
}

function settingsGroups(ctx: SecondaryContext): SecondaryGroup[] {
  return [
    statusGroup(ctx),
    {
      id: 'settings',
      title: '设置',
      items: [
        { id: 'appearance', label: '外观', hint: '深色 / 浅色' },
        { id: 'cards', label: '卡片目录', hint: `${ctx.cards.length} 张已装` },
        { id: 'connections', label: '连接', hint: `${ctx.connections.length} 个 profile` },
      ],
    },
  ];
}

/** The sidebar content for one page. */
export function secondaryGroupsFor(page: PageId, ctx: SecondaryContext): SecondaryGroup[] {
  switch (page) {
    case 'workbench':
      return [statusGroup(ctx), cardCatalogue(ctx)];
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
      return [statusGroup(ctx)];
  }
}
