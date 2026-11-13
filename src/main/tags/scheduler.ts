import type { BoardPack } from './schema';
import type { RoundTripQueue } from '../hal/round-trip-queue';

/**
 * 轮询调度器（契约 `docs/spec/02-board-pack.md` §1.2）。
 *
 * ── 它做什么 ──
 *
 * 每个 poll group 按自己的 `interval_ms` 采一次样，
 * **一律经往返队列**（契约 §1.2.1）——
 * 调度器自己不碰 `exec`。
 *
 * ── 「跳过本周期，不补发」 ──
 *
 * 契约 §1.2.1：「poll group 的采样若因让路错过本周期，**跳过本周期**，
 * 不补发。补发会让 `/proc/stat` 的差值窗口变得毫无意义。」
 *
 * 怎么判「错过了」：
 *
 * | 量 | 含义 |
 * |---|---|
 * | **等待时长** = 拿到执行权的那一刻 − 入队的那一刻 | **不含**这次采样自己的执行时间 |
 * | 判据 | 等待时长 > 周期 + 宽限 → 这一轮**跳过**（不采样） |
 *
 * 为什么用「等待时长」而不是「总时长」：一次采样自己的往返可能就比周期长
 * （串口尤其慢），那**不是**让路造成的，不该因此跳过——
 * **板子慢 ≠ 错过了周期**。只有**在队列里等**才是让路。
 *
 * 宽限取周期的一半：等了不到一个半周期就采——
 * 那个值仍然是**一次真实的测量**（差值窗口就是它自己的窗口）。
 */

export interface SchedulerOptions {
  /** 现在的时刻（毫秒）。测试注入假时钟 */
  now?: () => number;
  /** 装定时器。测试注入假时钟 */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** 拆定时器 */
  clearTimer?: (handle: unknown) => void;
}

/**
 * 调度器只需要「能采一个组」这一件事。
 *
 * **写成结构类型而不是 `TagSampler`**：这样测试能塞一个假的进来，
 * 而 `TagSampler`（有私有字段）**本身**也满足它。
 */
export interface GroupSampler {
  sampleGroup(groupId: string): Promise<void>;
}

interface GroupState {
  id: string;
  intervalMs: number;
  /** 已入队或飞行中（防堆积） */
  queued: boolean;
  handle: unknown;
}

export class PollScheduler {
  private readonly groups = new Map<string, GroupState>();
  private readonly ranCounts = new Map<string, number>();
  private skippedCount = 0;
  private running = false;

  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    pack: BoardPack,
    private readonly sampler: GroupSampler,
    private readonly queue: RoundTripQueue,
    opts: SchedulerOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    for (const group of pack.poll_groups) {
      this.groups.set(group.id, {
        id: group.id,
        intervalMs: group.interval_ms,
        queued: false,
        handle: undefined,
      });
    }
  }

  /** 开始调度 */
  start(): void {
    if (this.running) return;
    this.running = true;
    for (const group of this.groups.values()) this.arm(group);
  }

  /** 停下：清掉所有定时器 */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const group of this.groups.values()) {
      this.clearTimer(group.handle);
      group.handle = undefined;
    }
  }

  /** 因让路而**跳过**的采样周期数（判据用） */
  get skipped(): number {
    return this.skippedCount;
  }

  /** 每个组**实际采过**的次数（判据用） */
  get ran(): Map<string, number> {
    return new Map(this.ranCounts);
  }

  /** 给某个组装上下一个定时器 */
  private arm(group: GroupState): void {
    if (!this.running) return;
    group.handle = this.setTimer(() => {
      this.onTick(group);
      this.arm(group);
    }, group.intervalMs);
  }

  /** 定时器到点了 */
  private onTick(group: GroupState): void {
    if (!this.running) return;

    if (group.queued) {
      // 上一次还没回来 → **这一周期错过**（跳过，不补发）。
      // 队列里**不再加一个**——补发会让队列越积越多。
      this.skippedCount += 1;
      return;
    }

    group.queued = true;
    const enqueuedAt = this.now();

    void this.queue
      .run('sample', async () => {
        try {
          // 在队列里等了多久？（不含这次采样自己的执行时间）
          const waited = this.now() - enqueuedAt;
          const slack = Math.floor(group.intervalMs / 2);
          if (waited > group.intervalMs + slack) {
            // 这一轮错过了自己的周期 → 跳过，**不补发**
            this.skippedCount += 1;
            return;
          }
          await this.sampler.sampleGroup(group.id);
          this.ranCounts.set(group.id, (this.ranCounts.get(group.id) ?? 0) + 1);
        } finally {
          group.queued = false;
        }
      })
      .catch(() => {
        // 采样失败不该炸掉调度器——下一个周期照常。
        group.queued = false;
      });
  }
}
