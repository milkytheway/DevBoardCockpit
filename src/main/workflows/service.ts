import { randomUUID } from 'node:crypto';
import { makeError } from '../../shared/errors';
import { runWorkflow, type WorkflowRunDeps, type WorkflowRunResult, type WorkflowStage } from './runner';
import type { WorkflowRegistry } from './registry';
import type { WorkflowPack } from './format';

/**
 * The host service of a workflow — the layer that a card or an agent
 * goes through when it triggers a workflow.
 *
 * ── The three things (forced by the C1/C2/C3 of two independent reviews)
 * ──
 *
 * | # | Thing | Why |
 * |---|---|---|
 * | 1 | Only ids, never paths | "dropping a file into a directory" is not "approving it"; a card or an agent cannot give a path → otherwise an agent could write a pack of its own and run it ✗ (32-C1 of review 32) |
 * | 2 | Look in the registry before running | `require(id)` → without that pack it cannot run (the "approved" layer is gone) |
 * | 3 | A long task = run_id + polling | compiling was measured at 58.9 s / 98.5 s (31-C3 of review 31) → returning the timeline synchronously does not hold ✗ → `start()` returns a `runId` at once, `status()` fetches the progress |
 *
 * ── Who says yes to "who may run" ──
 *
 * → The unified permission area in the settings (ADR-D47): the row of
 *   switches for the workflows
 * → A card triggering a workflow is allowed by default · an agent is
 *   allowed by default (the dangerous kind is off by default)
 * → The existence of a workflow pack is the explanation itself (the
 *   approval account was cut on 2026-11-16 · ADR-D48).
 */
export interface WorkflowSummary {
  id: string;
  name: string;
  version: string;
  /** The declaration of the inputs (the card renders a form from it — the `default` has to be given too, so that the card can prefill it) */
  inputs: Record<string, {
    type: string;
    required?: boolean;
    description?: string;
    default?: unknown;
  }>;
}

/**
 * The current step (contract `05` section 8·B).
 *
 * → It is running or it has stopped and waits for a nod (that step
 *   is also "the current one") →
 * the run has ended → `null`.
 * → No role (no topology — a card and an agent should not learn "which
 *   machine" ✓).
 */
export interface WorkflowCurrent {
  stepId: string;
  kind: string;
  /** The moment this step started → the interface computes "how long has it been" from it */
  at: number;
}

export interface WorkflowRunStatus {
  runId: string;
  workflowId: string;
  /**
   * The state of the run.
   *
   * → Four states (`running` / `done` / `failed` / `cancelled`) —
   * the "waits for a nod" state is gone (the whole confirmation chain
   * was cut · ADR-D48).
   * → Being stopped at a step can only be `running` · A cancellation is
   *   `cancelled` — not `failed`.
   */
  state: 'running' | 'done' | 'failed' | 'cancelled';
  /** The timeline (how far it got) */
  stages: WorkflowStage[];
  /** The current step (`null` = nothing is in flight — the run has ended) */
  current: WorkflowCurrent | null;
  /** The produced slots */
  outputs: Record<string, string>;
  ok?: boolean;
  reason?: string;
  /** A human has to confirm (a dangerous command) */
  /**
   * The step it stopped at (the index) — when it continues it starts
   * at this step, the earlier steps do not run again (running them
   * again means compiling twice ✗).
   */
  pausedAtStep?: number;
  /** The inputs to carry over when it continues (the same run — with other inputs it is not the same thing) */
  inputs?: Record<string, unknown>;
  startedAt: number;
  finishedAt?: number;
}

export interface WorkflowServiceOptions {
  registry: WorkflowRegistry;
  /** What a workflow needs to run (the connections, the audit, …) */
  runDeps: WorkflowRunDeps;
  /**
   * The store of the confirmed credentials (the workflow layer and M6 share
   * one — the semantics of a credential exist in one place only: the set of
   * contract `spec/04` section 2.4.1).
   */
  /** Now (milliseconds) */
  now?: () => number;
  /** How many run records are kept (not endlessly) */
  maxRuns?: number;
}

const DEFAULT_MAX_RUNS = 50;

