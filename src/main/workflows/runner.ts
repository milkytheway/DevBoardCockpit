import { makeError } from '../../shared/errors';
import { invokeAction } from '../actions/executor';
import { runReadback, type ReadbackResult } from '../actions/readback';
import { encodeParams } from '../actions/encoder';
import { checkFloor } from '../actions/floor-check';
import type { AuditRow } from '../actions/audit';
import type { ActionDef, PackParam, ReadbackDef } from '../tags/schema';
import type { TagReading } from '../../shared/tag-reading';
import type { ConnectionProfile } from '../profiles/schema';
import { deviceKeyOf } from '../profiles/schema';
import { quotePath } from '../util/shell-quote';
import type { Connection } from '../hal/connection';
import { capabilitiesFor } from '../hal/capabilities';
import type { TargetRegistry } from './targets';
import { discoverArtifacts } from './discover';
import { placementDir } from './placement';
import { substituteCommand, substituteValue, type RoleFacts, type SubstitutionContext } from './substitute';
import type { WorkflowPack, WorkflowStep, WorkflowStepKind } from './format';

/**
 * The executor of a workflow — it carries out "how this task is done".
 *
 * ── It does not build a second execution path ──
 *
 * Every writing step goes through the executor of M6
 * (`actions/executor.ts`): encode → check the floor again → authorise →
 * execute + read back (one exclusive transaction) → audit ✓
 * (there is no "confirm" step any more — cut on 2026-11-16 · ADR-D48).
 * → The workflow layer only adds two things:
 * ① naming the target (which target `runTransaction` is hooked onto —
 *   the A17 gap of plan 5);
 * ② the criterion may be read on another role (the verification across
 *   targets — ADR-D32 D32-2).
 *
 * ── How a free command (`exec`) gets authorised ──
 *
 * The trust model of contract `spec/02` section 5.6: a free command needs
 * the permission of a human.
 * → That permission is the unified permission area in the settings today
 *   (ADR-D47) — the row of switches for the workflows being on means this
 *   person knows which commands it will run ✓ (`05` section 7.4).
 * → A step that hits the danger floor → the pack does not load ✓
 *   (rule 16 — the validator judges it).
 * → Nobody is asked at runtime any more (2026-11-16 · ADR-D48).
 *
 * ── How a criterion is read ──
 *
 * A criterion may name a role → "ask the board on the board" ✓
 * (the readback of a board pack only verifies "the target itself" — a
 * verification across targets is something only the workflow layer can do).
 */
export interface WorkflowStage {
  stepId: string;
  kind: WorkflowStepKind;
  /** The role it ran on (for a readback step, the role it was read on) */
  role?: string;
  ok: boolean;
  verified: boolean;
  reason?: string;
  detail?: string;
  /** The id of the audit line of this step (the unit of responsibility; the timeline points back to the audit through it) */
  audit_id?: string;
  /** The id of the line of the cross-target criterion (two facts, two rows ✓) */
  readback_audit_id?: string;
  at: number;
  durationMs: number;
  value?: unknown;
}

export interface WorkflowRunResult {
  runId: string;
  packId: string;
  ok: boolean;
  stages: WorkflowStage[];
  /** The produced slots */
  outputs: Record<string, string>;
}

/**
 * The live hooks of the timeline (contract `05` section 8·B).
 *
 * → "It is halfway through" has to be visible:
 * compiling takes minutes (measured 58.9 s / 98.5 s) → the interface may
 * not be a dead silence.
 */
export interface WorkflowTimelineHooks {
  /** This step has started (the host can say "which step is it at now" from it) */
  onStepStart?: (info: { stepId: string; kind: string; at: number }) => void;
  /** This step has a result (the timeline fills while it runs — not only when it is done) */
  onStage?: (stage: WorkflowStage) => void;
}

export interface WorkflowRunDeps {
  /** The target registry (a connection by profile id) */
  targets: TargetRegistry;
  /** The connection profiles of the host (the role facts come from here) */
  profileFor: (profileId: string) => ConnectionProfile | undefined;
  /** The audit (one line per step) — it returns the id of that line */
  audit: (row: AuditRow) => string;
  /** The actions of the board pack (used by the `action` step) */
  actionDef?: (actionId: string) => ActionDef | undefined;
  /** Read one tag (used by the readback form 1) */
  readTag?: (tag: string) => Promise<TagReading | undefined>;
  /** The live timeline (the host uses it — it lets `status` say "which step is it at now") */
  timeline?: WorkflowTimelineHooks;
  /** Now (milliseconds) */
  now?: () => number;
}

export interface WorkflowRunOptions {
  /**
   * Which step to start at (used when it continues).
   *
   * → Why it exists: a destructive step has to be nodded at → the workflow
   *   stops at that step →
   * after the nod it continues from that step → the earlier steps may
   *   not run again
   *   (running them again means compiling twice and transferring twice ✗).
   */
  startAt?: number;
  /** The produced slots to carry over when it continues */
  outputs?: Record<string, string>;
  /**
   * Calling it off halfway (an `AbortSignal`) — "the human does not want
   * it any more".
   *
   * → Measured: without this path a transfer step of 75 seconds ran to the
   *   end even after the cancellation ✗.
   */
  signal?: AbortSignal;
  /** The id of this run (it keeps it when it continues — continuing is the same run) */
  runId?: string;
}

