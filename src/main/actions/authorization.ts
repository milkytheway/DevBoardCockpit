import { createHash, randomUUID } from 'node:crypto';
import type { ActionDef, PackGuard, PackParam } from '../tags/schema';
import type { FloorVerdict } from './floor-check';

/**
 * 授权与确认 —— 契约 `docs/spec/02-board-pack.md` §5.5 + `spec/04` §2.4.1。
 *
 * ── 授权粒度 = 动作 id + 可选参数域 ──
 *
 * | 情形 | 行为 |
 * |---|---|
 * | `reversible` 且参数落在 `guard` 域内 | **直接执行**（仍记审计） |
 * | `reversible` 但参数**超出** `guard` | 走一次确认（与 destructive 同一条通道） |
 * | `destructive` | **必须有人在 GUI 里点确认** |
 * | 动作没被授权 | 拒绝 |
 * | 编码后的命令**命中危险地板** | 按 `destructive` 处理（§5.2.1） |
 *
 * **超出 guard 不是拒绝**：guard 是「装卡时批准的那一档」，
 * 超出它只是**超出了批准范围**——要人再点一次，不是直接不许。
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

/** 授权的结论 */
export type AuthorizationVerdict = 'ok' | 'needs_confirmation' | 'denied';

/** 授权结果 */
export interface AuthorizationResult {
  verdict: AuthorizationVerdict;
  /** 给人看的一句话 */
  detail?: string;
  /** 哪个参数超了域（needs_confirmation 时说清楚） */
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
 * 判断这个动作能不能直接执行。
 *
 * @param action 板型包里声明的动作
 * @param params 本次调用的**原始**参数值
 * @param granted 装卡时用户批准的动作集合
 * @param floor 危险地板的复查结果（命中 → 按 destructive 处理）
 */
export function authorize(
  action: ActionDef,
  params: Record<string, unknown>,
  granted: GrantedActions,
  floor: FloorVerdict,
): AuthorizationResult {
  // 1) 授权集合里有没有这个动作
  if (!Object.prototype.hasOwnProperty.call(granted.actions, action.id)) {
    return { verdict: 'denied', detail: `动作「${action.id}」没有获得授权` };
  }

  // 2) 危险等级：包声明的 **或** 地板命中的（取更严的）
  const dangerous = action.danger === 'destructive' || floor.verdict === 'destructive';
  if (dangerous) {
    return {
      verdict: 'needs_confirmation',
      detail:
        action.danger === 'destructive'
          ? `动作「${action.id}」是破坏性的，要人确认`
          : `命令命中了危险地板（${floor.why ?? '危险命令'}），按破坏性处理，要人确认`,
    };
  }

  // 3) 参数域：**装卡时批准的那一档优先**，没有就用动作自己的 `guard`，
  //    再没有就用参数自己声明的域
  //    （契约 §5.5：「没有声明 guard → 等价于 guard = 参数的完整声明域」）
  const grantedDomain = granted.actions[action.id];
  const guard = action.guard ?? {};
  for (const [name, spec] of Object.entries(action.params ?? {})) {
    const paramSpec = spec as PackParam;
    const range =
      grantedDomain?.[name] ?? guard[name] ?? { min: paramSpec.min, max: paramSpec.max };
    if (!withinRange(params[name], range)) {
      return {
        verdict: 'needs_confirmation',
        param: name,
        detail: `参数「${name}」超出了批准的范围（${describeRange(range)}），要人确认`,
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

/** 凭据的有效期（5 分钟） */
export const CONFIRM_TTL_MS = 5 * 60_000;

/** 参数的规范化摘要（凭据绑的是「这一次的这些参数」） */
export function paramsDigest(params: Record<string, unknown>): string {
  const normalized = Object.keys(params)
    .sort()
    .map((key) => `${key}=${JSON.stringify(params[key])}`)
    .join('&');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

/**
 * 确认凭据的签发与消费。
 *
 * ── 凭据绑什么 ──
 *
 * `(动作 id, 参数规范化摘要, 板型包 id, 契约版本)` —— 一次确认**只**管这一次。
 * 改了参数、换了动作、换了包、契约升了版 → 原来的确认**作废**。
 *
 * ── 一次性 ──
 *
 * 用掉就没了（重放 = 绕过确认）。
 */
export class ConfirmationStore {
  private readonly issued = new Map<string, { digest: string; at: number }>();

  /**
   * 签发一张凭据。
   *
   * @returns 凭据串（给 agent 拿去重试）
   */
  issue(
    actionId: string,
    params: Record<string, unknown>,
    packId: string,
    contractVersion: string,
    now: number,
  ): string {
    const token = `${randomUUID()}`;
    this.issued.set(token, {
      digest: `${actionId}|${paramsDigest(params)}|${packId}|${contractVersion}`,
      at: now,
    });
    return token;
  }

  /**
   * 用掉一张凭据（**一次性**）。
   *
   * @returns 凭据对得上吗（对得上就把它作废）
   */
  consume(
    token: string,
    actionId: string,
    params: Record<string, unknown>,
    packId: string,
    contractVersion: string,
    now: number,
  ): boolean {
    const entry = this.issued.get(token);
    if (entry === undefined) return false;
    // 过期 → 删掉，不行
    if (now - entry.at > CONFIRM_TTL_MS) {
      this.issued.delete(token);
      return false;
    }
    const expected = `${actionId}|${paramsDigest(params)}|${packId}|${contractVersion}`;
    if (entry.digest !== expected) return false;
    // **一次性**：用掉就删
    this.issued.delete(token);
    return true;
  }
}
