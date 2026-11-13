import { argStr } from './util';
import type { ReaderKind } from './types';

/**
 * `exec_regex` —— 跑一条命令，正则取（逃生门 2，契约 §3.2）。
 *
 * **⚠️ 它在板子上执行任意命令。**
 * 校验器对它**报警告**（规则 19），运行时对它执行的动作**记审计**。
 *
 * 它的 `command` **原样**进取数片段——这是**故意的**：
 * 转义一条命令就等于把它改成了另一条命令。
 * 包要不要装、能执行什么命令，是**人的确认**（ADR-D20）那一条链的事。
 */

export const EXEC_REGEX: ReaderKind = {
  id: 'exec_regex',
  params: {
    command: { type: 'string', required: true },
    pattern: { type: 'string', required: true },
    format: {
      type: 'string',
      required: false,
      values: ['string', 'integer', 'number', 'float'],
    },
  },
  samples: ['value'],
  fetch(args) {
    return argStr(args, 'command');
  },
};
