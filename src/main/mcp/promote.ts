import type { LayoutState, LayoutUnit } from '../../shared/layout';

/**
 * **把一张卡提为全屏**（契约 `spec/04` §2.5 ✓ · ADR-D40 ✓）。
 *
 * ── 它改的是布局** ✓ ──
 *
 * → **全屏是布局的一个状态** ✓（`LayoutState.promoted` ✓），**不是**一次性的渲染指令 ✓。
 *
 * ── 为什么宿主侧**不**算「铺满几行」──
 *
 * **行高与视口高度只有 renderer 知道** ✓（`ROW_HEIGHT` 是渲染层的常量 ✓）。
 * → **宿主记「谁要全屏」✓，渲染层算「铺几行」✓** —— **两边都不猜** ✓。
 *
 * → **这个取舍要写进契约** ✓（v5 说「由宿主按视口算」✓ → **改成「渲染层按视口算」** ✓）。
 *
 * ── 「让开」在布局模型里怎么表达 ──
 *
 * `LayoutUnit` 只有 6 个字段 ✓ —— **没有「隐藏」这个概念** ✓ → **不删、不隐藏** ✓
 * → 其它格**保持自己的 w/h** ✓，`y` **统一后移** ✓。
 */
export interface PromoteResult {
  ok: boolean;
  mode?: 'fullscreen';
  reason?: 'not_found' | 'invalid_params' | 'failed';
  detail?: string;
  /** 改完之后的布局 ✓（**调用方要存** ✓） */
  layout?: LayoutState;
}

/**
 * 提为全屏。
 *
 * @param state 当前布局
 * @param cardId 要提哪张卡
 * @param connectionId 哪条连接（**缺省 = 该卡唯一的实例** ✓ · **多于一个时报错** ✓ —— 不猜 ✓）
 */
export function promoteCard(
  state: LayoutState,
  cardId: string,
  connectionId: string | undefined,
): PromoteResult {
  // ── 找到那一格 ──
  const candidates = state.units.filter((u) => u.cardId === cardId);
  if (candidates.length === 0) {
    return { ok: false, reason: 'not_found', detail: `This card is not in the main area: ${cardId}` };
  }

  let target: LayoutUnit;
  if (connectionId !== undefined) {
    const found = candidates.find((u) => u.connectionId === connectionId);
    if (found === undefined) {
      return { ok: false, reason: 'not_found', detail: `This card is not on that connection: ${connectionId}` };
    }
    target = found;
  } else {
    // **缺省 = 该卡唯一的实例** ✓ —— **多于一个就报错** ✓（不猜 ✓）
    if (candidates.length > 1) {
      return {
        ok: false,
        reason: 'invalid_params',
        detail: `This card has ${candidates.length} instances, so it is ambiguous which one to promote (give connectionId)`,
      };
    }
    target = candidates[0] as LayoutUnit;
  }

  // ── 记「谁要全屏」✓（**渲染层去算铺几行** ✓）──
  return {
    ok: true,
    mode: 'fullscreen',
    layout: { ...state, promoted: { ...target } },
  };
}
