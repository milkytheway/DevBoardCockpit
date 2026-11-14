/**
 * 布局的**纯数据形状**（跨进程的那一份）。
 *
 * ── 为什么在 `shared/` 而不在 `main/cards/layout.ts` ──
 *
 * 布局要**过 IPC**（页面读、页面写）→ 形状属于「跨进程约定」→
 * 唯一的住处就是 `shared/`（`src/main/` 的东西页面不许 import）。
 *
 * ── 键是 `(cardId, connectionId)` ──
 *
 * 契约 §7.8：一张卡可以在多条连接上各有一个实例 → 每个实例**各占一格**。
 * 只按 `cardId` 记会撞车（两张卡挤进同一格）。
 *
 * ── 为什么是「每个视图一份布局」 ──
 *
 * UI 总纲 §五：视图是**保存的配置**——切视图只改可见槽位/滤镜/密度，
 * 不重载卡片、不重订数据。布局归视图所有：总览摆好的卡片，
 * 切到调试视图再摆一次，两边互不覆盖。
 *
 * 旧格式（v1，只有 `{units, updatedAt}`）仍能读：落到「总览」视图，
 * 其余视图为空。**不迁移用户数据也读得出来**（读不出才是坏）。
 */

/** 内置视图顺序（与 UI 视图栏一致） */
export const LAYOUT_VIEW_IDS = ['overview', 'monitor', 'debug', 'demo'] as const;

export type LayoutViewId = (typeof LAYOUT_VIEW_IDS)[number];

/** 视图显示名（落盘也用得上：将来允许改名时可迁移） */
export const LAYOUT_VIEW_NAMES: Record<LayoutViewId, string> = {
  overview: '总览',
  monitor: '监控',
  debug: '调试',
  demo: '演示',
};

/** 布局里的一格 */
export interface LayoutUnit {
  /** 卡片 id */
  cardId: string;
  /** 这个格子绑的是哪条连接（`null` = 没有连接上下文） */
  connectionId: string | null;
  /** 格子坐标与尺寸（12 列网格） */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一个视图的布局 */
export interface LayoutView {
  id: LayoutViewId;
  units: LayoutUnit[];
}

/** 整个布局文件（v2） */
export interface LayoutState {
  /** 格式版本；v1 是 `{units, updatedAt}`，没有这个字段 */
  version: 2;
  /** 当前视图（重启后回到这里） */
  activeViewId: LayoutViewId;
  /** 每个视图各一份布局（顺序固定为 LAYOUT_VIEW_IDS） */
  views: LayoutView[];
  /**
   * **当前视图**的格子（兼容字段）。
   *
   * IPC 与旧测试读 `state.units`；写的时候以 `views[activeViewId]` 为准。
   * 两边永远同步（`normalizeLayout` 负责）。
   */
  units: LayoutUnit[];
  /** 最后一次保存的时刻（诊断用） */
  updatedAt: number;
}

/** v1 的落盘形状（读旧文件用；写出去一律 v2） */
export interface LegacyLayoutState {
  units: LayoutUnit[];
  updatedAt: number;
}

/** 布局写入的输入形状：新格式或旧格式都收 */
export type LayoutStateInput = LayoutState | LegacyLayoutState;

/** 一格是不是**形状对**的单元（布局文件是用户能碰的 → 进来之前要收形状） */
export function isLayoutUnit(raw: unknown): raw is LayoutUnit {
  if (raw === null || typeof raw !== 'object') return false;
  const unit = raw as Record<string, unknown>;
  if (typeof unit['cardId'] !== 'string') return false;
  if (unit['connectionId'] !== null && typeof unit['connectionId'] !== 'string') return false;
  const isNumber = (key: string): boolean =>
    typeof unit[key] === 'number' && Number.isFinite(unit[key]);
  return isNumber('x') && isNumber('y') && isNumber('w') && isNumber('h');
}

/** 空布局（四个视图都空） */
export function emptyLayout(now = 0): LayoutState {
  return normalizeLayout(undefined, now);
}

/**
 * 把任意输入收成 v2 形状（**不抛**：读坏文件、读旧文件都走这里）。
 *
 * - 有 `views`：按视图收格子（未知视图丢掉，缺的视图补空）
 * - 没有 `views`（v1）：`units` 落到「总览」，其余视图空
 * - 任何字段坏掉：该字段回默认，不影响其它视图
 */
export function normalizeLayout(raw: unknown, now = 0): LayoutState {
  const record =
    raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const rawViews = record !== null && Array.isArray(record['views']) ? record['views'] : null;

  const views: LayoutView[] = LAYOUT_VIEW_IDS.map((id) => {
    if (rawViews === null) {
      // v1：所有格子在「总览」；其余视图从空开始
      return { id, units: id === 'overview' ? normalizeUnits(record?.['units']) : [] };
    }
    const match = rawViews.find(
      (view) => view !== null && typeof view === 'object' && (view as Record<string, unknown>)['id'] === id,
    ) as Record<string, unknown> | undefined;
    return { id, units: match === undefined ? [] : normalizeUnits(match['units']) };
  });

  const activeViewId = isLayoutViewId(record?.['activeViewId'])
    ? record['activeViewId']
    : 'overview';
  const updatedAtRaw = record?.['updatedAt'];
  const updatedAt =
    typeof updatedAtRaw === 'number' && Number.isFinite(updatedAtRaw) ? updatedAtRaw : now;

  const active = views.find((view) => view.id === activeViewId) ?? views[0];
  return { version: 2, activeViewId: active.id, views, units: active.units, updatedAt };
}

/** 某个视图的格子（未知视图 → 空） */
export function unitsForView(state: LayoutState, viewId: LayoutViewId): LayoutUnit[] {
  return state.views.find((view) => view.id === viewId)?.units ?? [];
}

/**
 * 更新某个视图的格子，并把 `units` 镜像同步过去。
 *
 * 不负责改 `updatedAt`（那是落盘方的时钟）。
 */
export function withViewUnits(
  state: LayoutState,
  viewId: LayoutViewId,
  units: LayoutUnit[],
): LayoutState {
  const views = state.views.map((view) =>
    view.id === viewId ? { id: view.id, units } : view,
  );
  return { ...state, activeViewId: viewId, views, units };
}

function isLayoutViewId(raw: unknown): raw is LayoutViewId {
  return typeof raw === 'string' && (LAYOUT_VIEW_IDS as readonly string[]).includes(raw);
}

function normalizeUnits(raw: unknown): LayoutUnit[] {
  return Array.isArray(raw) ? raw.filter(isLayoutUnit) : [];
}
