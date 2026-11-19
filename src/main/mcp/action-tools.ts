import { invokeAction, type ActionExecutorDeps, type ActionOutcome } from '../actions/executor';
import { buildCommand } from '../actions/encoder';
import type { ActionDef } from '../tags/schema';
import type { GrantedActions } from '../actions/authorization';

/**
 * **agent 的动作执行**（契约 `spec/04` §2.4 / §2.4.1 ✓ · ADR-D40 ✓）。
 *
 * ── agent 的授权与卡片**不是同一套** ✓ ──
 *
 * | | 卡片 | agent |
 * |---|---|---|
 * | 授权集 | **当前板型包声明的全部动作** ✓（**卡片与 agent 同一套** ✓ —— ADR-D46 ✓） | **当前板型包声明的全部动作** ✓ |
 * | 参数域 | **动作自己的 `guard`** ✓（**没有人授过的更窄域** ✓ —— ADR-D46 ✓） | **动作自己的 `guard`** ✓ |
 *
 * → 契约 §2.4.1：「agent 不是卡片，它有一套自己的授权」✓
 *   「agent 可以直接调任何动作，**不需要先装一张卡**」✓。
 *
 * → **`destructive` 不再逐次问人** ✓（**2026-11-16** ✓ · ADR-D48 ✓）→
 *   **闸在设置里的统一权限区** ✓（ADR-D47 ✓ —— **那类动作默认关** ✓）。
 *
 * ── `dry_run` 的位置（**契约 §2.4 的行为表** ✓）──
 *
 * ```
 * 1. 查存在性 → not_found
 * 2. 查授权   → denied
 * 3. 校验参数 → invalid_params
 * 4. dry_run  → 返回将执行的命令（**不执行、不回读、不写审计** ✓）
 * 7. 执行 → 8. 回读 → 9. 审计 ✓
 * ```
 *
 * → **第 4 步在第 5/6 步之前** ✓ —— 否则 agent 永远拿不到 destructive 动作的预览 ✗。
 */

/**
 * 执行器依赖（**与卡片侧同一个执行器** ✓ —— 语义天然一致 ✓）。
 *
 * → **`packId` 保持执行器要的形状**（**字符串** ✓）——
 *   **签发与消费绑的必须是同一个值** ✓（契约 §2.4.1 的绑定表 ✓）→
 *   两边不一致 → **凭据永远消费不掉** ✗（那是**最隐蔽的一种坏** ✓ —— 症状是「人点了也没用」✓）。
 */
export interface AgentActionDeps extends Omit<ActionExecutorDeps, 'granted' | 'actor'> {
  /** 当前板型包里声明的动作（**agent 的授权集就是它们** ✓） */
  actions: () => ActionDef[];
  /**
   * **当前板型包 id**（**凭据要绑它** ✓）。
   *
   * → **必须与执行器用的那个是同一个值** ✓（**同一个来源** ✓）✓
   * → 宿主侧接线时**从同一处取** ✓。
   */
  packIdOf: () => string;
  /**
   * **当前运行时那块板的 `device_key`** ✓（**从 `ActionExecutorDeps` 继承** ✓）。
   *
   * → **`execute_action` 的设备检查靠它** ✓（契约 `spec/04` §2.4 ✓）
   * → **凭据也绑它** ✓（§2.4.1 第六项 ✓）。
   */
  deviceKey: () => string;
}

/** agent 的授权集（**包里的全部动作** ✓ —— 契约 §2.4.1 ✓） */
export function agentGrants(actions: ActionDef[]): GrantedActions {
  const granted: GrantedActions['actions'] = {};
  for (const action of actions) {
    // **`undefined` = 批准了这个动作但**没缩小参数域** ✓
    // → 参数域回落到**动作自己的 `guard`** ✓（契约 §2.4.1 细则 2 ✓）
    granted[action.id] = undefined;
  }
  return { actions: granted };
}

/** 动作不存在 → `not_found` ✓ */
export interface ActionNotFound {
  ok: false;
  reason: 'not_found';
  detail: string;
}

/** 执行的结果（**契约 §2.4 的形状** ✓） */
export interface AgentActionResult {
  ok: boolean;
  /** 回读到的真实状态 */
  readback?: { value?: unknown; unit?: string; status?: string; at: number };
  /** 板子真的进入目标状态了吗 ✓（`verified: false` ≠ 失败 ✓ —— 契约 §2.4 ✓） */
  verified?: boolean;
  /** 追责单位 ✓ */
  audit_id?: string;
  /** 失败原因（**封闭表** ✓ —— 契约 §四 ✓） */
  reason?: string;
  /** 要人点头时给的凭据 ✓ */
  /** 参数超出了 guard 域 ✓（**标志位，不是 reason 码** ✓） */
  guard_exceeded?: boolean;
  /** 期望值 / 实际值 ✓ */
  expected?: unknown;
  actual?: unknown;
  /** 给人看的一句话 ✓ */
  detail?: string;
  /** dry-run 的形状 ✓ */
  dry_run?: boolean;
  /** dry-run 要返回的最终命令 ✓（**编码后的** ✓ —— 不是模板 ✓） */
  command?: string;
  /** 回读要读哪个 tag ✓ */
  readback_tag?: string | null;
}

