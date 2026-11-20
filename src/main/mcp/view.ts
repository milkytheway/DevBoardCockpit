import type { WorkflowRunStatus } from '../workflows/service';

/**
 * **The state of a run as the agent sees it** (the `workflow_status` of
 * contract `spec/04` §2.4 ✓).
 *
 * ── Why it is not the same shape as the **card-side** projection ──
 *
 * | | card side (`03` §7.7 ✓) | agent side (`04` §2.4 ✓) |
 * |---|---|---|
 * | `audit_id` in `stages` | **absent** ✓ (a reduced projection ✓) | **present** ✓ (the contract says so ✓) |
 * | `outputs` / `inputs` / `role` / `detail` / `value` | **all absent** ✓ | **all absent** ✓ |
 *
 * → Each side cuts according to **its own contract** ✓ — they are **not** the
 *   same projection ✓
 *   (handing the shape of the card to the agent would lose the `audit_id` ✓;
 *   handing the shape of the agent to the card would **leak the details** ✓).
 *
 * → What **neither** side gets (the things of the host ✓): `outputs`
 *   (**paths** ✓) · `inputs` (**parameter values** ✓) ·
 *   `role` (**which machine** ✓ — that is **topology** ✓, and `04` §2.4 says
 *   explicitly "no topology" ✓) · `detail` (**an explanation in words** ✓) ·
 *   `value` (**the content that was read** ✓).
 */
export function projectRunStatusForAgent(status: WorkflowRunStatus): Record<string, unknown> {
  return {
    runId: status.runId,
    workflowId: status.workflowId,
    state: status.state,
    // **The current step** ✓ (contract §2.4 ✓: **the step that is running** ✓)
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
      // **The audit id has to be there** ✓ (contract §2.4 says so explicitly ✓ — the agent needs it to hold someone accountable ✓)
      ...(stage.audit_id === undefined ? {} : { audit_id: stage.audit_id }),
    })),
  };
}
