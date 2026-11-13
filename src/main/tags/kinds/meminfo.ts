import { quotePath } from '../../util/shell-quote';
import { argStr } from './util';
import { ok, unavailable } from './parse-util';
import type { ReaderKind } from './types';

/**
 * `meminfo` —— 内存总量、可用、已用、占用率。
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
  parse(raw, _args, _ctx) {
    let totalKb = 0;
    let availableKb = 0;

    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('MemTotal:')) {
        totalKb = Number.parseInt(line.split(/\s+/)[1] ?? '', 10);
      } else if (line.startsWith('MemAvailable:')) {
        availableKb = Number.parseInt(line.split(/\s+/)[1] ?? '', 10);
      }
    }

    if (!Number.isFinite(totalKb) || totalKb <= 0) {
      return unavailable('parse_error', '/proc/meminfo 里没有可用的 MemTotal');
    }
    if (!Number.isFinite(availableKb) || availableKb < 0) availableKb = 0;

    // kB → byte（×1024）
    const total = totalKb * 1024;
    const available = availableKb * 1024;
    const used = total - available;

    return ok({
      total_bytes: total,
      available_bytes: available,
      used_bytes: used,
      usage: (used / total) * 100,
    });
  },
};
