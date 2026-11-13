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
  // ⚠️ 契约 §2.4 的表里写的是 `total_bytes, used_bytes, usage`——
  // **漏了 `available_bytes`**。但核心词表里有 `mem.available_bytes`，
  // 板型包也真的用它（实测 `MemAvailable`）——所以这个 kind 必须产出它。
  // 差异记在 `docs/06` C10，由用户拍板是否回写契约表。
  samples: ['total_bytes', 'available_bytes', 'used_bytes', 'usage'],
  fetch(args) {
    return `cat -- ${quotePath(argStr(args, 'path'))}`;
  },
};