/** The inputs of the run (validated against the types the workflow pack declares) */
export async function runWorkflow(
  pack: WorkflowPack,
  inputs: Record<string, unknown>,
  deps: WorkflowRunDeps,
  opts: WorkflowRunOptions = {},
): Promise<WorkflowRunResult> {
  const now = deps.now ?? (() => Date.now());
  const at = now();
  // Continuing is the same run → the runId comes from the caller ✓ (if it gives none, one is generated ✓)
  const runId = opts.runId ?? `wf-${at.toString(36)}`;
  const outputs: Record<string, string> = {};
  const stages: WorkflowStage[] = [];

  // ── The inputs: the defaults are filled in first (the value the caller gave wins ✓) ──
  // → Contract section 2: `default` = "use it when the caller gave none"
  // → ⚠️ Both substitution modes have to get it ✓ (I-3 of the independent review 40):
  //   the command mode (`{input:x}` → the encoded fragment) and the value mode (the `expect` of a readback, the `params` of an `action` step, the `dir` of a `discover`) read two different things
  //   → Filling only one → the value mode gets the literal `{input:x}` ✗
  //   → Filling only one → the value mode gets the literal `{input:x}` ✗
  const defaults: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(pack.inputs)) {
    if (def.default !== undefined) defaults[name] = def.default;
  }
  const mergedInputs: Record<string, unknown> = { ...defaults, ...inputs };

  // ── The inputs: validated against the types the pack declares (a missing required one / a wrong type → it is refused before it runs) ──
  let encodedInputs: Record<string, string>;
  try {
    encodedInputs = encodeParams(inputSchema(pack), mergedInputs);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      runId,
      packId: pack.id,
      ok: false,
      stages: [
        {
          stepId: '(inputs)',
          kind: 'exec',
          ok: false,
          verified: false,
          reason: 'invalid_params',
          detail,
          at,
          durationMs: 0,
        },
      ],
      outputs,
    };
  }

  const roleFacts = factsOf(pack, deps);

  // Continuing: start at the given step ✓ + carry over the produced slots ✓
  const startAt = Math.max(0, opts.startAt ?? 0);
  if (opts.outputs !== undefined) {
    for (const [slot, value] of Object.entries(opts.outputs)) outputs[slot] = value;
  }

  for (const [index, step] of pack.steps.entries()) {
    if (index < startAt) continue;
    // It was called off → this step does not run ✓ (I-6 of the independent review 40)
    // → "The human does not want it, so do not go on" ✓ (going on would be disobedience ✗)
    if (opts.signal?.aborted === true) break;
    const stage = await runStep(step, {
      pack,
      runId,
      inputs: mergedInputs,
      encodedInputs,
      roleFacts,
      outputs,
      deps,
      opts,
      now,
    });
    stages.push(stage);
    // The timeline fills while it runs ✓ (not only when it is done — contract section 8·B)
    deps.timeline?.onStage?.(stage);

    // It was called off while this step was running → the next step does not run ✓ (I-6 of the independent review 40)
    // → It is caught by the check at the start of the next round ✓ (that check asks "shall we go on" once before it runs ✓)

    if (!stage.ok) {
      // `assert` may continue when it does not match (`on_mismatch: continue`)
      if (step.kind === 'assert' && step.on_mismatch === 'continue') continue;
      break;
    }
  }

  return {
    runId,
    packId: pack.id,
    ok: stages.every((s) => s.ok),
    stages,
    outputs,
  };
}

/* ── Internals ──────────────────────────────────────────────────────────── */

interface StepContext {
  pack: WorkflowPack;
  runId: string;
  inputs: Record<string, unknown>;
  encodedInputs: Record<string, string>;
  roleFacts: Record<string, RoleFacts>;
  outputs: Record<string, string>;
  deps: WorkflowRunDeps;
  opts: WorkflowRunOptions;
  now: () => number;
}

/**
 * Turn the string parameters of the workflow into the type the action
 * declares.
 *
 * ── Why this step is needed ──
 *
 * The values of `params` of a workflow pack can only be strings (the
 * shape of a workflow pack is closed — `spec/05` section 4.2), while the
 * parameters of an action of a board pack carry a type (`integer` /
 * `number` / `boolean` / `enum` — `spec/02` section 4.3). The two do not
 * match ✗ →
 * a typed action cannot be called from a workflow ✗ (measured:
 * `invalid_params: the parameter "value" has to be an integer`).
 *
 * → The conversion happens here — and it still passes the schema check of
 *   the authorisation layer ✓ (the conversion does not change the
 *   meaning ✓).
 *
 * | Declared type | How it is converted |
 * |---|---|
 * | `integer` | `Number.parseInt` — what does not parse stays as it is (the authorisation layer reports it — do not invent a value here) |
 * | `number` | `Number` — the same ✓ |
 * | `boolean` | `'true'` → `true` · `'false'` → `false` · anything else stays as it is ✓ |
 * | `string` / `enum` | not converted (they are strings already) ✓ |
 */
function coerceParam(value: string, type: PackParam['type']): unknown {
  switch (type) {
    case 'integer': {
      const n = Number.parseInt(value, 10);
      return Number.isNaN(n) ? value : n;
    }
    case 'number': {
      const n = Number(value);
      return Number.isNaN(n) ? value : n;
    }
    case 'boolean': {
      if (value === 'true') return true;
      if (value === 'false') return false;
      return value;
    }
    default:
      return value;
  }
}

