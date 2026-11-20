import { describe, it, expect, vi } from 'vitest';
import { PollScheduler } from '../../src/main/tags/scheduler';
import { RoundTripQueue } from '../../src/main/hal/round-trip-queue';
import type { BoardPack } from '../../src/main/tags/schema';

/**
 * The polling scheduler (contract `docs/spec/02-board-pack.md` §1.2).
 *
 * The two things the contract asks for:
 *
 * | Contract | Here |
 * |---|---|
 * | a poll group samples with its own `interval_ms` | one timer per group |
 * | a sample that **missed its period because it gave way → the period is skipped, it is not made up** | while it waits in the queue, the period counts as missed as soon as it arrives |
 *
 * Why "it is not made up" matters so much:
 *
 * Contract §1.2.1: "making it up would render the difference window of
 * `/proc/stat` meaningless" — how much time passed between the two samples
 * decides which span of time that percentage talks about. Making one up means
 * **taking a difference from three seconds ago as a reading of one second**,
 * and **it looks like a number but it is wrong**.
 */

/** A fake clock that can be advanced by hand */
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

  /** Advances to the target and fires the timers that come due on the way */
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
  name: 'minimal pack',
  version: '1.0.0',
  requires: { transports: ['adb'], capabilities: ['exec'] },
  poll_groups: [{ id: 'fast', interval_ms: 1000, readers: ['cpu'] }],
  readers: [],
  custom: [],
  actions: [],
};

describe('PollScheduler · it is driven by the interval_ms', () => {
  it('after start() one period passes, the group is sampled once', async () => {
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
    // `ran` is recorded after the await → let the microtask run first
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduler.ran.get('fast')).toBe(1);
  });

  it('after stop() there is no more sampling', () => {
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

  it('**it never calls sampleGroup directly** — everything goes through the queue (P3)', async () => {
    const clock = new FakeClock();
    const sampler = { sampleGroup: vi.fn(async () => {}) };
    const queue = new RoundTripQueue();

    // **The queue is occupied first**: an action that never comes back
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

    // The queue is occupied → **the sample has to wait** (called directly it would
// have run long ago)
    expect(sampler.sampleGroup).not.toHaveBeenCalled();

    release();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(sampler.sampleGroup).toHaveBeenCalled();
  });
});

describe('PollScheduler · it skips the period and does not make it up', () => {
  it('while the queue is occupied, every missed period **records one skip** and **is not made up**', async () => {
    const clock = new FakeClock();
    const sampler = { sampleGroup: vi.fn(async () => {}) };
    const queue = new RoundTripQueue();

    // The queue is occupied first: an action that never comes back
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

    clock.advanceTo(1000); // Period 1: the sample is queued
    clock.advanceTo(2000); // Period 2: missed
    clock.advanceTo(3000); // Period 3: missed

    // **It does not pile up**: the queue holds at most one sample
    expect(queue.pending).toBe(1);
    expect(scheduler.skipped).toBeGreaterThanOrEqual(2);

    // The action is let through → the queued sample gets the turn
    release();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The sample was **not** made up (it has already missed its period)
    expect(sampler.sampleGroup).not.toHaveBeenCalled();
  });

  it('after a missed period, **the next period samples as usual**', async () => {
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

    // The next period: the sampling resumes
    clock.advanceTo(4000);
    await Promise.resolve();
    await Promise.resolve();
    expect(sampler.sampleGroup).toHaveBeenCalled();
  });
});
