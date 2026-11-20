import type { ReasonCode, TagReading, TagStatus } from '../../shared/tag-reading';

/**
 * TagStore — the single place where the readings meet (ADR-D22).
 *
 * The product floor of the "cockpit" is that the UI shows the real state of
 * the board. A state with several copies is no truth at all — so whatever
 * the data comes from, polling today or a push later, it is distributed
 * only after it has entered the TagStore.
 *
 * ── The three things it does ──
 *
 * 1. It moves the state according to the table of contract section 2.1
 *    (that table is stateful, it must not be written one way here and
 *    another way there);
 * 2. It gives every reading a seq (monotonic inside one tag) and drops the
 *    old values that arrive out of order;
 * 3. It freezes the value — what is read out is what it is, nobody can
 *    change it.
 *
 * ── When the value is kept ──
 *
 * Contract section 2.1.1:
 *
 * > `stale` keeps the old value, `unavailable` does not (the value is
 * > `null`). The behaviour of `error` has two cases…… from `ok`/`stale` into
 * > `error` → the old value is kept; from `pending` into `error` (it
 * > never succeeded) → there is no old value, the value is `null`.
 *
 * So the criterion is "has this tag ever succeeded": if it has, both
 * `stale` and `error` keep that value; if it has not, both are null.
 */

/** What is written into the store. The seq is assigned by the store */
export interface TagReadingInput {
  tag: string;
  value: number | string | boolean | null;
  unit: string;
  status: TagStatus;
  reason?: ReasonCode;
  detail?: string;
  /** The moment this sampling finished (milliseconds UTC) */
  at: number;
  /** Only used to tell old from new on an out-of-order write; the normal flow does not pass it */
  seq?: number;
}

/** The callback of a change of a reading */
export type ReadingListener = (reading: TagReading) => void;

/**
 * One sample (contract `spec/04` section 2.1 ✓).
 *
 * → The shape is exactly the same as that of `sample_tag` /
 *   `describe_tag.history` ✓.
 */
export interface TagSample {
  value: number | string | boolean | null;
  unit: string;
  status: TagStatus;
  /** The moment this sampling finished (milliseconds UTC) */
  at: number;
}

/**
 * The default capacity of the sample buffer (one per tag).
 *
 * → This is an implementation detail — the contract only says "at most n,
 *   no padding" → it is not fixed.
 * → Why 64: it spans many periods of the fast groups (1 s) and of the slow
 *   groups (30 s) — an agent that judges "the jitter" needs several
 *   points, and one that judges "what the refresh period really is" needs
 *   the samples across two periods.
 */
export const DEFAULT_HISTORY_LIMIT = 64;

export class TagStore {
  private readonly readings = new Map<string, TagReading>();
  /** The last "good value" of each tag — `stale` / `error` keep the old value through it */
  private readonly lastGood = new Map<string, number | string | boolean>();
  private readonly listeners: ReadingListener[] = [];
  /**
   * The ring buffer of the samples (one per tag).
   *
   * → Why it is there: the TagStore keeps only the latest reading per
   *   tag — and the MCP tools `sample_tag(name, n)` and
   *   `describe_tag.history` want the most recent n samples.
   * → It is a ring: when it is full the oldest one is dropped (the
   *   memory stays bounded).
   *
   * → The field is not called `history` — that would have the same name as
   *   the `history()` method (in JS a class field and a method with the
   *   same name overwrite each other).
   */
  private readonly samples = new Map<string, TagSample[]>();
  /** How many samples are kept per tag */
  private readonly historyLimit: number;

  constructor(opts: { historyLimit?: number } = {}) {
    this.historyLimit = opts.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  }

  /** The number of readings right now */
  get size(): number {
    return this.readings.size;
  }