async function runStep(step: WorkflowStep, ctx: StepContext): Promise<WorkflowStage> {
  const at = ctx.now();
  const started = at;
  const role = step.role;

  // "This step has started" ✓ (the host can say "which step is it at now" — contract section 8·B ✓)
  ctx.deps.timeline?.onStepStart?.({ stepId: step.id, kind: step.kind, at: started });

  try {
    // ── The endpoints (the source and the destination of `file.transfer`) ──
    // ⚠️ Inside the try ✓ (I-2 of the independent review 40):
    // → the target cannot be reached / the endpoint cannot be computed → this step has to become a line of the timeline ✓
    // → Outside the try ✗ → the exception goes through runStep ✗ → goes through runWorkflow ✗ →
    //   the timeline of the whole run does not even get a line ✗ (the user only sees a failed + a raw error ✗)
    const endpoints = await resolveEndpoints(step, ctx);

    const substitution: SubstitutionContext = {
      inputs: ctx.inputs,
      encoded: ctx.encodedInputs,
      roleFacts: ctx.roleFacts,
      outputs: ctx.outputs,
      ...(endpoints === undefined ? {} : { endpoints }),
    };

    switch (step.kind) {
      case 'exec':
        return await runExec(step, ctx, substitution, role, started);
      case 'action':
        return await runAction(step, ctx, substitution, role, started);
      case 'discover':
        return await runDiscover(step, ctx, substitution, role, started);
      case 'file.transfer':
        return await runTransfer(step, ctx, substitution, endpoints, started);
      case 'await':
      case 'assert':
        return await runAssert(step, ctx, substitution, role, started);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const auditId = ctx.deps.audit({
      at: started,
      actor: `workflow:${ctx.pack.id}`,
      actionId: `workflow:${ctx.pack.id}:${step.id}`,
      params: {},
      ok: false,
      verified: false,
      detail,
    });
    return {
      stepId: step.id,
      kind: step.kind,
      ...(role === undefined ? {} : { role }),
      ok: false,
      verified: false,
      reason: 'failed',
      detail,
      audit_id: auditId,
      at: started,
      durationMs: ctx.now() - started,
    };
  }
}

/** One `exec` step: a free command → through the executor of M6 */
async function runExec(
  step: WorkflowStep,
  ctx: StepContext,
  substitution: SubstitutionContext,
  role: string | undefined,
  started: number,
): Promise<WorkflowStage> {
  if (role === undefined || step.cmd === undefined) {
    throw makeError('IPC_INVALID_PAYLOAD', `exec step ${step.id} is missing role or cmd`);
  }
  const command = substituteCommand(step.cmd, substitution);
  const profileId = ctx.pack.roles[role]?.profile;
  if (profileId === undefined) throw makeError('IPC_INVALID_PAYLOAD', `role ${role} has no profile bound to it`);

  // Compose an action definition → it goes through the seven-step chain of M6 (no second execution path ✓)
  const action: ActionDef = {
    id: `exec:${step.id}`,
    label: step.id,
    // A step may declare itself destructive (the step that prepares the credentials ✓ A10)
    danger: step.danger ?? 'reversible',
    params: {},
    command,
    // A criterion that names another role → the executor does not verify it (a verification across targets is another transaction ✓)
    readback:
      step.readback?.role !== undefined && step.readback.role !== role
? // A cross-target criterion may not be `none`: `spec/02` section 4.4.1 forbids destructive with none ✓
          // → The executor uses `command_ok` (the exit code of that command itself ✓),
          //   and the cross-target part is verified by the workflow layer separately (two facts, two rows ✓)
          { kind: 'command_ok' }
        : toReadbackDef(step.readback, substitution),
  };
  const outcome = await invokeAction(
    action,
    {},
    executorDeps(ctx, profileId, action.id, step.timeout_ms),
  );
  const cross = await crossRoleReadback(step, ctx, substitution, role, started);
  // The `out` slot = the output of this command (the step that prepares the credentials uses it to hand the public key to the next step ✓)
  if (step.out !== undefined && outcome.output !== undefined) {
    ctx.outputs[step.out] = outcome.output.trim();
  }
  // Both the success and the failure are counted ✓ (the command failed, the cross-target criterion passed and it is still not a success ✗)
  const failed = !outcome.ok ? outcome : cross !== undefined && !cross.ok ? cross : undefined;
  return {
    stepId: step.id,
    kind: step.kind,
    role,
    ok: failed === undefined,
    verified: cross === undefined ? outcome.verified : cross.verified,
    ...(failed?.reason === undefined ? {} : { reason: failed.reason }),
    ...(failed?.detail === undefined ? {} : { detail: failed.detail }),
    ...(outcome.audit_id === undefined ? {} : { audit_id: outcome.audit_id }),
    ...(cross?.audit_id === undefined ? {} : { readback_audit_id: cross.audit_id }),
    at: started,
    durationMs: ctx.now() - started,
    ...(cross === undefined
      ? outcome.readback?.value === undefined
        ? {}
        : { value: outcome.readback.value }
      : cross.value === undefined
        ? {}
        : { value: cross.value }),
  };
}

/**
 * The criterion names another role → the workflow layer runs it on that
 * role.
 *
 * ── Why it cannot be left to the executor ──
 *
 * The executor of M6 reads back on the connection it executed on
 * (SPEC-D22: the execution and the readback are indivisible ✓). A
 * criterion across targets is on another machine → that is another
 * transaction ✓
 * (it has to be separate anyway: the artefact is not on the board, that is
 * a fact of the board, not a fact of the command on the guest ✓).
 *
 * → The executor gets `kind: none` (it does not verify) ✓, the workflow
 *   layer verifies it itself ✓, and it writes a separate audit line (two
 *   facts, two rows ✓).
 */
async function crossRoleReadback(
  step: WorkflowStep,
  ctx: StepContext,
  substitution: SubstitutionContext,
  stepRole: string | undefined,
  started: number,
): Promise<
  | { ok: boolean; verified: boolean; reason?: string; detail?: string; value?: unknown; audit_id?: string }
  | undefined
> {
  const readRole = step.readback?.role;
  if (readRole === undefined || readRole === stepRole) return undefined;
  // It was called off → the cross-target criterion does not run ✓ (I-6 of the independent review 40)
  // → "Nothing was transferred, what would verifying it mean" ✗; and after a cancellation nobody should wait for another command ✓
  if (ctx.opts.signal?.aborted === true) return undefined;
  const result = await runReadbackOnRole(ctx, readRole, step.readback, substitution);
  const auditId = ctx.deps.audit({
    at: started,
    actor: `workflow:${ctx.pack.id}`,
    actionId: `workflow:${ctx.pack.id}:${step.id}:readback`,
    params: {},
    inputs: { ...ctx.inputs },
    ok: result.ok,
    verified: result.verified,
    ...(result.value === undefined ? {} : { value: result.value }),
    ...(result.detail === undefined ? {} : { detail: result.detail }),
  });
  return {
    ok: result.ok,
    verified: result.verified,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    ...(result.detail === undefined ? {} : { detail: result.detail }),
    ...(result.value === undefined ? {} : { value: result.value }),
    audit_id: auditId,
  };
}

/** One `action` step: it refers to an already declared action of the board pack → through the executor of M6 */
async function runAction(
  step: WorkflowStep,
  ctx: StepContext,
  substitution: SubstitutionContext,
  role: string | undefined,
  started: number,
): Promise<WorkflowStage> {
  if (role === undefined || step.action === undefined) {
    throw makeError('IPC_INVALID_PAYLOAD', `action step ${step.id} is missing role or action`);
  }
  const def = ctx.deps.actionDef?.(step.action);
  if (def === undefined) {
    throw makeError('IPC_INVALID_PAYLOAD', `the board pack has no such action: ${step.action}`);
  }
  const profileId = ctx.pack.roles[role]?.profile;
  if (profileId === undefined) throw makeError('IPC_INVALID_PAYLOAD', `role ${role} has no profile bound to it`);

  // The parameters: validated against the schema of the action itself (the self-description of the pack is not trusted ✓)
  //
  // ⚠️ The parameter values in a workflow are all strings ✓ (the shape of a workflow pack is closed — `spec/05` section 4.2),
  // while the parameters of an action carry a type ✓ (`integer` / `number` / `boolean` / `enum` — `spec/02` section 4.3). The two do not match ✗ →
  // a typed action cannot be called from a workflow ✗ (measured on 2026-11-16:
  // `invalid_params: the parameter "value" has to be an integer` ✓).
  // → They are converted once, by the type the action declares ✓ (after the conversion the authorisation layer still validates against the schema ✓ — the conversion does not change the meaning ✓).
  // → They are converted once, by the type the action declares ✓ (after the conversion the authorisation layer still validates against the schema ✓ — the conversion does not change the meaning ✓).

  const values: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(step.params ?? {})) {
    const value = substituteValue(raw, substitution);
    const spec = def.params?.[key];
    values[key] = spec === undefined ? value : coerceParam(value, spec.type);
  }
  const outcome = await invokeAction(
    def,
    values,
    executorDeps(ctx, profileId, def.id, step.timeout_ms),
  );
  return {
    stepId: step.id,
    kind: step.kind,
    role,
    ok: outcome.ok,
    verified: outcome.verified,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
    ...(outcome.audit_id === undefined ? {} : { audit_id: outcome.audit_id }),
    at: started,
    durationMs: ctx.now() - started,
    ...(outcome.readback?.value === undefined ? {} : { value: outcome.readback.value }),
  };
}

