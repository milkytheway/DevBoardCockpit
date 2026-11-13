import { quotePath } from '../../util/shell-quote';
import { argStr } from './util';
import type { ReaderKind } from './types';

/**
 * `meminfo` —— 内存总量、已用、占用率。
 *
 * 单次采样即可（契约 §2.4）。
 *
 * **单位换算是 reader 的责任**（`docs/06` C6）：`/proc/meminfo` 给的是 kB，
 * 契约只认 **byte**——所以这个 kind 必须 ×1024。
 */

export const MEMINFO: ReaderKind = {
  id: 'meminfo',
  params: {
    path: { type: 'string', required: true },
  },
  samples: ['total_bytes', 'used_bytes', 'usage'],
  fetch(args) {
    return `cat -- ${quotePath(argStr(args, 'path'))}`;
  },
};
