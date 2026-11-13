import { quotePath } from '../../util/shell-quote';
import { argStr } from './util';
import type { ReaderKind } from './types';

/**
 * `proc_stat` —— CPU 占用率与核名。
 *
 * **需要两次采样**：占用率是两次采样做差（契约 §2.4）。
 * 首读的结果是 `pending`——**不是 0**（规则 5）。
 *
 * 取两个文件：`/proc/stat` 给计数器，`/proc/cpuinfo` 给核名与簇。
 * 中间用一个**分隔行**隔开——它是这段输出里唯一的一行非计数器内容。
 */

/** 两段之间的分隔行。`/proc/stat` 的行都以 `cpu` 开头，不会撞上它 */
export const CPUINFO_SEPARATOR = '--- cpuinfo ---';

export const PROC_STAT: ReaderKind = {
  id: 'proc_stat',
  params: {
    stat_path: { type: 'string', required: true },
    cpuinfo_path: { type: 'string', required: true },
  },
  samples: ['usage', 'core.*.usage', 'core.*.cluster'],
  needsTwoSamples: true,
  fetch(args) {
    const stat = quotePath(argStr(args, 'stat_path'));
    const cpuinfo = quotePath(argStr(args, 'cpuinfo_path'));
    return `cat -- ${stat}; echo ${quotePath(CPUINFO_SEPARATOR)}; cat -- ${cpuinfo}`;
  },
};
