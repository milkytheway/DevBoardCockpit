import type { Connection, ExecResult } from '../hal/connection';
import type { ActionDef } from '../tags/schema';
import type { TagReading } from '../../shared/tag-reading';
import { buildCommand } from './encoder';
import { quoteShellValue } from '../util/shell-quote';
import { checkFloor } from './floor-check';
import { authorize, type GrantedActions } from './authorization';
import { runReadback } from './readback';
import type { AuditRow } from './audit';

/**
 * 动作执行器 —— 契约 `docs/spec/02-board-pack.md` §5.2 + `docs/21` §6.9 的七步链。
 *
 * ```
 * ① 编码参数 → ② 地板复查 → ③ 授权 → ④（必要时）确认
 *              → ⑤ 执行 → ⑥ 回读 → ⑦ 审计
 * ```
 *
 * ── 执行与回读是**一个不可拆分的独占事务**（ADR-D23 / SPEC-D22）──
 *
 * 回读若被采样插队，读到的可能是**别的命令的输出**——
 * 「回读不符」就成了假阴性，驾驶舱会显示错的真实状态。
 * → 所以两者都跑在 `runTransaction` 里面（同一个队列槽位）。
 */
export interface Confirmations {
  /** 签发一张确认凭据 */
  issue(
    actionId: string,
    params: Record<string, unknown>,
    packId: string,
    contractVersion: string,
    now: number,
  ): string;
  /** 用掉一张（一次性） */
  consume(
    token: string,
    actionId: string,
    params: Record<string, unknown>,
    packId: string,
    contractVersion: string,
    now: number,
  ): boolean;
}

/** 执行器需要的东西 */
export interface ActionExecutorDeps {
  /** 板型包 id（凭据要绑它） */
  packId: string;
  /** 契约版本（凭据要绑它） */
  contractVersion: string;
  /** **这条连接有退出码吗**（串口没有，事实 S5） */
  hasExitCode: boolean;
  /** 在这条连接上跑一次独占事务（执行 + 回读都在里面） */
  runTransaction: <T>(fn: (connection: Connection) => Promise<T>) => Promise<T>;
  /** 读一个 tag（新鲜的） */
  readTag: (tag: string) => Promise<TagReading | undefined>;
  /** 已授权的动作（装卡时用户批准的） */
  granted: () => GrantedActions;
  /** 确认凭据的存取 */
  confirmations: Confirmations;
  /** 审计（每次尝试一行）——**返回那一行的 id**（结果要带 `audit_id`） */
  audit: (row: AuditRow) => string;
  /** 谁触发的（卡片 id / agent / 用户） */
  actor?: string;
  /** 现在（毫秒） */
  now?: () => number;
}

/**
 * 一次调用的结果。
 *
 * ── 形状**按契约**（不是按实现方便）──
 *
 * `spec/04` §2.4（`execute_action`）与 `spec/03` §5.2（`cockpit.actions.invoke`）：
 *
 * ```
 * → { ok: true,  readback: { value, unit, status, at }, verified: true, audit_id: "..." }
 * → { ok: false, reason: "readback_mismatch", expected: true, actual: false }
 * ```
 *
 * → **回读到的值在 `readback` 里**（卡片按 `r.readback.value` 渲染），
 * **不是平铺在顶层**。
 * → 失败时带 `expected` / `actual`（人能看出「差多少」）。
 * → `audit_id` 是**追责单位**（ADR-D31 R8 的时间线要引用它）。
 */
export interface ActionOutcome {
  /** 动作成功了吗 */
  ok: boolean;
  /** **确认**板子真的进入目标状态了吗 */
  verified: boolean;
  /** 回读到的真实状态（契约 §2.4 的 `readback`） */
  readback?: {
    value?: unknown;
    unit?: string;
    /** 回读到的那个 tag 的状态（形式 1 才有） */
    status?: TagReading['status'];
    /** 回读的时刻（毫秒 UTC） */
    at: number;
  };
  /** 要人确认（带凭据：agent 带它重试） */
  needsConfirmation?: { confirmId: string; detail: string };
  /** 为什么不成功 */
  reason?: string;
  /** 期望值（失败时给） */
  expected?: unknown;
  /** 实际值（失败时给） */
  actual?: unknown;
  /** 给人看的一句话 */
  detail?: string;
  /** 审计行的 id（追责单位） */
  audit_id?: string;
}