/** One `discover` step: look for the artefacts by the rules → put them into the slot */
async function runDiscover(
  step: WorkflowStep,
  ctx: StepContext,
  substitution: SubstitutionContext,
  role: string | undefined,
  started: number,
): Promise<WorkflowStage> {
  if (role === undefined || step.pattern === undefined || step.out === undefined) {
    throw makeError('IPC_INVALID_PAYLOAD', `discover step ${step.id} is missing role / pattern / out`);
  }
  const profileId = ctx.pack.roles[role]?.profile;
  if (profileId === undefined) throw makeError('IPC_INVALID_PAYLOAD', `role ${role} has no profile bound to it`);
  // The directory uses the value mode (the path must not be wrapped in quotes — `list()` wants a path, not a shell fragment ✓)
  const dir = substituteValue(step.dir ?? '.', substitution);
  // The rules use the value mode too (the file name and the exclude list are names, not shell fragments ✓)
  const pattern = substituteValue(step.pattern as string, substitution);
  const exclude = (step.exclude ?? []).map((rule) => substituteValue(rule, substitution));
  const found = await ctx.deps.targets.runOn(profileId, async (conn) =>
    discoverArtifacts({ list: (d) => conn.list(d) }, {
      dir,
      pattern,
      ...(exclude.length === 0 ? {} : { exclude }),
    }),
  );
  if (found.length === 0) {
    const detail = `${pattern} was not found in ${dir}`;
    const auditId = ctx.deps.audit({
      at: started,
      actor: `workflow:${ctx.pack.id}`,
      actionId: `workflow:${ctx.pack.id}:${step.id}`,
      params: {},
      ok: false,
      verified: false,
      detail,
    });
    return {
      stepId: step.id,
      kind: step.kind,
      role,
      ok: false,
      verified: false,
      reason: 'not_found',
      detail,
      audit_id: auditId,
      at: started,
      durationMs: ctx.now() - started,
    };
  }
  ctx.outputs[step.out] = found[0] as string;
  const auditId = ctx.deps.audit({
    at: started,
    actor: `workflow:${ctx.pack.id}`,
    actionId: `workflow:${ctx.pack.id}:${step.id}`,
    params: { dir, pattern },
    inputs: { ...ctx.inputs },
    ok: true,
    verified: true,
    value: found.join(','),
    detail: `found ${found.length}`,
  });
  return {
    stepId: step.id,
    kind: step.kind,
    role,
    ok: true,
    verified: true,
    audit_id: auditId,
    at: started,
    durationMs: ctx.now() - started,
    value: found[0],
  };
}