/**
 * Merge the stages that came in last into the timeline (deduplicated by
 * `stepId`).
 *
 * → The batch that was reported live and the batch that is returned at the
 *   end are the same batch → without the deduplication every step
 *   appears twice ✗.
 */
function mergeStages(live: WorkflowStage[], final: WorkflowStage[]): WorkflowStage[] {
  const byId = new Map(live.map((s) => [s.stepId, s]));
  for (const stage of final) {
    if (!byId.has(stage.stepId)) byId.set(stage.stepId, stage);
  }
  return [...byId.values()];
}

export class WorkflowService {
  private readonly runs = new Map<string, WorkflowRunStatus>();
  private readonly order: string[] = [];
  /** One abort controller per run (the cancellation uses it) */
  private readonly aborts = new Map<string, AbortController>();
  private readonly now: () => number;
  private readonly maxRuns: number;

  constructor(private readonly opts: WorkflowServiceOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.maxRuns = opts.maxRuns ?? DEFAULT_MAX_RUNS;
  }

  /**
   * Get a workflow pack by id (for the dry_run).
   *
   * → It throws when the registry does not have it (with a
   *   machine-readable reason — the MCP layer hands it back to the agent).
   * → The preview leaks "what this pack will do" → whether it may be
   *   seen is decided by the permission area
   *   (no separate gate is added for it today · ADR-D48).
   */
  pack(id: string): WorkflowPack {
    const found = this.opts.registry.require(id);
    return found.pack;
  }

  /**
   * List the workflows the user approved (the ones that were not
   * approved are not listed — a card or an agent must not see what is
   * not authorised).
   */
  list(): WorkflowSummary[] {
    return this.opts.registry
      .list()
      .map((w) => ({
        id: w.id,
        name: w.name,
        version: w.version,
        inputs: Object.fromEntries(
          Object.entries(w.pack.inputs).map(([name, def]) => [
            name,
            {
              type: def.type,
              ...(def.required === undefined ? {} : { required: def.required }),
              ...(def.description === undefined ? {} : { description: def.description }),
              // The default value is given to the card too (contract section 2: `default` = the host prefills the common inputs — a card can be run with one click)
              ...(def.default === undefined ? {} : { default: def.default }),
            },
          ]),
        ),
      }));
  }

  /**
   * Start running a workflow (it returns a `runId` at once — a
   * compile takes a minute, it cannot be waited for synchronously).
   *
   * @throws when there is no such pack → `IPC_INVALID_PAYLOAD` (it says
   *   so)
   */
  start(
    id: string,
    inputs: Record<string, unknown>,
    _opts: Record<string, never> = {},
  ): { runId: string } {
    // ── The existence of a workflow pack is the explanation itself (ADR-D48) ──
    // → It may run any command (`exec` / `file.transfer`) → the board
    //   pack cannot govern it
    // → The gate is the unified permission area in the settings (the row
    //   of switches — ADR-D47)
    const registered = this.opts.registry.require(id);

    // ── Concurrency: only one run of the same workflow pack at a time ──
    // → Two workflows competing for the same serial line would interleave
    //   (fact S1)
    for (const existing of this.runs.values()) {
      if (existing.workflowId === id && existing.state === 'running') {
        throw makeError('IPC_INVALID_PAYLOAD', `workflow "${id}" is running (only one run of the same workflow at a time)`, {
          detail: { workflowId: id, runId: existing.runId },
        });
      }
    }

    // The run_id is unpredictable (V2-M10 of review 35):
    // an id derived from a timestamp can be guessed ✗ → and it is one of
    // the arguments of `confirm`.
    const runId = `wf-${randomUUID().slice(0, 8)}`;
    const status: WorkflowRunStatus = {
      runId,
      workflowId: registered.id,
      state: 'running',
      stages: [],
      current: null,
      outputs: {},
      inputs: { ...inputs },
      startedAt: this.now(),
    };
    this.runs.set(runId, status);
    this.order.push(runId);
    this.trim();

    // One abort controller per run (a cancellation has to really stop the step that is in flight)
    const abort = new AbortController();
    this.aborts.set(runId, abort);

    void this.execute(status, registered, inputs, 0, abort.signal);
    return { runId };
  }

