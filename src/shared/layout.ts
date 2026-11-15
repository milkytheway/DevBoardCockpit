/**
 * 布局的**纯数据形状**（跨进程的那一份）。
 *
 * ── v3：一个布局，不再有「视图」 ──
 *
 * v2 是「每个视图各存一份」（总览/监控/调试/演示）。
 * 现在**视图这个概念整个退场**了：主区就是一张卡片网格，
 * 左二级是**卡片目录**，你点哪张才把它摆进来。
 * → 一份布局就够了（`units` = 主区摆了哪些）。
 *
 * | 形状 | 字段 | 去向 |
 * |---|---|---|
 * | **v3**（现在） | `version` `units` `density` `updatedAt` | — |
 * | v2 | `views[]` `activeViewId` | **取「当前视图」那份**；**其余视图的布局会丢**（视图退场了，没有地方放） |
 * | v1 | `units` `updatedAt` | 直接用 ✓ |
 *
 * ── 退场的字段与它们去哪了 ──
 *
 * | 退场 | 去向 |
 * |---|---|
 * | `views` / `activeViewId` | 视图没了 → 一个布局 |
 * | `config.hidden`（本视图隐藏的卡） | **「已摆放」= 在 `units` 里** → 不在 `units` 里的就是没摆进主区 |
 * | `config.tagFilter`（读数过滤） | **读数彻底交给卡片** → 宿主不再画读数 → 这个过滤没有消费者了 |
 * | `config.density` | 提为**全局** `density`（放设置页） |
 *
 * ── 旧文件读得出来 ──
 *
 * 布局文件在用户目录里。**读不出来 = 用户白摆了一遍** → 所以
 * v1 与 v2 都要读得出来（v2 取当前视图那份）✓。
 */

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

/**
 * 显示密度（**全局**，不是按视图的）。
 *
 * - `comfortable`：卡片有呼吸空间，行高 72
 * - `compact`：一屏多看几张，行高 48
 */
export type ViewDensity = 'comfortable' | 'compact';

/** 整个布局文件（v3） */
export interface LayoutState {
  /** 格式版本；v1 没有这个字段，v2 是 `2` */
  version: 3;
  /** **主区摆了哪些卡**（没摆进来的卡不在这里） */
  units: LayoutUnit[];
  /** 显示密度（全局） */
  density: ViewDensity;
  /**
   * **被提为全屏的那一格**（**没有就是 `null`** ✓）。
   *
   * → **为什么是布局的一部分** ✓：契约 §2.5 说「`promote_card` **改的是布局**」✓
   *   —— **全屏是一个布局状态** ✓，不是一次性的渲染指令 ✓。
   * → **为什么宿主侧不直接算「铺满几行」** ✓：**它算不出来** ✓ ——
   *   行高与视口高度**只有 renderer 知道** ✓（`ROW_HEIGHT` 是渲染层的常量 ✓）。
   *   → **宿主记「谁要全屏」✓，渲染层算「铺几行」✓** —— **两边都不猜** ✓。
   * → **可空** ✓（老布局文件没有这个字段 ✓ → 读出来是 `null` ✓ → 不是「坏了」✓）。
   */
  promoted?: LayoutUnit | null;
  /** 最后一次保存的时刻（诊断用） */
  updatedAt: number;
}

/** v1 的形状（`{units, updatedAt}`） */
export interface LegacyLayoutState {
  units?: unknown;
  updatedAt?: unknown;
}

/** v2 的形状（多视图） */
export interface LegacyLayoutStateV2 {
  version?: 2;
  units?: unknown;
  updatedAt?: unknown;
  activeViewId?: unknown;
  views?: unknown;
}

/** 布局写入的输入形状：新格式或旧格式都收 */
export type LayoutStateInput = LayoutState | LegacyLayoutState | LegacyLayoutStateV2;

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

/** 空布局（主区空的 —— 你自己摆） */
export function emptyLayout(now = 0): LayoutState {
  return { version: 3, units: [], density: 'comfortable', promoted: null, updatedAt: now };
}

/**
 * 把任意输入收成 v3 形状（**不抛**：读坏文件、读旧文件都走这里）。
 *
 * - **v3**：直接收
 * - **v2**（多视图）：取**当前视图**那份格子与密度。
 *   **其余视图的布局会丢** —— 「视图」这件事已经退场了（v3 只有一份布局，
 *   没有地方放第二个视图的格子）。
 *   → 这不是「合并」，是**只剩一份**；写清楚，免得有人以为数据还在。
 *   （没有存量：M5 没发版，见 `docs/17` 的 L5。）
 * - **v1**：`units` 直接用
 */
export function normalizeLayout(raw: unknown, now = 0): LayoutState {
  if (raw === null || typeof raw !== 'object') return emptyLayout(now);
  const record = raw as Record<string, unknown>;

  // v2：多视图 → 取「当前视图」那份
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

  // v1 / v3：直接收
  return {
    version: 3,
    units: normalizeUnits(record['units']),
    density: readDensity(record['density']),
    promoted: readPromoted(record['promoted']),
    updatedAt: readUpdatedAt(record['updatedAt'], now),
  };
}

/** 换掉主区的格子（拖拽落盘走这里） */
export function withUnits(state: LayoutState, units: LayoutUnit[]): LayoutState {
  return { ...state, units: units.map((u) => ({ ...u })) };
}

/** 换密度（设置页改的走这里） */
export function withDensity(state: LayoutState, density: ViewDensity): LayoutState {
  return { ...state, density };
}

/**
 * 一张卡的**默认格子**（摆进主区时用）。
 *
 * 尺寸来自 manifest 自报的 `layout.w/h`（作者的心愿）；
 * 没报就用 3×2。
 *
 * ── 为什么住在 `shared/` ──
 *
 * 「摆进来时多大」是**两边都要知道**的事：宿主算默认、页面摆格子。
 * 放在一处 → 不会各写一个 3×2 然后慢慢漂移。
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

/** 默认格：3×2 */
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
 * 读「被提为全屏的那一格」✓。
 *
 * → **老布局文件没有这个字段** ✓ → **`null`** ✓（不是「坏了」✓）。
 * → **形状不对也是 `null`** ✓（不猜 ✓）。
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
