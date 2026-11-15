import type { WorkflowRunStatus } from '../workflows/service';

/**
 * 流程运行状态 → **卡片能看的那一份** ✓。
 *
 * ── 为什么要有这一层 ──
 *
 * 宿主侧的状态**很全** ✓：`outputs`（**路径** ✓）· `inputs`（**参数值** ✓）·
 * 每一步的 `role`（**哪台机器** ✓）· `detail`（**人话解释** ✓）· `value`（**文件内容** ✓）。
 *
 * → 卡片是 **AI 写的任意网页** ✓ → 给它的东西**越少越安全** ✓。
 * → 而且这条**不是「顺便收紧」** ✓ —— `docs/37` 的 **V3-M7** 早就点了它 ✓
 * （「按最自然的实现（直接序列化 status）→ **全泄**」✓）。
 *
 * → 所以：**投影是这一层的职责** ✓，不是「调用方自己记得别给」✓
 * （「记得别给」= 迟早有人给了 ✓）。
 *
 * 契约：`spec/05` §八·B·B5 ✓（「`stages` 只给 `stepId` / `kind` / `ok` / `verified` / `reason`；
 * **明细（路径、输出值、角色）留在宿主与 agent 那边**」✓）。
 */

/** 卡片看到的一步（**明细全剥掉** ✓） */
export interface CardWorkflowStage {
  stepId: string;
  kind: string;
  ok: boolean;
  verified: boolean;
  reason?: string;
}

/** 卡片看到的一次运行（**缩减投影** ✓） */
export interface CardWorkflowStatus {
  runId: string;
  workflowId: string;
  state: WorkflowRunStatus['state'];
  /** 当前这一步（**不给角色** ✓ —— 那是拓扑 ✓） */
  current: { stepId: string; kind: string; at: number } | null;
  stages: CardWorkflowStage[];
}

/**
 * 卡片侧流程 API 的**封闭理由码** ✓。
 *
 * → **不能把宿主侧的原始报错泄给卡片** ✓ —— 那些话里有**路径** ✓、
 * 有**流程包 id** ✓（那等于告诉未授权方「宿主里有哪些流程」✓）。
 * → 所以**只给码** ✓（码是封闭的 ✓ → 卡片能对它做确定的分支 ✓）。
 */
export type CardWorkflowReason =
  /** 这张卡没有这个流程的权限 ✓ */
  | 'denied'
  /** 没有这个流程包 ✓ */
  | 'not_found'
  /** 这个流程包**还没被用户批准** ✓ */
  | 'not_approved'
  /** 输入不合法 ✓ */
  | 'invalid_params'
  /** 同一条流程正在跑 ✓ */
  | 'busy'
  /** 出了别的事 ✓（细节留在宿主的日志里 ✓） */
  | 'failed';

/** 把宿主侧的状态裁成卡片能看的那一份（**V3-M7 在这里关掉** ✓） */
export function projectRunStatus(status: WorkflowRunStatus): CardWorkflowStatus {
  return {
    runId: status.runId,
    workflowId: status.workflowId,
    state: status.state,
    current:
      status.current === null
        ? null
        : { stepId: status.current.stepId, kind: status.current.kind, at: status.current.at },
    stages: status.stages.map((stage) => ({
      stepId: stage.stepId,
      kind: stage.kind,
      ok: stage.ok,
      verified: stage.verified,
      ...(stage.reason === undefined ? {} : { reason: stage.reason }),
    })),
  };
}

/**
 * 宿主侧的异常 → 卡片侧的**封闭理由码** ✓。
 *
 * → **按中文报错匹配** ✗？不 ✓ —— 按**稳定的子串**匹配 ✓
 *   （那些话是宿主自己写的 ✓；改文案时要同步改这里 ✓ —— 宁可是个显式的坑 ✓，
 *   也不要给卡片泄路径 ✓）。
 */
export function workflowReasonOf(err: unknown): CardWorkflowReason {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('没有被授权')) return 'denied';
  if (message.includes('还没有被批准') || message.includes('没有被批准')) return 'not_approved';
  if (message.includes('没有这个流程包')) return 'not_found';
  if (message.includes('正在跑')) return 'busy';
  if (message.includes('参数') || message.includes('invalid_params')) return 'invalid_params';
  return 'failed';
}
