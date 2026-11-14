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

/** 整个布局 */
export interface LayoutState {
  units: LayoutUnit[];
  /** 最后一次保存的时刻（诊断用） */
  updatedAt: number;
}
