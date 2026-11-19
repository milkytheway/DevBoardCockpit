import { quotePath } from '../../util/shell-quote';
import { argStr } from './util';
import { error, isBlank, missing, ok } from './parse-util';
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
    if (isBlank(raw)) {
      return missing('/proc/meminfo cannot be read (is the path wrong?)');
    }
    let totalKb = 0;
    // **NaN 而不是 0**：0 是一个合法的取值（「一点都不可用」），
    // 用 0 当初值就分不清「没读到」与「真的是 0」。
    let availableKb = Number.NaN;

    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('MemTotal:')) {
        totalKb = Number.parseInt(line.split(/\s+/)[1] ?? '', 10);
      } else if (line.startsWith('MemAvailable:')) {
        availableKb = Number.parseInt(line.split(/\s+/)[1] ?? '', 10);
      }
    }

    if (!Number.isFinite(totalKb) || totalKb <= 0) {
      return error('parse_error', '/proc/meminfo has no usable MemTotal');
    }
    if (!Number.isFinite(availableKb) || availableKb < 0) {
      // **不许拿 0 顶上**（N2）：没有 MemAvailable 就不知道「可用」是多少，
      // 拿 0 顶上会让 usage 变成 100%——**板子其实闲着，面板说满载**。
      // 那是最坏的那种假数。
      return error(
        'parse_error',
        '/proc/meminfo has no MemAvailable (0 cannot stand in for it — that would turn the usage into 100%)',
      );
    }
    if (availableKb > totalKb) {
      return error(
        'out_of_domain',
        `MemAvailable (${availableKb} kB) is larger than MemTotal (${totalKb} kB)`,
      );
    }

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
