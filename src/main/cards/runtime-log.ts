/**
 * 卡片的运行时日志。
 *
 * ── 谁写 ──
 *
 * | 来源 | 谁写的 | 内容 |
 * |---|---|---|
 * | `card` | 卡片自己（`cockpit.log`） | 它自己的话 |
 * | `host` | 宿主（卡片崩了、握手失败…） | 宿主知道的事 |
 * | `csp` | 宿主（抓到 CSP 违规） | **「这张卡试图联网」**（契约 §6.1 的承诺） |
 *
 * ── 为什么按**卡片 id** 存 ──
 *
 * 契约的 `get_card_runtime_log(cardId)` 按卡片 id 取。
 * 但 **CSP 违规带来的是实例 id**（`cockpit://card/<实例 id>/…`）——
 * 所以要有一张「实例 → 卡片」的对应表（`bind`）。
 *
 * ── 归属不出来的怎么办 ──
 *
 * **不落进任何卡**。挂错卡的日志比没有日志更糟：
 * 它会让 agent 去查一张**没做错事**的卡。
 */
export type CardLogSource = 'card' | 'host' | 'csp';

export interface CardLogEntry {
  at: number;
  source: CardLogSource;
  level: 'error' | 'warn' | 'info';
  message: string;
}

/** 每张卡最多留多少条（防日志把内存吃满） */
export const DEFAULT_LIMIT_PER_CARD = 200;

export class CardRuntimeLog {
  private readonly entries = new Map<string, CardLogEntry[]>();
  /** 实例 id → 卡片 id */
  private readonly instances = new Map<string, string>();

  constructor(private readonly deps: { limitPerCard?: number; now?: () => number } = {}) {}

  /** 登记一个实例属于哪张卡 */
  bind(instanceId: string, cardId: string): void {
    this.instances.set(instanceId, cardId);
  }

  /** 追加一条 */
  append(cardId: string, entry: Omit<CardLogEntry, 'at'> & { at?: number }): void {
    const list = this.entries.get(cardId) ?? [];
    const at = entry.at ?? this.deps.now?.() ?? Date.now();
    list.push({ at, source: entry.source, level: entry.level, message: entry.message });
    const limit = this.deps.limitPerCard ?? DEFAULT_LIMIT_PER_CARD;
    // 超了丢**最旧的**
    while (list.length > limit) list.shift();
    this.entries.set(cardId, list);
  }

  /** 读一张卡的日志（按时间顺序） */
  read(cardId: string): CardLogEntry[] {
    return [...(this.entries.get(cardId) ?? [])];
  }

  /**
   * 把一条 CSP 违规归到它该去的卡。
   *
   * @param details `console-message` 给的东西：`message` + `sourceUrl`
   * @returns 归到了哪张卡（**归不出来就是 null**）
   */
  attributeCspViolation(details: { message: string; sourceUrl: string }): string | null {
    const instanceId = instanceIdOf(details.sourceUrl);
    if (instanceId === null) return null;
    const cardId = this.instances.get(instanceId);
    if (cardId === undefined) return null;
    this.append(cardId, {
      source: 'csp',
      level: 'error',
      message: details.message,
    });
    return cardId;
  }
}

/** 从 `cockpit://card/<实例 id>/…` 里取出实例 id */
function instanceIdOf(sourceUrl: string): string | null {
  const match = /^cockpit:\/\/card\/([^/]+)\//.exec(sourceUrl);
  return match?.[1] ?? null;
}
