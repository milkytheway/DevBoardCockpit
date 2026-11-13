/**
 * 一次往返的队列（契约 `docs/spec/02-board-pack.md` §1.2.1）。
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
 * ── 四条语义 ──
 *
 * | 契约 | 这里 |
 * |---|---|
 * | 采样与动作进**同一个队列** | 一个类，两个队列（action / sample），**一条推进链** |
 * | **动作优先于采样**，采样让路 | 推进时先取 action 队列 |
 * | 采样让路 → **跳过本周期**，不补发 | （调度器的责任，\`scheduler.ts\`） |
 * | 超时后要等 marker 收齐或**明确放弃** | （**传输层**的责任。**队列不超时**——见下） |
 *
 * ── 为什么队列**不做**自己的超时 ──
 *
 * 超时是**传输层**的事（事实 G1：统一返回 124；
 * 串口是「等 marker 收齐或**明确放弃**」）。
 *
 * 队列若自己判超时，就会在**传输层还在等 marker**的时候放行下一次往返——
 * 下一次往返就会**认领上一次残留的回包**（契约 §1.2.1 的「超时清理」，
 * 也就是本计划的 RF-2）。
 * 那比「队列堵住」糟得多：**堵住是看得见的，串台是看不见的。**
 */

/** 一次往返的种类 */
export type RoundTripKind = 'action' | 'sample';

interface Entry {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export class RoundTripQueue {
  /** 动作往返（优先） */
  private readonly actions: Entry[] = [];
  /** 采样往返 */
  private readonly samples: Entry[] = [];
  /** 当前在飞的往返数（**恒为 0 或 1**） */
  private inFlight = 0;
  /** 是否已经在推进（防止重入） */
  private draining = false;

  /**
   * 排队执行一次往返。
   *
   * @param kind `'action'` 插队到 `'sample'` 前面
   * @param fn 真正干活的那个闭包
   */
  run<T>(kind: RoundTripKind, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: Entry = {
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      if (kind === 'action') this.actions.push(entry);
      else this.samples.push(entry);
      this.drain();
    });
  }

  /** 队列里还没开始执行的个数 */
  get pending(): number {
    return this.actions.length + this.samples.length;
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
        // **动作优先**：动作排在采样前面。
        // 但**已经飞行中的那次往返不会被插队**——串口上没法半途换人。
        const entry = this.actions.shift() ?? this.samples.shift();
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
}
