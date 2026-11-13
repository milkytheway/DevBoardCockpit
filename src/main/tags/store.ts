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

export class TagStore {
  private readonly readings = new Map<string, TagReading>();
  /** 每个 tag 最后一次「好值」——`stale` / `error` 靠它保留旧值 */
  private readonly lastGood = new Map<string, number | string | boolean>();
  private readonly listeners: ReadingListener[] = [];

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
    for (const listener of this.listeners) listener(reading);
    return reading;
  }

  /** 取一个 tag 的最新读数 */
  get(tag: string): TagReading | undefined {
    return this.readings.get(tag);
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