/**
 * **执行一个动作**（agent 侧）✓。
 *
 * → **薄封装** ✓：复用**同一个执行器** ✓（卡片侧同一个 ✓ —— 七步链只有一处 ✓）。
 */
export async function executeAction(
  deps: AgentActionDeps,
  actionId: string,
  params: Record<string, unknown>,
  opts: { dryRun?: boolean; deviceKey?: string } = {},
): Promise<AgentActionResult> {
  // ── **第 0 步 · 设备对不对** ✓（契约 `spec/04` §2.4 ✓ · ADR-D43 ✓）──
  //
  // → **给了 `device_key` → 它必须是当前运行时那条连接的 `device_key`** ✓
  // → 否则 **`not_found`** ✓（detail 写清「没有这个设备：X」✓）
  // → **绝不允许「忽略 `device_key` 然后打当前那块」** ✓
  //   （**那是「静默地做另一件事」** ✗ —— agent 以为动了 b、实际动了 a ✗）
  //
  // → **它在第 1 步之前** ✓ —— **设备不对**比**动作不存在**更基本 ✓
  const deviceError = checkDevice(deps, opts.deviceKey);
  if (deviceError !== undefined) return deviceError;

  const action = deps.actions().find((a) => a.id === actionId);
  // **① 存在性先查** ✓（契约 §2.4 ✓ —— **顺序有讲究** ✓）
  if (action === undefined) {
    return { ok: false, reason: 'not_found', detail: `No such action: ${actionId}` };
  }

  // **③ 参数校验 + 编码** ✓（**dry-run 也要过这一步** ✓ —— 不然给的不是「将要执行的」✓）
  let command: string;
  try {
    command = buildCommand(action.command, action.params ?? {}, params).command;
  } catch (err) {
    return {
      ok: false,
      reason: 'invalid_params',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // **④ dry_run** ✓ —— **在执行之前** ✓（契约 §2.4 的行为表 ✓）
  if (opts.dryRun === true) {
    return {
      ok: true,
      dry_run: true,
      command,
      readback_tag: readbackTagOf(action),
      // **不执行、不回读、不写审计** ✓（**不是一次尝试** ✓）
    };
  }

  // **走同一个执行器** ✓（卡片侧同一个 ✓ —— 七步链只有一处 ✓）
  const outcome: ActionOutcome = await invokeAction(action, params, {
    ...deps,
    // **agent 的授权集 = 包里的全部动作** ✓（契约 §2.4.1 ✓）
    granted: () => agentGrants(deps.actions()),
    actor: 'agent',
  });

  return projectOutcome(outcome);
}

/**
 * **`device_key` 对不对** ✓（契约 `spec/04` §2.4 ✓）。
 *
 * → **不给就放过** ✓（**当前运行时那块板** ✓ —— 从前的行为 ✓）
 * → **给了就必须对得上** ✓ → 否则 **`not_found`** ✓
 * → **绝不静默地打当前那块** ✓。
 */
function checkDevice(
  deps: AgentActionDeps,
  deviceKey: string | undefined,
): AgentActionResult | undefined {
  if (deviceKey === undefined) return undefined;
  const current = deps.deviceKey();
  if (deviceKey === current) return undefined;
  return {
    ok: false,
    reason: 'not_found',
    detail: `No such device: ${deviceKey} (the current one is ${current || 'none'})`,
  };
}

/** **把执行器的结果投影成契约的形状** ✓ */
function projectOutcome(outcome: ActionOutcome): AgentActionResult {
  const result: AgentActionResult = { ok: outcome.ok };
  if (outcome.readback !== undefined) {
    result.readback = {
      ...(outcome.readback.value === undefined ? {} : { value: outcome.readback.value }),
      ...(outcome.readback.unit === undefined ? {} : { unit: outcome.readback.unit }),
      ...(outcome.readback.status === undefined ? {} : { status: outcome.readback.status }),
      at: outcome.readback.at,
    };
  }
  // **`verified: false` 是「已执行但没回读」** ✓ —— **不是失败** ✓（契约 §2.4 ✓）
  result.verified = outcome.verified;
  if (outcome.audit_id !== undefined) result.audit_id = outcome.audit_id;
  if (outcome.reason !== undefined) result.reason = outcome.reason;
  if (outcome.expected !== undefined) result.expected = outcome.expected;
  if (outcome.actual !== undefined) result.actual = outcome.actual;
  if (outcome.detail !== undefined) result.detail = outcome.detail;
  return result;
}

/** 这个动作的回读要读哪个 tag（**不是 tag 形式就是 `null`** ✓） */
function readbackTagOf(action: ActionDef): string | null {
  const readback = action.readback;
  if (readback === undefined) return null;
  if (readback.kind !== undefined && readback.kind !== 'tag') return null;
  return readback.tag ?? null;
}

