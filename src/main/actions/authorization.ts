import type { ActionDef, PackGuard, PackParam } from '../tags/schema';

/**
 * 授权 —— 契约 `docs/spec/02-board-pack.md` §5.5 + `spec/04` §2.4。
 *
 * ── **只有两条判据**（**2026-11-16 砍完** ✓ · ADR-D48 ✓）──
 *
 * | 判据 | 不满足时 |
 * |---|---|
 * | **这个动作在授权集里吗** ✓（**卡片的 manifest 声明** ✓ / **agent 的授权集 = 当前包的全部动作** ✓） | **拒绝** ✓ |
 * | **参数落在 `guard` 域内吗** ✓（**guard 是包作者划的界** ✓ —— 契约 §5.5 ✓） | **拒绝** ✓ |
 *
 * ── **不再有「停下来问人」** ✓ ──
 *
 * → **destructive 只是信息** ✓（**设置页的权限区里写着** ✓ —— 「**开启权限默认知道危险性**」✓）。
 * → **命中危险地板不再要确认** ✓（**地板是校验与显示用的** ✓ —— 契约 §5.2.1 ✓）。
 * → **超 guard 域 → 拒绝** ✓（**不是「问不问」** ✓ —— **那是包作者划的界** ✓）。
 *
 * → **要控制什么，去设置里的统一权限区** ✓（**ADR-D47** ✓）—— **一个地方一个开关** ✓。
 */

/** 已授权的动作（装卡时用户批准的） */
export interface GrantedActions {
  /**
   * 动作 id → 批准的参数域（**按参数名**，形状与动作自己的 `guard` 一样）。
   *
   * `undefined` = 批准了这个动作，但**没有缩小**参数域
   * （等价于 guard = 参数自己声明的完整域）。
   */
  actions: Record<string, Record<string, PackGuard> | undefined>;
}

/** 授权的结论（**2026-11-16：没有「要确认」这一档了** ✓ —— ADR-D48 ✓） */
export type AuthorizationVerdict = 'ok' | 'denied';

/** 授权结果 */
export interface AuthorizationResult {
  verdict: AuthorizationVerdict;
  /** 给人看的一句话 */
  detail?: string;
  /** 哪个参数超了域（说清楚是哪一条** ✓） */
  param?: string;
}

/** 一个值落在这个域里吗 */
function withinRange(value: unknown, range: { min?: number; max?: number } | undefined): boolean {
  if (range === undefined) return true;
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (range.min !== undefined && value < range.min) return false;
  if (range.max !== undefined && value > range.max) return false;
  return true;
}

/**
 * 判断这个动作能不能直接执行（**不满足就是拒绝** ✓ —— **没有第三种** ✓）。
 *
 * @param action 板型包里声明的动作
 * @param params 本次调用的**原始**参数值
 * @param granted 授权集（**卡片的 manifest 声明** ✓ / **agent 的 = 当前包的全部动作** ✓）
 */
export function authorize(
  action: ActionDef,
  params: Record<string, unknown>,
  granted: GrantedActions,
): AuthorizationResult {
  // 1) 授权集里有没有这个动作
  if (!Object.prototype.hasOwnProperty.call(granted.actions, action.id)) {
    return { verdict: 'denied', detail: `动作「${action.id}」没有获得授权` };
  }

  // 2) 参数域：**guard 是包作者划的界** ✓（契约 §5.5 ✓）
  //    → **超出去就拒绝** ✓（**不是「要不要问」** ✓ —— ADR-D48 ✓）
  const grantedDomain = granted.actions[action.id];
  const guard = action.guard ?? {};
  for (const [name, spec] of Object.entries(action.params ?? {})) {
    const paramSpec = spec as PackParam;
    // **参数域只管数值参数**——min/max 是数字，
    // 套到 string/enum 上只会得到「永远超出」这种假拒绝。
    // （字符串的长度由 `maxLength` 管，编码器已经拒了。）
    if (paramSpec.type !== 'integer' && paramSpec.type !== 'number') continue;
    const range =
      grantedDomain?.[name] ?? guard[name] ?? { min: paramSpec.min, max: paramSpec.max };
    if (!withinRange(params[name], range)) {
      return {
        verdict: 'denied',
        param: name,
        detail: `参数「${name}」超出了这个动作允许的范围（${describeRange(range)}）`,
      };
    }
  }

  return { verdict: 'ok' };
}

/** 把范围说成人话 */
function describeRange(range: { min?: number; max?: number }): string {
  if (range.min !== undefined && range.max !== undefined) return `${range.min} .. ${range.max}`;
  if (range.min !== undefined) return `≥ ${range.min}`;
  if (range.max !== undefined) return `≤ ${range.max}`;
  return '（没有限制）';
}
