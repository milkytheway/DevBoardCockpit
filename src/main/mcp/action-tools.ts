import { createHash } from 'node:crypto';
import { invokeAction, type ActionExecutorDeps, type ActionOutcome } from '../actions/executor';
import { buildCommand } from '../actions/encoder';
import { authorize, type GrantedActions } from '../actions/authorization';
import { checkFloor } from '../actions/floor-check';
import type { ActionDef } from '../tags/schema';
import type { ConfirmationStore } from '../actions/authorization';

/**
 * **agent 的动作执行**（契约 `spec/04` §2.4 / §2.4.1 ✓ · ADR-D40 ✓）。
 *
 * ── agent 的授权与卡片**不是同一套** ✓ ──
 *
 * | | 卡片 | agent |
 * |---|---|---|
 * | 授权集 | **这张卡被授过的动作** ✓（`grants.json` ✓） | **当前板型包声明的全部动作** ✓ |
 * | 参数域 | 人授过的（**可能更窄** ✓） | **动作自己的 `guard`** ✓ |
 *
 * → 契约 §2.4.1：「agent 不是卡片，它有一套自己的授权」✓
 *   「agent 可以直接调任何动作，**不需要先装一张卡**」✓。
 *
 * → **但 `destructive` 仍然要人点头** ✓（契约 §2.4.1 ✓ —— 那不是授权问题 ✓）。
 *
 * ── `dry_run` 的位置（**契约 §2.4 的行为表** ✓）──
 *
 * ```
 * 1. 查存在性 → not_found
 * 2. 查授权   → denied
 * 3. 校验参数 → invalid_params
 * 4. dry_run  → 返回将执行的命令（**不执行、不回读、不写审计** ✓）
 * 5. 超 guard 域 → needs_confirmation（guard_exceeded ✓）
 * 6. destructive 且未确认 → needs_confirmation ✓
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
  /** 确认凭据的库（**与卡片侧同一份** ✓ —— 语义只有一处 ✓） */
  confirmations: ConfirmationStore;
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
  /** **确认**板子真的进入目标状态了吗 ✓（`verified: false` ≠ 失败 ✓ —— 契约 §2.4 ✓） */
  verified?: boolean;
  /** 追责单位 ✓ */
  audit_id?: string;
  /** 失败原因（**封闭表** ✓ —— 契约 §四 ✓） */
  reason?: string;
  /** 要人点头时给的凭据 ✓ */
  confirm_id?: string;
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
  opts: { dryRun?: boolean; confirmId?: string; deviceKey?: string } = {},
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
    return { ok: false, reason: 'not_found', detail: `没有这个动作：${actionId}` };
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

  // **④ dry_run** ✓ —— **在确认之前** ✓（契约 §2.4 的行为表 ✓）
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
  }, opts.confirmId === undefined ? {} : { confirmId: opts.confirmId });

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
    detail: `没有这个设备：${deviceKey}（当前那块是 ${current || '（没有）'}）`,
  };
}

/** **把执行器的结果投影成契约的形状** ✓ */
function projectOutcome(outcome: ActionOutcome): AgentActionResult {
  // **要人点头** ✓ → 带 `confirm_id` ✓（契约 §2.4.1 ✓）
  if (outcome.needsConfirmation !== undefined) {
    return {
      ok: false,
      reason: 'needs_confirmation',
      confirm_id: outcome.needsConfirmation.confirmId,
      detail: outcome.needsConfirmation.detail,
    };
  }
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

/**
 * **递一次确认请求**（契约 §2.4 的 `confirm_action` ✓）。
 *
 * → **只递请求** ✓ —— **不批准** ✓（契约 §2.4.1 ✓：「没有人点，`confirm_id` 永远无效」✓）。
 * → **绑得很死** ✓：(动作 id, 参数摘要, 包 id, 契约版本, **最终命令摘要**) ✓
 *   （契约 §2.4.1 的绑定表 ✓ —— 第五项是 v5 补的 ✓）。
 */
export function confirmAction(
  deps: AgentActionDeps,
  actionId: string,
  params: Record<string, unknown>,
  deviceKey?: string,
): { ok: true; confirm_id: string; expires_at: number } | { ok: false; reason: string; detail?: string } {
  // ── **设备先对** ✓（**与 `execute_action` 同一条规矩** ✓）
  // → **对不上 → 不签凭据** ✓（**签了也是废的** ✓ —— 而且那会**骗 agent 说「递上去了」** ✗）
  const deviceError = checkDevice(deps, deviceKey);
  if (deviceError !== undefined) {
    return { ok: false, reason: deviceError.reason ?? 'not_found', detail: deviceError.detail };
  }

  const action = deps.actions().find((a) => a.id === actionId);
  if (action === undefined) {
    return { ok: false, reason: 'not_found', detail: `没有这个动作：${actionId}` };
  }

  // **参数先校验** ✓ —— 不合法的参数**签不出凭据** ✓（签了也是废的 ✓）
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

  // **这个动作现在就要人确认吗** ✓（destructive ✓ 或 超 guard 域 ✓）——
  // **不该确认的 → 不递请求** ✓（递一个没人会批的请求是噪音 ✓）
  const verdict = authorize(
    action,
    params,
    agentGrants(deps.actions()),
    checkFloor(command),
  );
  if (verdict.verdict === 'ok') {
    return { ok: false, reason: 'invalid_params', detail: '这个动作不需要确认' };
  }

  const now = Date.now();
  const commandDigest = createHash('sha256').update(command, 'utf8').digest('hex');
  const confirmId = deps.confirmations.issue(
    action.id,
    params,
    // **与执行器用的是同一个值** ✓（**同一处取** ✓）——
    // 不一致 → **凭据永远消费不掉** ✗（症状是「人点了也没用」✗）
    deps.packIdOf(),
    deps.contractVersion,
    now,
    commandDigest,
    // **这一步动的是哪块板** ✓（凭据要绑它 ✓ —— 契约 `spec/04` §2.4.1 第六项 ✓）
    deps.deviceKey(),
  );
  // **递进确认队列** ✓（**状态不变** ✓ —— 还是「待确认」✓ —— 没人点就永远无效 ✓）
  deps.confirmations.request(confirmId, now);

  return { ok: true, confirm_id: confirmId, expires_at: now + 5 * 60_000 };
}
