import { RoundTripQueue } from '../hal/round-trip-queue';
import type { Connection } from '../hal/connection';
import type { SessionLog } from '../logging/session-log';
import type { ConnectionProfile } from '../profiles/schema';
import type { TagReading } from '../../shared/tag-reading';
import { TagStore } from './store';
import { TagSampler } from './sampler';
import { PollScheduler } from './scheduler';
import { resolvePack } from './binding';
import { validatePack, errorsOf } from './validator';

/**
 * tag 运行时 —— 把 M3/M4 写好的库**接进应用**。
 *
 * ── 它管四件事 ──
 *
 * | 事 | 为什么 |
 * |---|---|
 * | 建连接 → 绑包 → 校验 → 起调度器 | 「值要自己会动」的四个前提，缺一不可 |
 * | 读数**只经 TagStore** 进出 | ADR-D22：一份状态只有一份副本 |
 * | 晚订阅**不丢当前值** | 晚打开的窗口也该看到现在的数（契约 §2.1） |
 * | 失败**说清楚** | 「这块板没有板型包」与「连不上」是两件事 |
 *
 * ── 连接是谁的？──
 *
 * **运行时自己建一条连接**，与终端标签的连接**分开**。
 *
 * 理由：面板必须在**没有终端标签**的时候也有数——
 * 「看板子的读数」是这个产品的主线，终端是附带的。
 *
 * 代价（**明说，不藏**）：**串口是独占的**——
 * 运行时与终端标签各要一条连接，同一个 COM3 上**只能有一个**。
 * 第二个会失败（端口被占用），而失败是**看得见的**（不是静默）。
 * 这是串口这条路的**已知限制**，不是本模块的 bug。
 */

export type RuntimeState = 'idle' | 'running' | 'no-pack' | 'error';

export interface RuntimeStatus {
  state: RuntimeState;
  /** 人话：为什么不是 running */
  detail?: string;
  /** 正在采的是哪个连接 profile */
  profileId?: string;
}

export interface TagRuntimeOptions {
  /** 板型包目录的父目录 */
  packsDir: string;
  /** 建连接 */
  createConnection: (profile: ConnectionProfile, log: SessionLog) => Connection;
  /** 建会话日志 */
  createLog: (label: string, transport: string) => SessionLog;
}

export class TagRuntime {
  private readonly store = new TagStore();
  private readonly listeners: ((reading: TagReading) => void)[] = [];
  private scheduler: PollScheduler | undefined;
  private connection: Connection | undefined;
  private state: RuntimeState = 'idle';
  private detail: string | undefined;
  private profileId: string | undefined;

  constructor(private readonly opts: TagRuntimeOptions) {}

  /** 现在的状态 */
  get status(): RuntimeStatus {
    return {
      state: this.state,
      ...(this.detail === undefined ? {} : { detail: this.detail }),
      ...(this.profileId === undefined ? {} : { profileId: this.profileId }),
    };
  }

  /**
   * 开始采某个 profile 的读数。
   *
   * **不抛错**——失败都进 `status`：
   * 「这块板没有板型包」与「连不上」是**两件事**，
   * 都要让用户看见（契约 §十：「报『这块板没有板型包』」）。
   */
  async start(profile: ConnectionProfile): Promise<RuntimeStatus> {
    this.stop();
    this.profileId = profile.id;

    // 1) 建连接
    const log = this.opts.createLog(`tags-${profile.id}`, profile.transport);
    const connection = this.opts.createConnection(profile, log);
    try {
      await connection.open();
    } catch (err) {
      this.state = 'error';
      this.detail = err instanceof Error ? err.message : String(err);
      return this.status;
    }
    this.connection = connection;

    // 2) 绑板型包（连接指名优先，否则按型号自动识别）
    const binding = await resolvePack({
      connection,
      boardPackId: profile.board_pack ?? null,
      packsDir: this.opts.packsDir,
    });
    if (binding.pack === null) {
      this.state = 'no-pack';
      this.detail = binding.reason;
      await this.closeConnection();
      return this.status;
    }

    // 3) 校验（过不了自己校验器的包不采）
    const errs = errorsOf(validatePack(binding.pack));
    if (errs.length > 0) {
      this.state = 'error';
      this.detail = `板型包「${binding.pack.id}」没过校验：${errs
        .map((e) => `规则 ${e.rule} · ${e.path}`)
        .join('；')}`;
      await this.closeConnection();
      return this.status;
    }

    // 4) 起调度器（一切往返都经队列，契约 §1.2.1）
    const queue = new RoundTripQueue();
    const sampler = new TagSampler(binding.pack, connection, this.store);
    this.scheduler = new PollScheduler(binding.pack, sampler, queue);
    this.scheduler.start();

    // 读数只经 TagStore 出（ADR-D22）
    this.store.subscribe((reading) => {
      for (const listener of this.listeners) listener(reading);
    });

    this.state = 'running';
    this.detail = undefined;
    return this.status;
  }

  /** 停下：停调度器、关连接 */
  stop(): void {
    this.scheduler?.stop();
    this.scheduler = undefined;
    void this.closeConnection();
    this.state = 'idle';
    this.detail = undefined;
  }

  /** 当前的读数快照（**晚订阅的人靠它看到现在的数**） */
  readings(): TagReading[] {
    return this.store.all();
  }

  /** 听读数的变化 */
  subscribe(cb: (reading: TagReading) => void): () => void {
    this.listeners.push(cb);
    return () => {
      const at = this.listeners.indexOf(cb);
      if (at >= 0) this.listeners.splice(at, 1);
    };
  }

  private async closeConnection(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    if (connection === undefined) return;
    await connection.close().catch(() => undefined);
  }
}
