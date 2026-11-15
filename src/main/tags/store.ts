import type { ReasonCode, TagReading, TagStatus } from '../../shared/tag-reading';

/**
 * TagStore —— 读数的**唯一汇点**（ADR-D22）。
 *
 * 「驾驶舱」的产品底线是「UI 显示板子的真实状态」。
 * **一份状态有多个副本，就等于没有真相**——
 * 所以不管数据来自轮询还是将来的推送，**进 TagStore 之后再分发**。
 *
 * ── 它做三件事 ──
 *
 * 1. **按契约 §2.1 的表迁移状态**（那张表是**有状态的**，不许各写各的）；
 * 2. **给每个读数发 seq**（同一 tag 内单调递增），并**丢掉乱序的旧值**；
 * 3. **把值冻住**——读出去的就是它，不会被人改了。
 *
 * ── 值什么时候保留 ──
 *
 * 契约 §2.1.1：
 *
 * > **`stale` 保留旧值**，`unavailable` 不保留（值为 `null`）。
 * > `error` 的行为分两种……从 `ok`/`stale` 进入 `error` → **保留旧值**；
 * > 从 `pending` 进入 `error`（**从没成功过**）→ 没有旧值，值为 `null`。
 *
 * 所以判据是「**这个 tag 有没有成功过一次**」：
 * 成功过 → `stale` 与 `error` 都保留那个值；没成功过 → 两者都是 null。
 */

/** 写进 store 的东西。**seq 由 store 分配** */
export interface TagReadingInput {
  tag: string;
  value: number | string | boolean | null;
  unit: string;
  status: TagStatus;
  reason?: ReasonCode;
  detail?: string;
  /** 本次采样的完成时刻（毫秒 UTC） */
  at: number;
  /** 只在「乱序写入」时用来判断新旧；正常流程不传 */
  seq?: number;
}

/** 读数变化时的回调 */
export type ReadingListener = (reading: TagReading) => void;

/**
 * **一个样本**（契约 `spec/04` §2.1 ✓）。
 *
 * → 形状与 `sample_tag` / `describe_tag.history` **完全一致** ✓。
 */
export interface TagSample {
  value: number | string | boolean | null;
  unit: string;
  status: TagStatus;
  /** 本次采样的完成时刻（毫秒 UTC） */
  at: number;
}

/**
 * **样本缓冲的默认容量**（**每个 tag** 各一份 ✓）。
 *
 * → **这是实现细节** ✓ —— 契约只说「最多 n 个，不足不补」✓ → **不锁死** ✓。
 * → **为什么 64**：够跨越很多个快组周期（1s ✓）与慢组周期（30s ✓）✓ ——
 *   agent 判断「抖动」要看**几个点** ✓，判断「刷新周期实际是多少」要看**跨越两个周期**的样本 ✓。
 */
export const DEFAULT_HISTORY_LIMIT = 64;

export class TagStore {
  private readonly readings = new Map<string, TagReading>();
  /** 每个 tag 最后一次「好值」——`stale` / `error` 靠它保留旧值 */
  private readonly lastGood = new Map<string, number | string | boolean>();
  private readonly listeners: ReadingListener[] = [];
  /**
   * **样本环形缓冲**（每个 tag 一份 ✓）。
   *
   * → **为什么要有** ✓：`TagStore` 每个 tag 只留**最新一条** ✓ ——
   *   而 MCP 的 `sample_tag(name, n)` 与 `describe_tag.history` 要**最近 n 个样本** ✓。
   * → **环形** ✓：满了丢最旧的 ✓（内存有界 ✓）。
   *
   * → **字段名不叫 `history`** ✓ —— 那会与 `history()` 方法同名 ✓（JS 里类字段与方法同名会互相盖掉 ✓）。
   */
  private readonly samples = new Map<string, TagSample[]>();
  /** 每个 tag 保留多少个样本 */
  private readonly historyLimit: number;

  constructor(opts: { historyLimit?: number } = {}) {
    this.historyLimit = opts.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  }

  /** 当前的读数条数 */
  get size(): number {
    return this.readings.size;
  }

  /**
   * 写进一个读数。
   *
   * @returns 存下来的那个读数（**冻结的**）。
   *   乱序写入时返回的是**原来那个**——旧值被丢掉了。
   */
  put(input: TagReadingInput): TagReading {
    const prev = this.readings.get(input.tag);

    // 乱序的旧值：**直接丢掉**（ADR-D22：「渲染层按 seq 丢弃乱序的旧值」——
    // 丢弃发生在 store，渲染层只拿得到最新的那个）
    if (input.seq !== undefined && prev !== undefined && input.seq <= prev.seq) {
      return prev;
    }

    const seq = prev === undefined ? 1 : prev.seq + 1;

    // 值怎么来（契约 §2.1）
    let value: number | string | boolean | null = input.value;
    if (input.status === 'stale' || input.status === 'error') {
      const good = this.lastGood.get(input.tag);
      value = good === undefined ? null : good;
    } else if (input.status === 'unavailable' || input.status === 'pending') {
      // `unavailable` 不保留（契约明写）；`pending` 是「还没算出来」，也没有值
      value = null;
    }

    if (input.status === 'ok' && input.value !== null) {
      // 契约：`ok` 时**必带** value。万一有人写了个 null 的 ok，
      // 旧的好值**不能**被它顶掉——「保留上一个能用的值」比「记成没有」有用。
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
   * **把这个读数记进样本缓冲** ✓。
   *
   * → **只记真正存下来的那个** ✓（乱序的旧值在上面就被丢了 ✓ → 不进历史 ✓）。
   * → **环形** ✓：满了丢最旧的 ✓。
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
   * **最近 n 个样本**（**最旧 → 最新** ✓）。
   *
   * → **不足 n 个就有多少给多少** ✓（不补 ✓ —— 造不出没采过的样本 ✓）。
   * → **没读过的 tag → 空数组** ✓（不是 `null` ✓）。
   */
  history(tag: string, n: number): TagSample[] {
    const samples = this.samples.get(tag);
    if (samples === undefined || n <= 0) return [];
    return samples.slice(-n);
  }

  /** 取一个 tag 的最新读数 */
  get(tag: string): TagReading | undefined {
    return this.readings.get(tag);
  }

  /**
   * 一次**刷新失败**时该用什么状态（契约 §2.1 的迁移表）。
   *
   * - 「ok → stale = 本次刷新失败，但保留上一次的值」
   * - 「error → stale = 继续失败，且**之前有过一个可用的值**——保留它，标为已过时」
   * - 「pending → error = 采样过程本身失败（命令非零、超时、传输断了）」
   *
   * 所以判据是「**这个 tag 有没有成功过一次**」——
   * 有过 → stale（保留旧值，标为已过时）；没有 → error（没有旧值）。
   */
  failureStatusFor(tag: string): 'stale' | 'error' {
    return this.lastGood.has(tag) ? 'stale' : 'error';
  }

  /** 全部读数 */
  all(): TagReading[] {
    return [...this.readings.values()];
  }

  /**
   * 订阅读数变化。
   *
   * **分发在这里发生**（ADR-D22：进 TagStore 之后再分发）——
   * 卡片 / UI / MCP 都从这儿拿，不各自建一份状态。
   *
   * @returns 退订函数。
   */
  subscribe(listener: ReadingListener): () => void {
    this.listeners.push(listener);
    return () => {
      const at = this.listeners.indexOf(listener);
      if (at >= 0) this.listeners.splice(at, 1);
    };
  }
}
