/**
 * tag 读数的结构与状态。
 *
 * 契约：`docs/spec/01-tag-contract.md` §2.1（五态模型）、§2.1.1（读数的结构与 reason 码表）。
 *
 * **定义放在 shared**：main 产出读数、renderer 消费读数——
 * 两边都要用同一份定义，不许各抄一份（那正是「读数漂移」的来源）。
 */

/** 读数的五态（契约 §2.1） */
export type TagStatus = 'ok' | 'stale' | 'unavailable' | 'error' | 'pending';

/**
 * 读数不可用的原因码（契约 §2.1.1 的**封闭枚举**）。
 *
 * **不许自造码**（N3）：具体性由 `detail` 承担，
 * 不为每个路径变体新增一个码——那张表刻意保持最小。
 */
export type ReasonCode =
  | 'not_in_pack'
  | 'device_absent'
  | 'service_down'
  | 'link_busy_terminal'
  | 'parse_error'
  | 'out_of_domain'
  | 'timeout';

/** reason 码的全集（校验与测试用） */
export const REASON_CODES: readonly ReasonCode[] = [
  'not_in_pack',
  'device_absent',
  'service_down',
  'link_busy_terminal',
  'parse_error',
  'out_of_domain',
  'timeout',
];

/** 一个 tag 读数（契约 §2.1.1） */
export interface TagReading {
  tag: string;
  /** `unavailable` 时**没有** value；`ok` 时**必带** value */
  value: number | string | boolean | null;
  unit: string;
  status: TagStatus;
  /** 机器可读的封闭枚举 */
  reason?: ReasonCode;
  /** 给人看的自由文本。可含修复提示 */
  detail?: string;
  /** 本次采样的完成时刻（毫秒 UTC） */
  at: number;
  /** 同一 tag 内**单调递增**的序号 */
  seq: number;
}
