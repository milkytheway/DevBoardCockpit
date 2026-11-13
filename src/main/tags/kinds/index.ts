import { PROC_STAT } from './proc-stat';
import { MEMINFO } from './meminfo';
import { DEVFREQ_LOAD } from './devfreq-load';
import { RKNPU_LOAD } from './rknpu-load';
import { THERMAL_ZONE } from './thermal-zone';
import { FILE_READ } from './file-read';
import { EXEC_REGEX } from './exec-regex';
import { SCRIPT } from './script';
import type { ReaderKind } from './types';

/**
 * reader kind 注册表。
 *
 * 契约：`docs/spec/02-board-pack.md` §2.4——**这份表是契约的一部分**，
 * 它的机器可读形态由实现层提供。
 *
 * **清单封闭**：v1 就这 8 个（§2.4 的表）。
 * 加一个 kind = 一次契约变更（要评审），不是「顺手加一个」。
 *
 * 规则 6（sample 存在吗）、8（参数名拼错了吗）、9（必填参数缺了吗）
 * 都要查这张表——**所以它必须先于校验器存在**。
 */

export type { ReaderKind, ParamSpec } from './types';

/** 全部 kind（顺序 = 契约 §2.4 的表顺序） */
export const READER_KINDS: readonly ReaderKind[] = [
  PROC_STAT,
  MEMINFO,
  DEVFREQ_LOAD,
  RKNPU_LOAD,
  THERMAL_ZONE,
  FILE_READ,
  EXEC_REGEX,
  SCRIPT,
];

const BY_ID = new Map<string, ReaderKind>(READER_KINDS.map((k) => [k.id, k]));

/** 全部 kind 的 id（契约 §2.4 的顺序） */
export function kindIds(): string[] {
  return READER_KINDS.map((k) => k.id);
}

/**
 * 按 id 取一个 kind。
 *
 * **取不到返回 undefined，不抛异常**——
 * 「这个 kind 不存在」是**校验器**要报的事（规则 6/8），
 * 运行时不该在这里崩。
 */
export function getKind(id: string): ReaderKind | undefined {
  return BY_ID.get(id);
}
