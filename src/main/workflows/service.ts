import { makeError } from '../../shared/errors';
import { runWorkflow, type WorkflowRunDeps, type WorkflowRunResult, type WorkflowStage } from './runner';
import type { WorkflowRegistry } from './registry';

/**
 * 流程的**宿主服务** —— 卡片与 agent 触发流程时走的那一层。
 *
 * ── 三件事（两份独立评审的 C1/C2/C3 逼出来的）──
 *
 * | # | 事 | 为什么 |
 * |---|---|---|
 * | 1 | **只认 id，不认路径** | 「放一个文件进目录」不等于「批准它」✓；卡片/agent **给不了路径** ✓ → 否则 agent 能自写一个包就跑 ✗（评审 32-C1 ✓） |
 * | 2 | **跑之前查批准账** | `requireApproved(id)` ✓ → 没批准的包**跑不了** ✓ |
 * | 3 | **长任务 = run_id + 轮询** | 编译实测 58.9s / 98.5s（评审 31-C3 ✓）→ **同步返回时间线是不成立的** ✗ → `start()` 立刻给 `runId`，`status()` 取进度 ✓ |
 *
 * ── 「谁批准的」由谁点头 ──
 *
 * → **装卡时**（卡片声明 `requires.workflows` → 装它的界面要人点头 ✓），
 * 或 → **命令行 `npm run workflow:approve -- <id>`** ✓（那是人自己敲的 ✓）。
 * → 两条路都落在**同一本批准账**里 ✓（`workflows-approved.json` ✓）。
 */
export interface WorkflowSummary {
  id: string;
  name: string;
  version: string;
  /** 用户批过吗（**没批过的卡片/agent 看不见** ✓） */
  approved: boolean;
  /** 输入声明（卡片要按它渲染表单 ✓） */
  inputs: Record<string, { type: string; required?: boolean; description?: string }>;
}

export interface WorkflowRunStatus {
  runId: string;
  workflowId: string;
  /** `running` | `done` | `failed` | `cancelled` */
  state: 'running' | 'done' | 'failed' | 'cancelled';
  /** 时间线（**跑到哪一步了** ✓） */
  stages: WorkflowStage[];
  /** 产出的槽 */
  outputs: Record<string, string>;
  ok?: boolean;
  reason?: string;
  /** 要人确认（危险命令 ✓） */
  needsConfirmation?: { stepId: string; confirmId: string; detail: string };
  startedAt: number;
  finishedAt?: number;
}

export interface WorkflowServiceOptions {
  registry: WorkflowRegistry;
  /** 跑一条流程要什么（连接、审计……） */
  runDeps: WorkflowRunDeps;
  /** 现在（毫秒） */
  now?: () => number;
  /** 一次留多少条运行记录（**别无限长** ✓） */
  maxRuns?: number;
}

const DEFAULT_MAX_RUNS = 50;

export class WorkflowService {
  private readonly runs = new Map<string, WorkflowRunStatus>();
  private readonly order: string[] = [];
  private readonly now: () => number;
  private readonly maxRuns: number;

  constructor(private readonly opts: WorkflowServiceOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.maxRuns = opts.maxRuns ?? DEFAULT_MAX_RUNS;
  }

  /**
   * 列**用户批过的**流程（**没批过的不列** ✓ —— 卡片/agent 看不见没授权的东西 ✓）。
   */
  list(): WorkflowSummary[] {
    return this.opts.registry
      .list()
      .filter((w) => w.approved)
      .map((w) => ({
        id: w.id,
        name: w.name,
        version: w.version,
        approved: true,
        inputs: Object.fromEntries(
          Object.entries(w.pack.inputs).map(([name, def]) => [
            name,
            {
              type: def.type,
              ...(def.required === undefined ? {} : { required: def.required }),
              ...(def.description === undefined ? {} : { description: def.description }),
            },
          ]),
        ),
      }));
  }

  /**
   * **开始**跑一条流程（**立刻返回 `runId`** ✓ —— 编译要一分钟，不能同步等 ✓）。
   *
   * @throws 这个 id 没批准 / 没有这个包 → `IPC_INVALID_PAYLOAD`（**说清楚** ✓）
   */
  start(
    id: string,
    inputs: Record<string, unknown>,
    opts: { confirmIds?: Record<string, string> } = {},
  ): { runId: string } {
    const registered = this.opts.registry.requireApproved(id);
    const runId = `wf-${this.now().toString(36)}-${this.runs.size + 1}`;
    const status: WorkflowRunStatus = {
      runId,
      workflowId: registered.id,
      state: 'running',
      stages: [],
      outputs: {},
      startedAt: this.now(),
    };
    this.runs.set(runId, status);
    this.order.push(runId);
    this.trim();

    // **后台跑**（不 await ✓ —— 调用方立刻拿到 runId ✓）
    void runWorkflow(
      registered.pack,
      inputs,
      {
        ...this.opts.runDeps,
        now: this.now,
      },
      { approved: true, ...(opts.confirmIds === undefined ? {} : { confirmIds: opts.confirmIds }) },
    )
      .then((result: WorkflowRunResult) => {
        status.stages = result.stages;
        status.outputs = result.outputs;
        status.ok = result.ok;
        status.state = result.ok ? 'done' : 'failed';
        if (result.needsConfirmation !== undefined) {
          status.needsConfirmation = result.needsConfirmation;
          status.reason = 'needs_confirmation';
        } else if (!result.ok) {
          const failed = result.stages.find((s) => !s.ok);
          status.reason = failed?.reason ?? 'failed';
        }
        status.finishedAt = this.now();
      })
      .catch((err: unknown) => {
        status.state = 'failed';
        status.reason = err instanceof Error ? err.message : String(err);
        status.finishedAt = this.now();
      });

    return { runId };
  }

  /** 取一次运行的状态（**轮询** ✓ —— ADR-D31 R9：首版 poll ✓） */
  status(runId: string): WorkflowRunStatus {
    const found = this.runs.get(runId);
    if (found === undefined) {
      throw makeError('IPC_INVALID_PAYLOAD', `没有这次运行：${runId}`, { detail: { runId } });
    }
    return found;
  }

  /** 列最近的运行（**诊断用** ✓） */
  recent(): WorkflowRunStatus[] {
    return [...this.order].reverse().map((id) => this.runs.get(id) as WorkflowRunStatus);
  }

  /** 旧的运行记录**扔掉**（别让内存无限长 ✓） */
  private trim(): void {
    while (this.order.length > this.maxRuns) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.runs.delete(oldest);
    }
  }
}
