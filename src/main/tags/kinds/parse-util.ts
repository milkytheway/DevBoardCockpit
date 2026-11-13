import type { ReasonCode } from '../../../shared/tag-reading';

/**
 * kind 们共用的解析辅助。
 *
 * **为什么这些辅助存在**：8 个 kind 的解析器要处理同一批边界情况
 * （空输入、格式不对、计数器倒退）——
 * **每个 kind 各写一遍，8 份就一定有 7 份写得不一样**。
 */

/**
 * **资源此刻不在**（路径不存在、设备被拔、挂载丢失）——契约 §2.1.1。
 *
 * 与 `error()` 的分界：「资源**不在**」vs「资源**在但读不出来**」。
 * 这条分界直接影响卡片：`unavailable` 应当引导用户去挂载 debugfs，
 * 而不是报「NPU 读取失败」。
 */
export function unavailable(reason: ReasonCode, detail: string): ParseResult {
  return { status: 'unavailable', reason, detail };
}

/**
 * **读到了，但读出来的东西坏了**（解析失败、越界、类型不符）——契约 §2.1.1。
 *
 * 契约点名：**取值越界算 `error`，不许夹到合法区间当 `ok`**（那是撒谎）。
 */
export function error(
  reason: Extract<ReasonCode, 'parse_error' | 'out_of_domain'>,
  detail: string,
): ParseResult {
  return { status: 'error', reason, detail };
}

/**
 * 输出是空的 → 资源不在。
 *
 * 取数片段是 `cat -- <path>`：文件不存在时 stdout **一个字都没有**
 * （错误在 stderr，被 `2>/dev/null` 吞掉）。
 * 所以「空」在实践中就是「路径不存在」。
 */
export function missing(detail: string): ParseResult {
  return { status: 'unavailable', reason: 'device_absent', detail };
}

/** 输出是不是空的 */
export function isBlank(text: string): boolean {
  return text.trim().length === 0;
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

/**
 * 百分比**越不越界**（不是夹到区间里）。
 *
 * 契约 §2.1.1 原话：「实现层遇到越界值必须报 `error`，
 * **不得**把它夹到合法区间当作 `ok`（那是在撒谎），
 * 也**不得**当 `0`（那是更糟的撒谎）。」
 */
export function outOfRange(value: number): boolean {
  return !Number.isFinite(value) || value < 0 || value > 100;
}

/** 解析结果的类型（放这里是因为 kind 与辅助互相引用） */
export type ParseResult =
  | { status: 'ok'; samples: Record<string, number | string | boolean> }
  | { status: 'pending' }
  | { status: 'unavailable'; reason: ReasonCode; detail: string }
  | { status: 'error'; reason: ReasonCode; detail: string };
