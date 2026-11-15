import { runWorkflow, type WorkflowRunDeps, type WorkflowRunResult } from './runner';
import type { WorkflowPack } from './format';

/**
 * **人点头的那一下**（契约 `spec/05` §7.6 的确认链 ✓）。
 *
 * ── 为什么是「同进程」 ──
 *
 * 契约 §7.6 要的是四件事：
 * **同一个 `run_id`** ✓ · **同一份时间线** ✓ · **从停住的那一步继续**（前面的步**不重跑** ✓）·
 * 凭据**一次性 + 5 分钟 TTL** ✓。
 *
 * → 前三条**只有「人点头发生在同一个进程里」才天然成立** ✓。
 * → 跨进程那条路（另一个终端敲 `workflow:confirm` ✓）要**持久化整个运行状态** ✓
 *   （否则「同一份时间线」做不到 ✓）→ 大工程 ✓，而**用户的需求并不需要它** ✓。
 *
 * → 所以：**这一层把「问人」做成注入的** ✓（人就是边界 ✓），
 *   CLI 把它接到终端 ✓，宿主将来把它接到确认队列 ✓ —— **同一套语义** ✓。
 */

/** 问人的那一下（**返回 true = 人点头** ✓） */
export type HumanConfirm = (request: {
  /** 要人点头的是哪一步 ✓ */
  stepId: string;
  /** 给人看的一句话 ✓ */
  detail: string;
  /** 那张确认凭据（**绑定这一次执行** ✓） */
  confirmId: string;
}) => Promise<boolean>;

/**
 * 跑一条流程；遇到要人确认的步就**问人** ✓。
 *
 * → 人点头 → **从那一步继续** ✓（**前面的步不重跑** ✓）→
 *   **同一个 `run_id`** ✓ · **同一份时间线** ✓（被暂停的那一步**只出现一次** ✓）。
 * → 人摇头 → **就停在那一步** ✓（不许「没人点头也照样做」✗）。
 */
export async function runWorkflowInteractively(
  pack: WorkflowPack,
  inputs: Record<string, unknown>,
  deps: WorkflowRunDeps,
  opts: { approved: boolean; runId?: string },
  ask: HumanConfirm,
): Promise<WorkflowRunResult> {
  const first = await runWorkflow(pack, inputs, deps, {
    approved: opts.approved,
    ...(opts.runId === undefined ? {} : { runId: opts.runId }),
  });

  const pending = first.needsConfirmation;
  if (pending === undefined) return first;

  // ── 问人 ✓ ──
  const yes = await ask({
    stepId: pending.stepId,
    detail: pending.detail,
    confirmId: pending.confirmId,
  });
  // **人摇头 → 就停在这儿** ✓（这一步**没有跑成** ✓）
  if (!yes) return first;

  // ── 人点头 → 凭据变成可用 ✓ ──
  const now = deps.now?.() ?? Date.now();
  const approved = deps.confirmations?.approve(pending.confirmId, now) ?? false;
  if (!approved) return first;

  // ── 从停住的那一步继续 ✓（**前面的步不重跑** ✓）──
  const startAt = pack.steps.findIndex((s) => s.id === pending.stepId);
  const second = await runWorkflow(pack, inputs, deps, {
    approved: opts.approved,
    // **同一个 `run_id`** ✓（契约 §7.6 ✓）
    runId: first.runId,
    ...(startAt < 0 ? {} : { startAt }),
    // **前面那些步产出的槽要带过去** ✓（否则后面的步拿不到 ✓）
    outputs: first.outputs,
    // **凭据给那一步** ✓（键是步骤 id ✓ —— 执行器按步骤查 ✓）
    confirmIds: { [pending.stepId]: pending.confirmId },
  });

  // ── 同一份时间线 ✓（被暂停的那一步**只出现一次** ✓ —— 续跑的结果覆盖它 ✓）──
  const byId = new Map(first.stages.map((s) => [s.stepId, s]));
  for (const stage of second.stages) byId.set(stage.stepId, stage);
  return { ...second, stages: [...byId.values()] };
}
