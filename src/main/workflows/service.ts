import { randomUUID } from 'node:crypto';
import { makeError } from '../../shared/errors';
import { runWorkflow, type WorkflowRunDeps, type WorkflowRunResult, type WorkflowStage } from './runner';
import type { WorkflowRegistry } from './registry';
import type { WorkflowPack } from './format';

/**
 * 流程的**宿主服务** —— 卡片与 agent 触发流程时走的那一层。
 *
 * ── 三件事（两份独立评审的 C1/C2/C3 逼出来的）──
 *
 * | # | 事 | 为什么 |
 * |---|---|---|
 * | 1 | **只认 id，不认路径** | 「放一个文件进目录」不等于「批准它」✓；卡片/agent **给不了路径** ✓ → 否则 agent 能自写一个包就跑 ✗（评审 32-C1 ✓） |
 * | 2 | **跑之前查注册表** | `require(id)` ✓ → 没有这个包**跑不了** ✓（**不再有「批准」那一层** ✓） |
 * | 3 | **长任务 = run_id + 轮询** | 编译实测 58.9s / 98.5s（评审 31-C3 ✓）→ **同步返回时间线是不成立的** ✗ → `start()` 立刻给 `runId`，`status()` 取进度 ✓ |
 *
 * ── 「谁能跑」由谁点头 ──
 *
 * → **设置里的统一权限区** ✓（ADR-D47 ✓）：**流程那一行开关** ✓
 * → **卡片触发流程默认允许** ✓ · **agent 默认允许** ✓（**危险的那类默认关** ✓）
 * → **流程包的存在本身就是说明** ✓（**批准账 2026-11-16 砍掉** ✓ · ADR-D48 ✓）。
 */
export interface WorkflowSummary {
  id: string;
  name: string;
  version: string;
  /** 输入声明（卡片要按它渲染表单 ✓ —— **`default` 也要给** ✓，卡片才能自己预填 ✓） */
  inputs: Record<string, {
    type: string;
    required?: boolean;
    description?: string;
    default?: unknown;
  }>;
}

/**
 * **当前这一步**（契约 `05` §八·B ✓）。
 *
 * → **正在跑** ✓ **或** **停下等人点头** ✓（那一步**也是**「当前」✓）→
 * 运行结束 → `null` ✓。
 * → **不给角色** ✓（不给拓扑 ✓ —— 卡片与 agent 不该知道「哪台机器」✓）。
 */
export interface WorkflowCurrent {
  stepId: string;
  kind: string;
  /** **这一步开始的时刻** ✓ → 界面据此算「已经用了多久」✓ */
  at: number;
}

export interface WorkflowRunStatus {
  runId: string;
  workflowId: string;
  /**
   * 运行状态。
   *
   * → **四档**（`running` / `done` / `failed` / `cancelled` ✓）——
   * **「等人点头」那档 2026-11-16 没了** ✓（**确认链整体砍掉** ✓ · ADR-D48 ✓）。
   * → 停在某一步**只会是 `running`** ✓ · **取消是 `cancelled`** ✓ —— **不是 `failed`** ✓。
   */
  state: 'running' | 'done' | 'failed' | 'cancelled';
  /** 时间线（**跑到哪一步了** ✓） */
  stages: WorkflowStage[];
  /** **当前这一步**（`null` = 没有在飞的 ✓ —— 运行已结束 ✓） */
  current: WorkflowCurrent | null;
  /** 产出的槽 */
  outputs: Record<string, string>;
  ok?: boolean;
  reason?: string;
  /** 要人确认（危险命令 ✓） */
  /**
   * **停在第几步**（索引 ✓）——续跑时**从这一步继续** ✓，
   * **前面的步不重跑** ✓（重跑 = 编译两遍 ✗）。
   */
  pausedAtStep?: number;
  /** 续跑时要带上的**输入**（**同一个运行** ✓ —— 换了输入就不是同一件事了 ✓） */
  inputs?: Record<string, unknown>;
  startedAt: number;
  finishedAt?: number;
}

export interface WorkflowServiceOptions {
  registry: WorkflowRegistry;
  /** 跑一条流程要什么（连接、审计……） */
  runDeps: WorkflowRunDeps;
  /**
   * 确认凭据的库（**流程层与 M6 共用一份** ✓ ——
   * 凭据的语义只有一处 ✓：`spec/04` §2.4.1 的那套 ✓）。
   */
  /** 现在（毫秒） */
  now?: () => number;
  /** 一次留多少条运行记录（**别无限长** ✓） */
  maxRuns?: number;
}

const DEFAULT_MAX_RUNS = 50;