/**
 * Is the destination there (asked once before the transfer — contract `05`
 * section 8·C·R1/R2).
 *
 * → `unknown` = it is not known (it could not be looked up) → when in
 *   doubt it is not deleted ✓ (contract R2).
 */
async function destinationState(
  ctx: StepContext,
  role: string,
  path: string,
): Promise<'there' | 'not-there' | 'unknown'> {
  const profileId = ctx.pack.roles[role]?.profile;
  if (profileId === undefined) return 'unknown';
  const slash = path.lastIndexOf('/');
  const dir = slash <= 0 ? '/' : path.slice(0, slash);
  const base = path.slice(slash + 1);
  try {
    const entries = await ctx.deps.targets.runOn(profileId, (conn) => conn.list(dir));
    return entries.some((e) => e.name === base) ? 'there' : 'not-there';
  } catch {
    // It could not be looked up → it is not known ✓ (not "there is none" ✓ — that would take the file of the user for a leftover ✗)
    return 'unknown';
  }
}

/**
 * Clean up the half-written file that a transfer left behind (contract `05`
 * section 8·C).
 *
 * ── The criterion (only one thing can establish "it is from this step")
 * ──
 *
 * → The destination did not exist before the transfer ✓ → it is
 *   this transfer ✓ → the clean-up takes it ✓;
 * → It existed already → it is left alone by default ✓ (do not
 *   delete the things of the user ✓);
 * → It could not be looked up → it is left alone ✓ (when in doubt
 *   → do not delete ✓).
 *
 * ── The guard rails ──
 *
 * → The path is quoted by the rules of the shell ✓ (a newline or a null
 *   character is refused ✓ — that would be a second command ✗);
 * → It is not recursive ✓ (`rm -f` fails on a directory ✓ → it can
 *   only delete one regular file ✓);
 * → The path comes only from the destination this step resolved ✓ (the
 *   pack cannot give another path ✓);
 * → A separate audit line is written ✓, no confirmation is asked ✓
 *   (it is the clean-up of this very run ✓).
 */
async function cleanupPartialTransfer(
  ctx: StepContext,
  step: WorkflowStep,
  role: string,
  path: string,
  before: 'there' | 'not-there' | 'unknown',
): Promise<{ cleaned: boolean; note: string }> {
  if (before !== 'not-there') {
    return {
      cleaned: false,
      note:
        before === 'there'
          ? 'the destination already had that file, it was left alone'
          : 'it could not be determined whether the destination had that file, it was left alone',
    };
  }
  const after = await destinationState(ctx, role, path);
  if (after !== 'there') {
    return { cleaned: false, note: 'the destination has no half-written file' };
  }
  const profileId = ctx.pack.roles[role]?.profile as string;
  const command = `rm -f -- ${quotePath(path)}`;
  let ok = false;
  try {
    const result = await ctx.deps.targets.runOn(profileId, (conn) =>
      conn.exec(command, ctx.opts.signal === undefined ? {} : { signal: ctx.opts.signal }),
    );
    ok = !result.timedOut && result.exitCode === 0;
  } catch {
    ok = false;
  }
  // The clean-up writes an audit line too ✓ (who deleted it, which path — contract R4 ✓)
  ctx.deps.audit({
    at: ctx.now(),
    actor: `workflow:${ctx.pack.id}`,
    actionId: `workflow:${ctx.pack.id}:${step.id}:cleanup`,
    params: { path },
    inputs: { ...ctx.inputs },
    ok,
    verified: ok,
    detail: ok ? 'the half-written file left by the transfer was removed' : 'the half-written file could not be removed',
  });
  return { cleaned: ok, note: ok ? 'the half-written file left by the transfer was removed' : 'the half-written file could not be removed' };
}

