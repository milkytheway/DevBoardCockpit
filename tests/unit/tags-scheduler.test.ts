import { describe, it, expect, vi } from 'vitest';
import { PollScheduler } from '../../src/main/tags/scheduler';
import { RoundTripQueue } from '../../src/main/hal/round-trip-queue';
import type { BoardPack } from '../../src/main/tags/schema';

/**
 * 轮询调度器（契约 `docs/spec/02-board-pack.md` §1.2）。
 *
 * ── 契约要的两件事 ──
 *
 * | 契约 | 这里 |
 * |---|---|
 * | poll group 按自己的 \`interval_ms\` 采样 | 每个组一个定时器 |
 * | 采样**因让路错过本周期 → 跳过本周期，不补发** | 队列里等着的时候，周期一到就算错过 |
 *
 * ── 为什么「不补发」这么要紧 ──
 *
 * 契约 §1.2.1：「补发会让 \`/proc/stat\` 的差值窗口变得毫无意义」——
 * 两次采样之间隔了多久，直接决定那个百分比说的是哪一段时间。
 * 补发一次 = **拿一个 3 秒前的差值当 1 秒的读数**——
 * **看起来是个数，其实是错的**。
 */

/** 一个能手动推进的假时钟 */
class FakeClock {
  private current = 0;
  private nextHandle = 1;
  private timers: { fn: () => void; at: number; handle: number }[] = [];

  now = (): number => this.current;

  setTimer = (fn: () => void, ms: number): unknown => {
    const handle = this.nextHandle++;
    this.timers.push({ fn, at: this.current + ms, handle });
    return handle;
  };

  clearTimer = (handle: unknown): void => {
    this.timers = this.timers.filter((t) => t.handle !== handle);
  };

  /** 推进到 target，途中触发到点的定时器 */
  advanceTo(target: number): void {
    for (;;) {
      const due = this.timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.current = due.at;
      this.timers = this.timers.filter((t) => t !== due);
      due.fn();
    }
    this.current = target;
  }

  get time(): number {
    return this.current;
  }
}

const PACK: BoardPack = {
  apiVersion: 'devboard/v1',
  kind: 'BoardPack',
  id: 'tiny',
  name: '最小包',
  version: '1.0.0',
  requires: { transports: ['adb'], capabilities: ['exec'] },
  poll_groups: [{ id: 'fast', interval_ms: 1000, readers: ['cpu'] }],
  readers: [],
  custom: [],
  actions: [],
};

describe('PollScheduler · 按 interval_ms 驱动', () => {
  it('start() 之后推进一个周期，该组被采一次', async () => {
    const clock = new FakeClock();
    const sampler = { sampleGroup: vi.fn(async () => {}) };
    const queue = new RoundTripQueue();
    const scheduler = new PollScheduler(PACK, sampler, queue, {
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    scheduler.start();
    expect(sampler.sampleGroup).not.toHaveBeenCalled();

    clock.advanceTo(1000);
    expect(sampler.sampleGroup).toHaveBeenCalledTimes(1);
    expect(sampler.sampleGroup).toHaveBeenCalledWith('fast');
    // `ran` 是在 await 之后才记的 → 先让微任务跑完
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduler.ran.get('fast')).toBe(1);
  });

  it('stop() 之后不再有采样', () => {
    const clock = new FakeClock();
    const sampler = { sampleGroup: vi.fn(async () => {}) };
    const scheduler = new PollScheduler(PACK, sampler, new RoundTripQueue(), {
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    scheduler.start();
    clock.advanceTo(1000);
    expect(sampler.sampleGroup).toHaveBeenCalledTimes(1);

    scheduler.stop();
    clock.advanceTo(5000);
    expect(sampler.sampleGroup).toHaveBeenCalledTimes(1);
  });

  it('**绝不直接调 sampleGroup**——一切经队列（P3）', async () => {
    const clock = new FakeClock();
    const sampler = { sampleGroup: vi.fn(async () => {}) };
    const queue = new RoundTripQueue();

    // **先把队列占住**：一条不回来的动作
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    void queue.run('action-verify', () => blocked);

    const scheduler = new PollScheduler(PACK, sampler, queue, {
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    scheduler.start();
    clock.advanceTo(1000);
    await Promise.resolve();
    await Promise.resolve();

    // 队列被占着 → **采样必须等**（直接调的话它早就跑了）
    expect(sampler.sampleGroup).not.toHaveBeenCalled();

    release();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(sampler.sampleGroup).toHaveBeenCalled();
  });
});

describe('PollScheduler · 跳过本周期，不补发', () => {
  it('队列被占住时，每个错过的周期**各记一次跳过**，且**不补发**', async () => {
    const clock = new FakeClock();
    const sampler = { sampleGroup: vi.fn(async () => {}) };
    const queue = new RoundTripQueue();

    // 先占住队列：一条永远不回来的动作
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    void queue.run('action-verify', () => blocked);

    const scheduler = new PollScheduler(PACK, sampler, queue, {
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    scheduler.start();

    clock.advanceTo(1000); // 第 1 个周期：采样入队
    clock.advanceTo(2000); // 第 2 个周期：错过
    clock.advanceTo(3000); // 第 3 个周期：错过

    // **不堆积**：队列里最多只有一次采样
    expect(queue.pending).toBe(1);
    expect(scheduler.skipped).toBeGreaterThanOrEqual(2);

    // 放行那个动作 → 排队的采样拿到执行权
    release();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // 采样**没有**被补发（它已经错过了自己的周期）
    expect(sampler.sampleGroup).not.toHaveBeenCalled();
  });

  it('错过周期之后，**下一个周期照常采**', async () => {
    const clock = new FakeClock();
    const sampler = { sampleGroup: vi.fn(async () => {}) };
    const queue = new RoundTripQueue();

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    void queue.run('action-verify', () => blocked);

    const scheduler = new PollScheduler(PACK, sampler, queue, {
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    scheduler.start();

    clock.advanceTo(1000);
    clock.advanceTo(2000);
    release();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // 下一个周期：恢复采样
    clock.advanceTo(4000);
    await Promise.resolve();
    await Promise.resolve();
    expect(sampler.sampleGroup).toHaveBeenCalled();
  });
});