/**
 * 把最后拿到的阶段并进时间线（**按 `stepId` 去重** ✓）。
 *
 * → 实时上报的那批与最后返回的那批**是同一批** ✓ → 不去重会**每一步出现两次** ✗。
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
  /** 每次运行一个**叫停器**（取消用它 ✓） */
  private readonly aborts = new Map<string, AbortController>();
  private readonly now: () => number;
  private readonly maxRuns: number;

  constructor(private readonly opts: WorkflowServiceOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.maxRuns = opts.maxRuns ?? DEFAULT_MAX_RUNS;
  }

  /**
   * **按 id 取一个流程包**（**给 dry_run 用** ✓）。
   *
   * → **注册表里没有就抛** ✓（带机器可读的 reason ✓ —— MCP 那层要回给 agent ✓）。
   * → **预览会泄出「这个包会干什么」** ✓ —— **能不能看由权限区说了算** ✓
   *   （**今天不给它单独加一道** ✓ —— ADR-D48 ✓）。
   */
  pack(id: string): WorkflowPack {
    const found = this.opts.registry.require(id);
    return found.pack;
  }

  /**
   * 列**用户批过的**流程（**没批过的不列** ✓ —— 卡片/agent 看不见没授权的东西 ✓）。
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
              // **默认值也给卡片** ✓（契约 §二：`default` = 宿主预填常用输入 ✓ —— 卡片点一下就能跑 ✓）
              ...(def.default === undefined ? {} : { default: def.default }),
            },
          ]),
        ),
      }));
  }

  /**
   * **开始**跑一条流程（**立刻返回 `runId`** ✓ —— 编译要一分钟，不能同步等 ✓）。
   *
   * @throws 没有这个包 → `IPC_INVALID_PAYLOAD`（**说清楚** ✓）
   */
  start(
    id: string,
    inputs: Record<string, unknown>,
    _opts: Record<string, never> = {},
  ): { runId: string } {
    // ── **流程包的存在本身就是说明** ✓（ADR-D48 ✓）──
    // → 它能跑**任意命令** ✓（`exec` / `file.transfer` ✓）→ **板型包管不到** ✓
    // → **闸在设置里的统一权限区** ✓（**那一行开关** ✓ —— ADR-D47 ✓）
    const registered = this.opts.registry.require(id);

    // ── 并发：同一个流程包同时只允许一次运行 ✓ ──
    // → 两个流程同时抢一条串口会**串台** ✓（事实 S1 ✓）
    for (const existing of this.runs.values()) {
      if (existing.workflowId === id && existing.state === 'running') {
        throw makeError('IPC_INVALID_PAYLOAD', `流程「${id}」正在跑（同一个流程同时只允许一次）`, {
          detail: { workflowId: id, runId: existing.runId },
        });
      }
    }

    // **run_id 不可预测**（评审 35 的 V2-M10 ✓）：
    // 时间戳派生的 id **能被猜到** ✗ → 而它是 `confirm` 的入参之一 ✓。
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

    // **每次运行一个叫停器** ✓（取消要能真的停掉在飞的那一步 ✓）
    const abort = new AbortController();
    this.aborts.set(runId, abort);

    void this.execute(status, registered, inputs, 0, abort.signal);
    return { runId };
  }

  /**
   * **取消**一次运行（「人不要了」✓）。
   *
   * → **真的停掉在飞的那一步** ✓（尖兵实测：没有这条路时，
   * 一个 75 秒的传输步**收到取消后照跑完** ✗ —— 宿主还在等 marker ✓）。
   * → 状态变成 `cancelled` ✓（**不是 failed** ✓ —— 取消不是失败 ✓）。
   *
   * @throws 没有这次运行 → `IPC_INVALID_PAYLOAD` ✓
   */
  cancel(runId: string): { runId: string } {
    const status = this.runs.get(runId);
    if (status === undefined) {
      throw makeError('IPC_INVALID_PAYLOAD', `没有这次运行：${runId}`, { detail: { runId } });
    }
    // **已经结束的运行 → 状态一个字都不改** ✓
    // （幂等 ✓ —— 取消不能把 `done` 改成 `cancelled` ✗）
    if (status.state === 'done' || status.state === 'failed' || status.state === 'cancelled') {
      return { runId };
    }
    this.aborts.get(runId)?.abort();
    status.state = 'cancelled';
    status.reason = 'cancelled';
    status.finishedAt = this.now();

    // **记一行审计** ✓（「谁叫停的」要查得到 ✓ —— 独立评审 40 的 I-8 ✓）
    this.opts.runDeps.audit({
      at: this.now(),
      actor: 'host',
      actionId: `workflow:${status.workflowId}:cancel`,
      params: { runId },
      ok: true,
      verified: true,
      detail: '人叫停了这次运行',
    });
    return { runId };
  }

      /**
   * 跑（**后台** ✓ —— 调用方立刻拿到 runId ✓）。
   *
   * @param startAt 从第几步开始（**续跑** ✓）
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
          // **实时时间线** ✓（宿主据此说得出「现在在第几步」✓ —— 契约 §八·B ✓）
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
      // **按 stepId 去重** ✓（实时上报的与最后返回的是同一批 ✓）
      status.stages = mergeStages(status.stages, result.stages);
      status.outputs = result.outputs;
      status.ok = result.ok;
      // **取消过的运行 → 状态不许被这次收尾翻回去** ✓（独立评审 40 的 C-1 ✓）
      // → 「取消」这个状态**必须活到最后** ✓（否则界面会把「人叫停」说成「出错了」✗）
      if (status.state !== 'cancelled') {
        status.state = result.ok ? 'done' : 'failed';
        if (!result.ok) {
          const failed = result.stages.find((s) => !s.ok);
          status.reason = failed?.reason ?? 'failed';
        }
        status.finishedAt = this.now();
      }
      // **运行结束了 → 没有「当前」了** ✓
      status.current = null;
    } catch (err) {
      // **取消过的运行 → 状态不许被这条异常路径翻回去** ✓（独立评审 40 的 I-1 ✓）
      // → 「人叫停」必须活到最后 ✓（契约 §八·A·A2 ✓ —— 取消不是失败 ✓）
      if (status.state !== 'cancelled') {
        status.state = 'failed';
        status.reason = err instanceof Error ? err.message : String(err);
        status.finishedAt = this.now();
      }
    }
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
      if (oldest !== undefined) {
        this.runs.delete(oldest);
        this.aborts.delete(oldest);
      }
    }
  }
}