/** 调一次动作 */
export async function invokeAction(
  action: ActionDef,
  params: Record<string, unknown>,
  deps: ActionExecutorDeps,
  opts: { confirmId?: string } = {},
): Promise<ActionOutcome> {
  const now = deps.now ?? (() => Date.now());
  const at = now();
  const actor = deps.actor ?? 'unknown';

  /**
   * 写一行审计，**并把它的 id 填回结果**。
   *
   * → 结果里的 `audit_id` = 那一行（契约 `spec/04` §2.4）。
   */
  const record = (outcome: ActionOutcome, value?: unknown): void => {
    outcome.audit_id = deps.audit({
      at,
      actor,
      actionId: action.id,
      params,
      ok: outcome.ok,
      verified: outcome.verified,
      ...(value === undefined ? {} : { value }),
      ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
    });
  };

  // ① 编码（§4.6）—— 不合法就地拒，**不执行**
  let command: string;
  let encoded: Record<string, string>;
  try {
    const built = buildCommand(action.command, action.params ?? {}, params);
    command = built.command;
    encoded = built.encoded;
  } catch (err) {
    const outcome: ActionOutcome = {
      ok: false,
      verified: false,
      reason: 'invalid_params',
      detail: err instanceof Error ? err.message : String(err),
    };
    record(outcome);
    return outcome;
  }

  // ② 地板复查（**对编码后的命令**）
  const floor = checkFloor(command);

  // ③ 授权
  const verdict = authorize(action, params, deps.granted(), floor);

  if (verdict.verdict === 'denied') {
    const outcome: ActionOutcome = {
      ok: false,
      verified: false,
      reason: 'denied',
      detail: verdict.detail,
    };
    record(outcome);
    return outcome;
  }

  // ④ 确认（destructive / 超出批准域 / 命中地板）
  if (verdict.verdict === 'needs_confirmation') {
    const consumed =
      opts.confirmId !== undefined &&
      deps.confirmations.consume(
        opts.confirmId,
        action.id,
        params,
        deps.packId,
        deps.contractVersion,
        at,
      );
    if (!consumed) {
      const confirmId = deps.confirmations.issue(
        action.id,
        params,
        deps.packId,
        deps.contractVersion,
        at,
      );
      const outcome: ActionOutcome = {
        ok: false,
        verified: false,
        reason: 'needs_confirmation',
        needsConfirmation: { confirmId, detail: verdict.detail ?? '这次执行要人确认' },
      };
      record(outcome);
      return outcome;
    }
  }

  // ⑤⑥ 执行 + 回读（**同一个独占事务**）
  const { result: readback } = await deps.runTransaction(async (connection) => {
    const execResult = await connection.exec(command);
    const result = await runReadback(
      action.readback ?? { kind: 'none', consequence: '这个动作没有声明回读' },
      { raw: params, encoded },
      {
        readTag: deps.readTag,
        // **读文件 = 在同一条连接上 `cat`** —— HAL 没有「读远端文件内容」这个能力
        // （只有 list / pull / push）。而它必须在**同一个事务**里：
        // 另开一次往返就会插到动作与回读之间（SPEC-D22）。
        readFile: async (path: string): Promise<string | null> => {
          const cat = await connection.exec(`cat -- ${quoteShellValue(path)}`);
          return cat.timedOut || cat.exitCode !== 0 ? null : cat.stdout;
        },
        // 回读的 `verify` 也在**同一条连接**上跑
        exec: (cmd: string): Promise<ExecResult> => connection.exec(cmd),
        hasExitCode: deps.hasExitCode,
      },
      execResult,
    );
    return { execResult, result };
  });

  const hasReadback =
    readback.value !== undefined || readback.unit !== undefined || readback.status !== undefined;
  const outcome: ActionOutcome = {
    ok: readback.ok,
    verified: readback.verified,
    // **回读到的值在 `readback` 里**（契约 §2.4 / §5.2——卡片按 `r.readback.value` 渲染）
    ...(hasReadback
      ? {
          readback: {
            ...(readback.value === undefined ? {} : { value: readback.value }),
            ...(readback.unit === undefined ? {} : { unit: readback.unit }),
            ...(readback.status === undefined ? {} : { status: readback.status }),
            at,
          },
        }
      : {}),
    ...(readback.reason === undefined ? {} : { reason: readback.reason }),
    ...(readback.expected === undefined ? {} : { expected: readback.expected }),
    ...(readback.actual === undefined ? {} : { actual: readback.actual }),
    ...(readback.detail === undefined ? {} : { detail: readback.detail }),
  };
  record(outcome, readback.value);
  return outcome;
}
