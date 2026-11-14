import { makeError } from '../../shared/errors';

/**
 * 一次往返的队列（契约 `docs/spec/02-board-pack.md` §1.2.1 · ADR-D23）。
 *
 * ── 它解决什么 ──
 *
 * 契约 §1.2.1：「**同一个连接上，同时只能有一次往返。**
 * poll group 的采样往返与动作往返共享同一条通道，必须串行化。」
 *
 * 这在串口上是硬约束：命令通道和交互终端**共用一根线**（事实 S1），
 * 只有**一个读线程 + 一份 transcript**，命令靠 marker 认领自己的回包。
 * 两次往返并发时，两个 marker 的回包会在同一份 transcript 里交错——
 * 契约点名的症状是：「**点了按钮，监控卡数值乱跳**」。
 *
 * ── 四级优先级（ADR-D23）──
 *
 * | 级别 | 谁 |
 * |---|---|
 * | `action-verify` | **动作的执行 + 回读**（一个不可拆分的独占事务） |
 * | `manual-refresh` | 用户手动触发的刷新 |
 * | `card-sampling` | 卡片的周期采样 |
 * | `diagnostics` | 探针与诊断 |
 *
 * ── 排队不许无限（ADR-D23）──
 *
 * 「每个事务带 deadline（连接级默认 3 秒）；排队超时报 `conn_busy`，队列有上限。」
 *
 * **为什么要有上限**：无界排队等于把「卡」变成「数据旧」，
 * 而那是最难排查的一类故障——**慢不是错，静默地慢才是**。
 */
export type RoundTripKind = 'action-verify' | 'manual-refresh' | 'card-sampling' | 'diagnostics';

/** 优先级（从高到低） */
const PRIORITY: readonly RoundTripKind[] = [
  'action-verify',
  'manual-refresh',
  'card-sampling',
  'diagnostics',
];

/** 每个事务的选项 */
export interface RoundTripOptions {
  /**
   * 这个事务的 deadline（毫秒，**从入队算起**）。
   *
   * 排队超过它 → 报 `conn_busy`，**这条事务被丢掉**（不执行）。
   */
  deadlineMs?: number;
}

/** 队列本身的选项 */
export interface RoundTripQueueOptions {
  /** 现在（毫秒）——测试注入假时钟 */
  now?: () => number;
  /** 队列上限（同时排队的个数） */
  maxPending?: number;
  /** 默认 deadline（毫秒）——ADR-D23「连接级默认 3 秒」 */
  deadlineMs?: number;
}

/** 一次往返的种类 */
interface Entry {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  /** 入队时刻（算 deadline 用） */
  enqueuedAt: number;
  /** 这一条自己的 deadline */
  deadlineMs: number;
}

const DEFAULT_MAX_PENDING = 32;
const DEFAULT_DEADLINE_MS = 3_000;

export class RoundTripQueue {
  /** 四级各一个队列（从高到低） */
  private readonly queues: Record<RoundTripKind, Entry[]> = {
    'action-verify': [],
    'manual-refresh': [],
    'card-sampling': [],
    diagnostics: [],
  };
  /** 当前在飞的往返数（**恒为 0 或 1**） */
  private inFlight = 0;
  /** 已经在推进（防止重入） */
  private draining = false;

  private readonly now: () => number;
  private readonly maxPending: number;
  private readonly deadlineMs: number;

  constructor(opts: RoundTripQueueOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.maxPending = opts.maxPending ?? DEFAULT_MAX_PENDING;
    this.deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  }

  /**
   * 排一次往返。
   *
   * @param kind 优先级级别
   * @param fn 真正干活的那个闭包
   * @param opts 这一条事务的选项（deadline 可覆盖）
   */
  run<T>(kind: RoundTripKind, fn: () => Promise<T>, opts: RoundTripOptions = {}): Promise<T> {
    if (this.load >= this.maxPending) {
      // **不排队**：直接拒（`conn_busy`）——
      // 无界排队等于把「卡」变成「数据旧」，而那最难排查。
      return Promise.reject(
        makeError('CONN_BUSY', `往返队列已满（${this.maxPending} 条在排队），这次不排队`, {
          detail: { kind, pending: this.pending },
        }),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const entry: Entry = {
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        enqueuedAt: this.now(),
        deadlineMs: opts.deadlineMs ?? this.deadlineMs,
      };
      this.queues[kind].push(entry);
      this.drain();
    });
  }

  /** 队列的负载（**在飞 + 等待**）——上限按它算 */
  get load(): number {
    return this.inFlight + this.pending;
  }

  /** 队列里还没开始执行的个数 */
  get pending(): number {
    return PRIORITY.reduce((sum, kind) => sum + this.queues[kind].length, 0);
  }

  /** 当前有没有一次往返在飞 */
  get busy(): boolean {
    return this.inFlight > 0;
  }

  /** 开始推进（已经在推进就不重复来） */
  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    void this.pump();
  }

  /**
   * 推进队列。
   *
   * **一条链**——不管从哪个队列进来，都由这里推进。
   * 两条独立的链会各自开跑 → 两次往返并发 → 串口上串台。
   */
  private async pump(): Promise<void> {
    try {
      for (;;) {
        const entry = this.take();
        if (entry === undefined) break;

        this.inFlight += 1;
        try {
          const value = await entry.fn();
          entry.resolve(value);
        } catch (err) {
          // 一把锁坏了不该让整条通道都废了。
          entry.reject(err);
        } finally {
          this.inFlight -= 1;
        }
      }
    } finally {
      this.draining = false;
      // 推进期间可能又来了新的（resolve 触发的 run 会在微任务里跑）
      if (this.pending > 0) this.drain();
    }
  }

  /**
   * 按优先级取下一条。
   *
   * **deadline 到了的那条**：丢掉并报 `conn_busy`（不执行）——
   * 一条排了半分钟的动作，跑起来可能已经过时了。
   */
  private take(): Entry | undefined {
    for (const kind of PRIORITY) {
      const queue = this.queues[kind];
      while (queue.length > 0) {
        const entry = queue.shift() as Entry;
        const waited = this.now() - entry.enqueuedAt;
        if (waited > entry.deadlineMs) {
          entry.reject(
            makeError('CONN_BUSY', `排队 ${waited}ms 超过 deadline（${entry.deadlineMs}ms），这次不执行`, {
              detail: { kind, waited, deadlineMs: entry.deadlineMs },
            }),
          );
          continue;
        }
        return entry;
      }
    }
    return undefined;
  }
}
