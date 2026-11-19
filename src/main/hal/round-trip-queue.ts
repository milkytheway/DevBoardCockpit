import { makeError } from '../../shared/errors';

/**
 * The queue of round trips (contract `docs/spec/02-board-pack.md` §1.2.1 ·
 * ADR-D23 of the implementation-layer decision record).
 *
 * ── What it solves ──
 *
 * Contract §1.2.1: "**only one round trip at a time on the same
 * connection.** The sampling round trips of a poll group and the action
 * round trips share the same channel, so they must be serialised."
 *
 * On serial this is a hard constraint: the command channel and the
 * interactive terminal **share one wire** (Fact S1), there is only **one
 * reader thread and one transcript**, and commands claim their own replies
 * by marker. With two concurrent round trips the replies of the two markers
 * interleave in the same transcript — the symptom the contract names is:
 * "**clicked a button and the numbers of the monitoring card jump around**".
 *
 * ── Four priority levels (ADR-D23) ──
 *
 * | Level | Who |
 * |---|---|
 * | `action-verify` | **the execution and the readback of an action** (one indivisible exclusive transaction) |
 * | `manual-refresh` | a refresh triggered by the user |
 * | `card-sampling` | the periodic sampling of a card |
 * | `diagnostics` | probes and diagnostics |
 *
 * ── Queueing must not be unbounded (ADR-D23) ──
 *
 * "Every transaction carries a deadline (3 seconds by default at the
 * connection level); a queue timeout reports `conn_busy`, and the queue has
 * an upper bound."
 *
 * **Why there has to be an upper bound**: unbounded queueing turns "stuck"
 * into "stale data", and that is the hardest class of failure to diagnose —
 * **slow is not wrong, silently slow is**.
 */
export type RoundTripKind = 'action-verify' | 'manual-refresh' | 'card-sampling' | 'diagnostics';

/** The priorities (from high to low) */
const PRIORITY: readonly RoundTripKind[] = [
  'action-verify',
  'manual-refresh',
  'card-sampling',
  'diagnostics',
];

/** The options of a transaction */
export interface RoundTripOptions {
  /**
   * The deadline of this transaction (milliseconds, **counted from the moment
   * it was enqueued**).
   *
   * Queueing beyond it → report `conn_busy`, and **this transaction is
   * dropped** (it is not executed).
   */
  deadlineMs?: number;
}

/** The options of the queue itself */
export interface RoundTripQueueOptions {
  /** Now (milliseconds) — a fake clock injected by tests */
  now?: () => number;
  /** The upper bound of the queue (how many may be queued at the same time) */
  maxPending?: number;
  /** The default deadline (milliseconds) — ADR-D23 "3 seconds by default at the connection level" */
  deadlineMs?: number;
}

/** The kind of a round trip */
interface Entry {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  /** The moment it was enqueued (used to compute the deadline) */
  enqueuedAt: number;
  /** The deadline of this entry itself */
  deadlineMs: number;
}

const DEFAULT_MAX_PENDING = 32;
const DEFAULT_DEADLINE_MS = 3_000;

export class RoundTripQueue {
  /** One queue per level (from high to low) */
  private readonly queues: Record<RoundTripKind, Entry[]> = {
    'action-verify': [],
    'manual-refresh': [],
    'card-sampling': [],
    diagnostics: [],
  };
  /** The number of round trips currently in flight (**always 0 or 1**) */
  private inFlight = 0;
  /** Already draining (guards against re-entry) */
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
   * Queue one round trip.
   *
   * @param kind the priority level
   * @param fn the closure that does the actual work
   * @param opts the options of this transaction (the deadline may be
   *             overridden)
   */
  run<T>(kind: RoundTripKind, fn: () => Promise<T>, opts: RoundTripOptions = {}): Promise<T> {
    if (this.load >= this.maxPending) {
      // **Do not queue it**: reject it right away (`conn_busy`) — unbounded
      // queueing turns "stuck" into "stale data", and that is the hardest to
      // diagnose.
      return Promise.reject(
        makeError('CONN_BUSY', `the round trip queue is full (${this.maxPending} are queued), this one is not queued`, {
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

  /** The load of the queue (**in flight + waiting**) — the upper bound is computed from it */
  get load(): number {
    return this.inFlight + this.pending;
  }

  /** The number of entries in the queue that have not started executing yet */
  get pending(): number {
    return PRIORITY.reduce((sum, kind) => sum + this.queues[kind].length, 0);
  }

  /** Whether a round trip is currently in flight */
  get busy(): boolean {
    return this.inFlight > 0;
  }

  /** Start draining (if it is already draining, it does not come again) */
  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    void this.pump();
  }

  /**
   * Drain the queue.
   *
   * **A single chain** — no matter which queue an entry comes from, it is
   * drained from here. Two independent chains would each start running →
   * two concurrent round trips → crosstalk on serial.
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
          // One broken lock must not wreck the whole channel.
          entry.reject(err);
        } finally {
          this.inFlight -= 1;
        }
      }
    } finally {
      this.draining = false;
      // New entries may have arrived while draining (a run triggered by a resolve runs in a microtask)
      if (this.pending > 0) this.drain();
    }
  }

  /**
   * Take the next entry by priority.
   *
   * **The entry whose deadline has passed**: drop it and report `conn_busy`
   * (it is not executed) — an action that queued for half a minute may
   * already be outdated when it runs.
   */
  private take(): Entry | undefined {
    for (const kind of PRIORITY) {
      const queue = this.queues[kind];
      while (queue.length > 0) {
        const entry = queue.shift() as Entry;
        const waited = this.now() - entry.enqueuedAt;
        if (waited > entry.deadlineMs) {
          entry.reject(
            makeError('CONN_BUSY', `queued for ${waited}ms, over the deadline (${entry.deadlineMs}ms), not executed this time`, {
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