/** One `file.transfer` step: the transfer (the command runs on the source target) */
async function runTransfer(
  step: WorkflowStep,
  ctx: StepContext,
  substitution: SubstitutionContext,
  endpoints: { from: string; to: string } | undefined,
  started: number,
): Promise<WorkflowStage> {
  if (endpoints === undefined || step.cmd === undefined) {
    throw makeError('IPC_INVALID_PAYLOAD', `file.transfer step ${step.id} is missing from / to / cmd`);
  }
  const fromRole = step.from?.role as string;
  const profileId = ctx.pack.roles[fromRole]?.profile;
  if (profileId === undefined) throw makeError('IPC_INVALID_PAYLOAD', `role ${fromRole} has no profile bound to it`);

  const command = substituteCommand(step.cmd, substitution);
  const action: ActionDef = {
    id: `transfer:${step.id}`,
    label: step.id,
    danger: step.danger ?? 'reversible',
    params: {},
    command,
    // A criterion that names another role → the executor does not verify it (a verification across targets is another transaction ✓)
    readback: step.readback?.role !== undefined && step.readback.role !== fromRole
? // The same: not `none` (a destructive step may not use none ✓)
        { kind: 'command_ok' }
      : toReadbackDef(step.readback, substitution),
  };
  // Ask once before the transfer whether the destination is there ✓ (contract section 8·C·R1/R2 ✓)
  // → "It did not exist before the transfer" is the only criterion that can establish "this is from this step" ✓
  const toRole = step.to?.role as string;
  const before = await destinationState(ctx, toRole, endpoints.to);

  const outcome = await invokeAction(
    action,
    {},
    executorDeps(ctx, profileId, action.id, step.timeout_ms),
  );

  // The transfer command itself failed → the half-written file is handled like a criterion ✓ (contract section 8·C ✓)
  // → A failed readback is not a failed transfer ✓ ("it was transferred, it was not verified" does not clean up ✓ — Q3 of review 40 ✓)
  const commandFailed = !outcome.ok;
  let residueNote: string | undefined;
  if (commandFailed) {
    const cleanup = await cleanupPartialTransfer(ctx, step, toRole, endpoints.to, before);
    residueNote = cleanup.note;
  }

  const cross = await crossRoleReadback(step, ctx, substitution, fromRole, started);
  // The destination path goes into the slot (the later steps need it)
  if (outcome.ok && cross?.ok !== false && step.out !== undefined) ctx.outputs[step.out] = endpoints.to;
  // Both the success and the failure are counted ✓ (the transfer command failed, the criterion passed and it is still not a success ✗)
  const failed = !outcome.ok ? outcome : cross !== undefined && !cross.ok ? cross : undefined;
  // "It was transferred, it was not verified" (the transfer command succeeded ✓, but the criterion did not pass ✓) → it has to be said clearly ✓
  // (the prototype of the Q3 of review 40 — "the file is there on the board, it did not take effect" has to be visible ✓)
  const transferredButUnverified = outcome.ok && cross !== undefined && !cross.ok;
  const detail = transferredButUnverified
    ? `transferred but not verified: ${cross.detail ?? 'the criterion did not pass'} (the destination holds an unconfirmed file)`
    : (failed?.detail ?? residueNote);
  return {
    stepId: step.id,
    kind: step.kind,
    role: fromRole,
    ok: failed === undefined,
    verified: cross === undefined ? outcome.verified : cross.verified,
    ...(failed?.reason === undefined ? {} : { reason: failed.reason }),
    ...(detail === undefined ? {} : { detail }),
    ...(outcome.audit_id === undefined ? {} : { audit_id: outcome.audit_id }),
    ...(cross?.audit_id === undefined ? {} : { readback_audit_id: cross.audit_id }),
    at: started,
    durationMs: ctx.now() - started,
    ...(cross === undefined
      ? outcome.readback?.value === undefined
        ? {}
        : { value: outcome.readback.value }
      : cross.value === undefined
        ? {}
        : { value: cross.value }),
  };
}

/**
 * Run one criterion on the named role.
 *
 * ── Why there is this "across targets" entry point ──
 *
 * The executor of M6 reads back on the connection it executed on
 * (SPEC-D22: the execution and the readback are indivisible ✓).
 * → "after the guest ran the scp, is the file really there on the
 *   board" it cannot verify ✗
 * (that is another machine — it was never supposed to be in the same
 * transaction ✓).
 * → The criterion across targets is run by the workflow layer ✓
 *   (ADR-D32 D32-2).
 */
async function runReadbackOnRole(
  ctx: StepContext,
  role: string,
  readback: WorkflowStep['readback'],
  substitution: SubstitutionContext,
): Promise<ReadbackResult> {
  const profileId = ctx.pack.roles[role]?.profile;
  if (profileId === undefined) throw makeError('IPC_INVALID_PAYLOAD', `role ${role} has no profile bound to it`);
  const profile = ctx.deps.profileFor(profileId);
  const hasExitCode = profile === undefined ? true : capabilitiesFor(profile).exitCode;

  return runReadback(
    toReadbackDef(readback, substitution),
    { raw: ctx.inputs, encoded: ctx.encodedInputs },
    {
      readTag: ctx.deps.readTag ?? (async () => undefined),
      readFile: async (path: string): Promise<string | null> => {
        const cat = await ctx.deps.targets.runOn(profileId, (conn) =>
          conn.exec(
            `cat -- ${quotePath(path)}`,
            ctx.opts.signal === undefined ? {} : { signal: ctx.opts.signal },
          ),
        );
        return cat.timedOut || cat.exitCode !== 0 ? null : cat.stdout;
      },
      // The command of a cross-target criterion also has to pass the danger floor (it runs on another machine ✓ —
      // two reviews both pointed at this ✓) → a hit means it is not executed and the criterion fails ✓.
      exec: (command: string) => {
        const floor = checkFloor(command);
        if (floor.verdict === 'destructive') {
          throw makeError(
            'PACK_INVALID',
            `the command of the cross-target criterion hits the danger floor (${floor.why ?? 'dangerous command'}), not executed`,
            { detail: { command, pattern: floor.pattern } },
          );
        }
        return ctx.deps.targets.runOn(profileId, (conn) =>
          conn.exec(command, ctx.opts.signal === undefined ? {} : { signal: ctx.opts.signal }),
        );
      },
      hasExitCode,
    },
  );
}

