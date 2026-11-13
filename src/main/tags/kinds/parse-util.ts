import type { ReasonCode } from '../../../shared/tag-reading';

/**
 * kind 们共用的解析辅助。
 *
 * **为什么这些辅助存在**：8 个 kind 的解析器要处理同一批边界情况
 * （空输入、格式不对、计数器倒退）——
 * **每个 kind 各写一遍，8 份就一定有 7 份写得不一样**。
 */

/** 解析不出来（**不是 0**） */
export function unavailable(reason: ReasonCode, detail: string): ParseResult {
  return { status: 'unavailable', reason, detail };
}

/** 解析成功 */
export function ok(samples: Record<string, number | string | boolean>): ParseResult {
  return { status: 'ok', samples };
}

/**
 * 取开头的连续整数，遇到非数字就停。
 *
 * 前身工程的做法（`core/metrics.py` 的 `leading_ints`）：
 * `/proc/stat` 在有些内核上混着计数与具名字段，
 * 对整个尾巴盲 `int()` 会炸。
 */
export function leadingInts(tokens: string[]): number[] {
  const out: number[] = [];
  for (const token of tokens) {
    if (!/^\d+$/.test(token)) break;
    out.push(Number(token));
  }
  return out;
}

/** 百分比夹在 0..100（算出来的负数或 >100 都是假的） */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/** 解析结果的类型（放这里是因为 kind 与辅助互相引用） */
export type ParseResult =
  | { status: 'ok'; samples: Record<string, number | string | boolean> }
  | { status: 'pending' }
  | { status: 'unavailable'; reason: ReasonCode; detail: string };