  /**
   * Cancel a run ("the human does not want it any more").
   *
   * → It really stops the step that is in flight (measured: without
   *   this path a transfer step of 75 seconds ran to the end even after
   *   the cancellation ✗ — the host was still waiting for the marker).
   * → The state becomes `cancelled` (not failed — a cancellation is not
   *   a failure).
   *
   * @throws when there is no such run → `IPC_INVALID_PAYLOAD` ✓
   */
  cancel(runId: string): { runId: string } {
    const status = this.runs.get(runId);
    if (status === undefined) {
      throw makeError('IPC_INVALID_PAYLOAD', `no such run: ${runId}`, { detail: { runId } });
    }
    // A run that has ended → not a single character of the state changes
    // (idempotent — a cancellation may not turn a `done` into a `cancelled`)
    if (status.state === 'done' || status.state === 'failed' || status.state === 'cancelled') {
      return { runId };
    }
    this.aborts.get(runId)?.abort();
    status.state = 'cancelled';
    status.reason = 'cancelled';
    status.finishedAt = this.now();

    // One audit line is written ("who called it off" has to be traceable — I-8 of the independent review 40)
    this.opts.runDeps.audit({
      at: this.now(),
      actor: 'host',
      actionId: `workflow:${status.workflowId}:cancel`,
      params: { runId },
      ok: true,
      verified: true,
      detail: 'a human called this run off',
    });
    return { runId };
  }

  /**
   * Run it (in the background — the caller gets the runId at once).
   *
   * @param startAt which step to start at (continuing)
   */
  private async execute(
    status: WorkflowRunStatus,
    registered: { id: string; pack: WorkflowPack },
    inputs: Record<string, unknown>,
    startAt: number,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      const result: WorkflowRunResult = await runWorkflow(
        registered.pack,
        inputs,
        {
          ...this.opts.runDeps,
          now: this.now,
          // The timeline in real time (the host can say "which step is it at now" — contract section 8·B)
          timeline: {
            onStepStart: (info) => {
              status.current = { stepId: info.stepId, kind: info.kind, at: info.at };
            },
            onStage: (stage) => {
              status.stages = [...status.stages, stage];
            },
          },
        },
        {
          runId: status.runId,
          startAt,
          outputs: status.outputs,
          ...(signal === undefined ? {} : { signal }),
        },
      );
      // Deduplicated by stepId (the live reports and the final return are the same batch)
      status.stages = mergeStages(status.stages, result.stages);
      status.outputs = result.outputs;
      status.ok = result.ok;
      // A cancelled run → the state may not be turned back by this
      // finalisation (C-1 of the independent review 40)
      // → The state "cancelled" has to survive to the end (otherwise the
      //   interface calls "the human called it off" a failure ✗)
      if (status.state !== 'cancelled') {
        status.state = result.ok ? 'done' : 'failed';
        if (!result.ok) {
          const failed = result.stages.find((s) => !s.ok);
          status.reason = failed?.reason ?? 'failed';
        }
        status.finishedAt = this.now();
      }
      // The run has ended → there is no "current" any more
      status.current = null;
    } catch (err) {
      // A cancelled run → the state may not be turned back by this
      // exception path (I-1 of the independent review 40)
      // → "The human called it off" has to survive to the end (contract
      //   section 8·A·A2 — a cancellation is not a failure)
      if (status.state !== 'cancelled') {
        status.state = 'failed';
        status.reason = err instanceof Error ? err.message : String(err);
        status.finishedAt = this.now();
      }
    }
  }

  /** The status of one run (polling — ADR-D31 R9: poll in the first version) */
  status(runId: string): WorkflowRunStatus {
    const found = this.runs.get(runId);
    if (found === undefined) {
      throw makeError('IPC_INVALID_PAYLOAD', `no such run: ${runId}`, { detail: { runId } });
    }
    return found;
  }

  /** List the recent runs (for the diagnostics) */
  recent(): WorkflowRunStatus[] {
    return [...this.order].reverse().map((id) => this.runs.get(id) as WorkflowRunStatus);
  }

  /** Throw away the old run records (the memory must not grow endlessly) */

  private trim(): void {
    while (this.order.length > this.maxRuns) {
      const oldest = this.order.shift();
      if (oldest !== undefined) {
        this.runs.delete(oldest);
        this.aborts.delete(oldest);
      }
    }
  }
}