  /**
   * Write one reading.
   *
   * @returns the reading that was stored (frozen). On an out-of-order write
   *   it returns the previous one — the old value was dropped.
   */
  put(input: TagReadingInput): TagReading {
    const prev = this.readings.get(input.tag);

    // An old value that arrives out of order: it is dropped outright
    // (ADR-D22: "the renderer drops the old values that arrive out of
    // order by seq" — the drop happens in the store, the renderer only ever
    // gets the latest one)
    if (input.seq !== undefined && prev !== undefined && input.seq <= prev.seq) {
      return prev;
    }

    const seq = prev === undefined ? 1 : prev.seq + 1;

    // How the value is obtained (contract section 2.1)
    let value: number | string | boolean | null = input.value;
    if (input.status === 'stale' || input.status === 'error') {
      const good = this.lastGood.get(input.tag);
      value = good === undefined ? null : good;
    } else if (input.status === 'unavailable' || input.status === 'pending') {
      // `unavailable` does not keep a value (the contract says so); `pending` means "not computed yet", so it has no value either
      value = null;
    }

    if (input.status === 'ok' && input.value !== null) {
      // The contract: an `ok` carries a value. Should somebody write an
      // `ok` with a null value, the old good value may not be replaced
      // by it — "keep the last value that works" is more useful than
      // "record that there is none".
      this.lastGood.set(input.tag, input.value);
    }

    const reading: TagReading = Object.freeze({
      tag: input.tag,
      value,
      unit: input.unit,
      status: input.status,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      at: input.at,
      seq,
    });

    this.readings.set(input.tag, reading);
    this.appendHistory(reading);
    for (const listener of this.listeners) listener(reading);
    return reading;
  }

  /**
   * Record this reading in the sample buffer.
   *
   * → Only the one that was really stored (an out-of-order old value was
   *   already dropped above → it does not enter the history).
   * → It is a ring: when it is full the oldest one is dropped.
   */
  private appendHistory(reading: TagReading): void {
    const samples = this.samples.get(reading.tag) ?? [];
    samples.push({
      value: reading.value,
      unit: reading.unit,
      status: reading.status,
      at: reading.at,
    });
    while (samples.length > this.historyLimit) samples.shift();
    this.samples.set(reading.tag, samples);
  }

  /**
   * The most recent n samples (oldest → newest).
   *
   * → Fewer than n gives as many as there are (no padding — a sample that
   *   was never sampled cannot be made up).
   * → A tag that was never read → an empty array (not `null`).
   */
  history(tag: string, n: number): TagSample[] {
    const samples = this.samples.get(tag);
    if (samples === undefined || n <= 0) return [];
    return samples.slice(-n);
  }

  /** The latest reading of one tag */
  get(tag: string): TagReading | undefined {
    return this.readings.get(tag);
  }

  /**
   * Which status to use when a refresh fails (the transition table of
   * contract section 2.1).
   *
   * - "ok → stale = this refresh failed, but the last value is kept"
   * - "error → stale = it keeps failing and there was a usable value
   *   before — keep it and mark it as out of date"
   * - "pending → error = the sampling itself failed (the command returned
   *   non-zero, it timed out, the transport broke)"
   *
   * So the criterion is "has this tag ever succeeded": if it has,
   * stale (the old value is kept, marked as out of date); if it has not,
   * error (there is no old value).
   */
  failureStatusFor(tag: string): 'stale' | 'error' {
    return this.lastGood.has(tag) ? 'stale' : 'error';
  }

  /** Every reading */
  all(): TagReading[] {
    return [...this.readings.values()];
  }

  /**
   * Subscribe to the changes of the readings.
   *
   * The distribution happens here (ADR-D22: distribute only after
   * entering the TagStore) — the cards, the UI and the MCP all get it from
   * here, none of them builds a state of its own.
   *
   * @returns the unsubscribe function.
   */

  subscribe(listener: ReadingListener): () => void {
    this.listeners.push(listener);
    return () => {
      const at = this.listeners.indexOf(listener);
      if (at >= 0) this.listeners.splice(at, 1);
    };
  }
}
