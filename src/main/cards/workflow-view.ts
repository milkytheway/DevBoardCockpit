import type { WorkflowRunStatus } from '../workflows/service';

/**
 * The state of a workflow run → **the part a card is allowed to see** ✓.
 *
 * ── Why this layer exists ──
 *
 * The host-side state is **very complete** ✓: `outputs` (**paths** ✓) ·
 * `inputs` (**parameter values** ✓) · the `role` of every step (**which
 * machine** ✓) · `detail` (**an explanation in words** ✓) · `value` (**the
 * file content** ✓).
 *
 * → A card is **an arbitrary web page written by an AI** ✓ → the less it is
 * given, the safer ✓.
 * → And this is **not a tightening done in passing** ✓
 * (the obvious implementation, serialising `status` directly, **leaks
 * everything** ✓).
 *
 * → So: **projecting is the job of this layer** ✓, not "the caller has to
 * remember not to pass it on" ✓ ("remember not to" = somebody will eventually
 * pass it on ✓).
 *
 * The contract: `spec/05` §8·B·B5 ✓ ("`stages` only carries `stepId` / `kind` /
 * `ok` / `verified` / `reason`; **the details (paths, output values, roles)
 * stay with the host and the agent**" ✓).
 */

/** A step as the card sees it (**every detail stripped** ✓) */
export interface CardWorkflowStage {
  stepId: string;
  kind: string;
  ok: boolean;
  verified: boolean;
  reason?: string;
}

/** A run as the card sees it (**a reduced projection** ✓) */
export interface CardWorkflowStatus {
  runId: string;
  workflowId: string;
  state: WorkflowRunStatus['state'];
  /** The current step (**no role** ✓ — that is topology ✓) */
  current: { stepId: string; kind: string; at: number } | null;
  stages: CardWorkflowStage[];
}

/**
 * The **closed reason codes** of the card-side workflow API ✓.
 *
 * → **The raw host-side error must not leak to the card** ✓ — those messages
 * contain **paths** ✓ and **workflow pack ids** ✓ (which would tell an
 * unauthorised party "which workflows the host has" ✓).
 * → So **only the code is given** ✓ (the codes are closed ✓ → the card can
 * branch on them deterministically ✓).
 */
export type CardWorkflowReason =
  /** This card has no permission for this workflow ✓ */
  | 'denied'
  /** There is no such workflow pack ✓ */
  | 'not_found'
  /** The input is not valid ✓ */
  | 'invalid_params'
  /** The same workflow is already running ✓ */
  | 'busy'
  /** Something else went wrong ✓ (the details stay in the host's log ✓) */
  | 'failed';

/** Cuts the host-side state down to the part the card may see (**V3-M7 is closed here** ✓) */
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
 * A host-side exception → a **closed reason code** on the card side ✓.
 *
 * → **Match on the error text** ✗? No ✓ — match on a **stable substring** ✓
 *   (those messages are written by the host itself ✓; when the wording
 *   changes this has to change with it ✓ — better an explicit pitfall ✓ than
 *   leaking a path to the card ✓).
 */
export function workflowReasonOf(err: unknown): CardWorkflowReason {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('not authorized')) return 'denied';
  if (message.includes('no such workflow pack')) return 'not_found';
  if (message.includes('is running')) return 'busy';
  if (message.includes('parameter') || message.includes('invalid_params')) return 'invalid_params';
  return 'failed';
}
