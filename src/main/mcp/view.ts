import type { WorkflowRunStatus } from '../workflows/service';

/**
 * **给 agent 看的运行状态**（契约 `spec/04` §2.4 的 `workflow_status` ✓）。
 *
 * ── 为什么与**卡片侧**的投影不是同一个形状 ──
 *
 * | | 卡片侧（`03` §7.7 ✓） | agent 侧（`04` §2.4 ✓） |
 * |---|---|---|
 * | `stages` 里有 `audit_id` | **没有** ✓（缩减投影 ✓） | **有** ✓（契约明写 ✓） |
 * | `outputs` / `inputs` / `role` / `detail` / `value` | **都没有** ✓ | **都没有** ✓ |
 *
 * → 两边各自按**自己的契约**裁 ✓ —— **不是**同一份投影 ✓
 *   （把卡片的形状直接搬给 agent，就少了 `audit_id` ✓；
 *   把 agent 的形状搬给卡片，就**多泄了**明细 ✓）。
 *
 * → **两边都不给**的（宿主侧的东西 ✓）：`outputs`（**路径** ✓）· `inputs`（**参数值** ✓）·
 *   `role`（**哪台机器** ✓ —— 那是**拓扑** ✓，`04` §2.4 明写「不给拓扑」✓）·
 *   `detail`（**人话解释** ✓）· `value`（**读到的内容** ✓）。
 */
export function projectRunStatusForAgent(status: WorkflowRunStatus): Record<string, unknown> {
  return {
    runId: status.runId,
    workflowId: status.workflowId,
    state: status.state,
    // **当前这一步** ✓（契约 §2.4 ✓：**正在跑的那一步** ✓）
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
      // **审计号要给** ✓（契约 §2.4 明写 ✓ —— agent 要靠它追责 ✓）
      ...(stage.audit_id === undefined ? {} : { audit_id: stage.audit_id }),
    })),
  };
}