/** One `await` / `assert` step: it only runs the criterion (it may name the role it is read on) */
async function runAssert(
  step: WorkflowStep,
  ctx: StepContext,
  substitution: SubstitutionContext,
  role: string | undefined,
  started: number,
): Promise<WorkflowStage> {
  const readRole = step.readback?.role ?? role;
  if (readRole === undefined) {
    throw makeError('IPC_INVALID_PAYLOAD', `the ${step.kind} step ${step.id} does not say which role to read on`);
  }
  const result = await runReadbackOnRole(ctx, readRole, step.readback, substitution);

  const auditId = ctx.deps.audit({
    at: started,
    actor: `workflow:${ctx.pack.id}`,
    actionId: `workflow:${ctx.pack.id}:${step.id}`,
    params: {},
    ok: result.ok,
    verified: result.verified,
    ...(result.value === undefined ? {} : { value: result.value }),
    ...(result.detail === undefined ? {} : { detail: result.detail }),
  });
  return {
    stepId: step.id,
    kind: step.kind,
    role: readRole,
    ok: result.ok,
    verified: result.verified,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    ...(result.detail === undefined ? {} : { detail: result.detail }),
    audit_id: auditId,
    at: started,
    durationMs: ctx.now() - started,
    ...(result.value === undefined ? {} : { value: result.value }),
  };
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

/** The inputs of the workflow pack → the schema of the encoder (`path` counts as `string` — the encoding rules are the same) */
function inputSchema(pack: WorkflowPack): Record<string, PackParam> {
  const schema: Record<string, PackParam> = {};
  for (const [name, def] of Object.entries(pack.inputs)) {
    schema[name] = {
      type: def.type === 'path' ? 'string' : def.type,
      ...(def.maxLength === undefined ? {} : { maxLength: def.maxLength }),
      ...(def.min === undefined ? {} : { min: def.min }),
      ...(def.max === undefined ? {} : { max: def.max }),
      ...(def.values === undefined ? {} : { values: def.values }),
      // The default and the pattern are handed to the encoder too ✓
      // (`default` → the value when the caller gave none ✓; `pattern` → the shape check ✓)
      ...(def.default === undefined ? {} : { default: def.default }),
      ...(def.pattern === undefined ? {} : { pattern: def.pattern }),
    } as PackParam;
  }
  return schema;
}

/** The connection facts of a role (closed: host / port / user / key / profile_id) */
function factsOf(pack: WorkflowPack, deps: WorkflowRunDeps): Record<string, RoleFacts> {
  const facts: Record<string, RoleFacts> = {};
  for (const [name, role] of Object.entries(pack.roles)) {
    const profile = deps.profileFor(role.profile);
    if (profile === undefined) continue;
    const options = profile.options as Record<string, unknown>;
    // ── An SSH endpoint has two sources ✓ (contract `spec/05` section 6) ──
    //
    // → `options.ssh` ✓ — the endpoint of the machine behind this connection ✓
    //   (a board that is connected by adb or serial can be reached by ssh too ✓ — the same board ✓)
    // → `options.host` ✓ — this connection is an ssh itself ✓ (it is that endpoint itself ✓)
    //
    // → The two never appear together ✓ (a profile of the `ssh` transport may not carry `options.ssh` ✓ — it is an error ✓)
    // → `options.ssh` is read first ✓ — it is the more specific one ✓.
    const sshFact =
      typeof options['ssh'] === 'object' && options['ssh'] !== null
        ? (options['ssh'] as Record<string, unknown>)
        : {};

    facts[name] = {
      host: str(sshFact['host']) ?? str(options['host']) ?? '',
      port: num(sshFact['port']) ?? num(options['port']) ?? 22,
      user: str(sshFact['username']) ?? str(options['username']) ?? 'root',
      // The private key does not go into `options.ssh` ✓ — that key is on the guest ✓ (the one that was installed ✓)
      // → Only the `key_filename` of this connection itself ✓
      ...(typeof options['key_filename'] === 'string'
        ? { key: options['key_filename'] as string }
        : {}),
      profile_id: profile.id,
    };
  }
  return facts;
}

/** Take a string fact (an empty string does not count) */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Take a number fact */
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** The endpoints (the source path and the destination path) — `placement` has to ask the target machine for the kernel version */
async function resolveEndpoints(
  step: WorkflowStep,
  ctx: StepContext,
): Promise<{ from: string; to: string } | undefined> {
  if (step.kind !== 'file.transfer') return undefined;
  const substitution: SubstitutionContext = {
    inputs: ctx.inputs,
    encoded: ctx.encodedInputs,
    roleFacts: ctx.roleFacts,
    outputs: ctx.outputs,
  };
  const from = step.from?.path === undefined ? undefined : substituteValue(step.from.path, substitution);
  if (from === undefined) throw makeError('IPC_INVALID_PAYLOAD', `file.transfer step ${step.id} is missing from.path`);

  let to: string | undefined;
  if (step.to?.path !== undefined) {
    to = substituteValue(step.to.path, substitution);
  } else if (step.to?.placement !== undefined) {
    const roleName = step.to.role;
    const profileId = ctx.pack.roles[roleName]?.profile;
    if (profileId === undefined) throw makeError('IPC_INVALID_PAYLOAD', `role ${roleName} has no profile bound to it`);
    // The placement directory has to be asked of the target machine (the path of a kernel module carries a version number ✓)
    //
    // → But only `kernel-module` has to ask ✓ (the placement of `user-program` is a fixed path ✓
    //   — `/usr/local/bin/` ✓ — asking `uname -r` would be asking for nothing ✓).
    // → Asking for nothing costs more than one round trip ✓: the host has to be able to reach the target machine ✓
    //   — and when "the host only has ADB and the private key of the board is on the guest" ✓ — that way does not work ✗
    //   → a dependency that was not needed becomes a hard dependency ✗.
    const release =
      step.to.placement === 'kernel-module'
        ? await ctx.deps.targets.runOn(profileId, async (conn) => {
            const result = await conn.exec('uname -r');
            return result.timedOut || result.exitCode !== 0 ? '' : result.stdout.trim();
          })
        : '';
    const dir = placementDir(step.to.placement as 'kernel-module', { kernel_release: release });
    to = `${dir}${basenameOf(from)}`;
  }
  if (to === undefined) throw makeError('IPC_INVALID_PAYLOAD', `file.transfer step ${step.id} is missing its destination`);
  return { from, to };
}

/** The file name of a path */
function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The criterion of a workflow pack → the criterion of M6 (the five forms are exactly the same ✓) */
function toReadbackDef(
  readback: WorkflowStep['readback'],
  substitution: SubstitutionContext,
): ReadbackDef {
  if (readback === undefined) {
    return { kind: 'none', consequence: 'this step declares no criterion' };
  }
  const def: Record<string, unknown> = {};
  if (readback.tag !== undefined) {
    def['tag'] = substituteValue(readback.tag, substitution);
    if (readback.expect !== undefined) def['expect'] = substituteValue(readback.expect, substitution);
    return def as unknown as ReadbackDef;
  }
  if (readback.kind !== undefined) def['kind'] = readback.kind;
  if (readback.expect !== undefined) def['expect'] = substituteValue(readback.expect, substitution);
  if (readback.path !== undefined) def['path'] = substituteValue(readback.path, substitution);
  if (readback.tolerance !== undefined) def['tolerance'] = readback.tolerance;
  if (readback.command !== undefined) {
    def['command'] = substituteCommand(readback.command, substitution);
  }
  if (readback.timeout_ms !== undefined) def['timeout_ms'] = readback.timeout_ms;
  if (readback.consequence !== undefined) def['consequence'] = readback.consequence;
  return def as unknown as ReadbackDef;
}

/**
/ The dependencies the executor needs (hooked onto the named target ✓ — the A17 of plan 5) */
function executorDeps(ctx: StepContext, profileId: string, actionId: string, timeoutMs?: number) {
  const profile = ctx.deps.profileFor(profileId);
  return {
    packId: ctx.pack.id,
    contractVersion: 'devboard/v1',
    // Which board this step touches ✓ (the credentials are bound to it ✓ — contract `spec/04` section 2.4.1, the sixth item ✓)
    // → It is the device of the profile this step landed on ✓ (not the one the workflow pack declares ✓ — that would be a machine-specific value ✓)
    deviceKey: () => (profile === undefined ? '' : deviceKeyOf(profile)),
    hasExitCode: profile === undefined ? true : capabilitiesFor(profile).exitCode,
    // The execution and the readback are on the same target, in the same exclusive transaction (SPEC-D22 ✓)
    runTransaction: <T>(fn: (connection: Connection) => Promise<T>): Promise<T> =>
      ctx.deps.targets.runOn(profileId, (connection) => fn(connection)),
    readTag: ctx.deps.readTag ?? (async () => undefined),
    granted: () => ({
      actions: {
        // This run was enabled by a human → this action counts as authorised (the trust model of ADR-D31 R2 ✓)
        // — there is no "a hit on the floor needs a single confirmation" any more ✓ (ADR-D48 ✓ — the floor is for the check and the display ✓)
        [actionId]: undefined,
      },
    }),
    audit: (row: AuditRow) =>
      ctx.deps.audit({ ...row, actor: row.actor === 'unknown' ? `workflow:${ctx.pack.id}` : row.actor }),
    actor: `workflow:${ctx.pack.id}`,
    // The inputs of this step go into the audit line (the parameters of a workflow are in the workflow pack, not in the board pack ✓)
    auditInputs: { ...ctx.inputs },
    now: ctx.now,
    // A long step needs a timeout (compiling takes minutes; the transport was measured to fluctuate by a factor of 20, A14 ✓)
    ...(timeoutMs === undefined ? {} : { execTimeoutMs: timeoutMs }),
    // Calling it off halfway ("the human does not want it any more" ✓ — kept apart from the timeout ✓)

    ...(ctx.opts.signal === undefined ? {} : { execSignal: ctx.opts.signal }),
  };
}


