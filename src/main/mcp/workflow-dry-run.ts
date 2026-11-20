import { substituteCommand } from '../workflows/substitute';
import type { WorkflowPack, WorkflowStep } from '../workflows/format';

/**
 * The **dry run of a workflow** (the `run_workflow(id, inputs, dry_run)` of
 * contract `spec/04` §2.4 ✓).
 *
 * ── Why there is one ──
 *
 * **A workflow changes somebody else's machine** ✓ (compiling ✓ · writing
 * `authorized_keys` ✓ · installing a module ✓ · rebooting ✓)
 * → before it runs, the agent **should be able to see what it is going to
 *   do** ✓.
 *
 * ── Three bottom lines ──
 *
 * | # | Bottom line | Why |
 * |---|---|---|
 * | 1 | **Not a single step is executed** ✓ | it is a **preview** ✓ |
 * | 2 | **Nothing is written to the audit** ✓ | the audit records "every attempt" ✓ — a preview **is not even an attempt** ✓ |
 * | 3 | **No `run_id` is produced** ✓ | no run → no run id ✓ |
 *
 * ── The boundary of "no guessing" ──
 *
 * → **The role facts (`{role:x.host}`) stay placeholders** ✓ — **there is no
 *   connection during a dry run** ✓
 *   (**opening a connection is already "doing" something** ✓ — even just the
 *   handshake ✓) → **no fake values are filled in** ✓.
 * → **The output slots (`{output:...}`) stay placeholders as well** ✓ — **they
 *   only exist once it has run** ✓.
 * → **The input values are real** ✓ — those **the agent gave itself** ✓.
 */
export interface DryRunStep {
  /** The id of the step */
  id: string;
  /** The kind of the step */
  kind: string;
  /** The role that executes it (**there is none, then there is none** ✓ — no guessing ✓) */
  role?: string;
  /** **The command that will be run** (**the input values are substituted** ✓ · **the command is not run** ✓) */
  command?: string;
  /** The action id it refers to (the `action` step ✓) */
  action?: string;
  /**
     * The criterion of this step (**what the readback reads** ✓).
     *
     * → **`kind` may be left out** ✓ — **form 1 (`tag`) has no `kind`** ✓ (the
     *   same as `spec/02` §4.4 ✓)
     * → **No fake values are filled in** ✓ (**no guessing** ✓).
     */
  readback?: { kind?: string; tag?: string; path?: string };
  /** The danger grading (**`reversible` by default** ✓) */
  danger: 'reversible' | 'destructive';
  /** The timeout (milliseconds) */
  timeout_ms?: number;
}

export interface DryRunResult {
  ok: boolean;
  /** The steps that are going to run (**they do not run** ✓) */
  steps?: DryRunStep[];
  /** No run → no run id ✓ */
  run_id?: undefined;
  reason?: 'invalid_params' | 'not_found';
  detail?: string;
}

/**
 * **Previews a workflow** ✓.
 *
 * @param pack the workflow pack
 * @param inputs the input values (**the agent gave them itself** ✓)
 */
export function dryRunWorkflow(
  pack: WorkflowPack,
  inputs: Record<string, unknown>,
): DryRunResult {
  // ── Are the mandatory inputs there ──
  for (const [name, spec] of Object.entries(pack.inputs)) {
    const value = inputs[name];
    if (value === undefined && spec.default === undefined) {
      return {
        ok: false,
        reason: 'invalid_params',
        detail: `Missing input: ${name}`,
      };
    }
  }

  // ── The profile a role is bound to is **not judged here** ✓ ──
  //
  // → **A dry run does not connect to any machine** ✓ (**opening a connection is already "doing" something** ✓ — even just the handshake ✓)
  // → So **the question "does this profile exist" cannot be answered by a dry run** ✓
  //   → **no guessing** ✓ → **it does not report an error it cannot verify itself** ✓.
  // → **Before it really runs** (`run_workflow` without dry_run ✓) **the workflow layer checks it** ✓ (**this pack is in the registry** ✓ + the target registration ✓).

  // ── The inputs are encoded by type (the command mode uses an **encoded fragment** ✓ — the same as the runner ✓) ──
  const encoded: Record<string, string> = {};
  for (const [name, spec] of Object.entries(pack.inputs)) {
    const raw = inputs[name] ?? spec.default;
    if (raw === undefined) continue;
    encoded[name] = encodeInput(spec.type, raw);
  }

  // ── Step by step preview ──
  const steps: DryRunStep[] = pack.steps.map((step) => previewStep(step, inputs, encoded));

  return { ok: true, steps };
}

/** The preview of one step ✓ */
function previewStep(
  step: WorkflowStep,
  inputs: Record<string, unknown>,
  encoded: Record<string, string>,
): DryRunStep {
  const out: DryRunStep = {
    id: step.id,
    kind: step.kind,
    // **The danger grading defaults to `reversible`** ✓ (the tier of contract §5.2 ✓)
    danger: step.danger ?? 'reversible',
  };
  if (step.role !== undefined) out.role = step.role;
  if (step.timeout_ms !== undefined) out.timeout_ms = step.timeout_ms;
  if (step.action !== undefined) out.action = step.action;

  if (step.cmd !== undefined) {
    // **Only the inputs are substituted** ✓ — **the role facts and the output slots stay placeholders** ✓ (**no connection, nothing ran** ✓ → unknown ✓)
    out.command = substituteCommand(step.cmd, {
      inputs,
      encoded,
      roleFacts: {},
      outputs: {},
    });
  }

  if (step.readback !== undefined) {
    const rb: { kind?: string; tag?: string; path?: string } = {};
    // **Form 1 only has `tag`, no `kind`** ✓ (the same as `spec/02` §4.4 ✓) → **`kind: undefined` is not filled in** ✓
    if (step.readback.kind !== undefined) rb.kind = step.readback.kind;
    if (step.readback.tag !== undefined) rb.tag = step.readback.tag;
    if (step.readback.path !== undefined) rb.path = step.readback.path;
    out.readback = rb;
  }

  return out;
}

/**
 * **The input values are encoded by type** ✓ (the command mode wants an
 * **encoded fragment** ✓ — the same rule as the `encoder` ✓).
 *
 * → **Only three types are used** ✓ (the input declaration of a workflow pack
 *   only has those three ✓ — `string` / `integer` / `number` ✓).
 */
function encodeInput(type: string, raw: unknown): string {
  if (type === 'integer' || type === 'number') {
    return String(raw);
  }
  // **A string is quoted as a shell fragment** ✓ (the same as the `quoteShellValue` of `actions/encoder` ✓)
  return `'${String(raw).replace(/'/g, "'\\''")}'`;
}
