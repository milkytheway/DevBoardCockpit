import type { BoardPack } from './schema';
import type { RoundTripQueue } from '../hal/round-trip-queue';

/**
 * The poll scheduler (contract `docs/spec/02-board-pack.md` section 1.2).
 *
 * ── What it does ──
 *
 * Every poll group is sampled once per its own `interval_ms`, always through
 * the round-trip queue (contract section 1.2.1) — the scheduler never calls
 * `exec` itself.
 *
 * ── "Skip this period, do not make it up" ──
 *
 * Contract section 1.2.1: "if the sampling of a poll group misses its
 * period because it gave way, skip the period and do not make it up. Making
 * it up would render the difference window of `/proc/stat` meaningless."
 *
 * How "it missed" is decided:
 *
 * | Quantity | Meaning |
 * |---|---|
 * | waiting time = the moment the execution right is obtained − the moment it was queued | without the execution time of this sampling itself |
 * | The criterion | waiting time > period + grace → this round is skipped (not sampled) |
 *
 * Why the waiting time and not the total time: the round trip of one
 * sampling may be longer than the period by itself (especially slow over a
 * serial line), and that is not caused by giving way, so it must not cause
 * a skip — a slow board is not a missed period. Only the time spent
 * waiting in the queue is giving way.
 *
 * The grace is half the period: a wait of less than one and a half periods
 * still samples — that value is still a real measurement (the difference
 * window is its own window).
 */

export interface SchedulerOptions {
  /** The current moment (milliseconds). The tests inject a fake clock */
  now?: () => number;
  /** Install a timer. The tests inject a fake clock */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Remove a timer */
  clearTimer?: (handle: unknown) => void;
}

/**
 * The scheduler only needs one thing: "being able to sample one group".
 *
 * Written as a structural type and not as `TagSampler`: that way a test can
 * put a fake in, and `TagSampler` (which has private fields) satisfies it
 * as well.
 */
export interface GroupSampler {
  sampleGroup(groupId: string): Promise<void>;
}

interface GroupState {
  id: string;
  intervalMs: number;
  /** Already queued or in flight (against piling up) */
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

  /** Start scheduling */
  start(): void {
    if (this.running) return;
    this.running = true;
    for (const group of this.groups.values()) this.arm(group);
  }

  /** Stop: clear every timer */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const group of this.groups.values()) {
      this.clearTimer(group.handle);
      group.handle = undefined;
    }
  }

  /** The number of sampling periods skipped because of giving way (for the criteria) */
  get skipped(): number {
    return this.skippedCount;
  }

  /** The number of times each group was actually sampled (for the criteria) */
  get ran(): Map<string, number> {
    return new Map(this.ranCounts);
  }

  /** Arm the next timer for a group */
  private arm(group: GroupState): void {
    if (!this.running) return;
    group.handle = this.setTimer(() => {
      this.onTick(group);
      this.arm(group);
    }, group.intervalMs);
  }

  /** The timer fired */
  private onTick(group: GroupState): void {
    if (!this.running) return;

    if (group.queued) {
      // The previous one has not come back yet → this period is missed
      // (skip it, do not make it up).
      // Nothing is added to the queue — making it up would let the queue
      // grow without bound.
      this.skippedCount += 1;
      return;
    }

    group.queued = true;
    const enqueuedAt = this.now();

    void this.queue
      .run('card-sampling', async () => {
        try {
          // How long did it wait in the queue? (without the execution time of this sampling itself)
          const waited = this.now() - enqueuedAt;
          const slack = Math.floor(group.intervalMs / 2);
          if (waited > group.intervalMs + slack) {
            // This round missed its own period → skip it, do not make it up
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
        // A failed sampling must not blow up the scheduler — the next period goes as usual.

        group.queued = false;
      });
  }
}
