import { quotePath } from '../../util/shell-quote';
import { argStr } from './util';
import { error, isBlank, missing, ok } from './parse-util';
import type { ReaderKind } from './types';

/**
 * `meminfo` — total memory, available memory, used memory and the usage.
 *
 * One sample is enough (contract section 2.4).
 *
 * Unit conversion is the reader's responsibility ✓: `/proc/meminfo` reports
 * kB, the contract only knows byte — so this kind has to multiply by 1024.
 */

export const MEMINFO: ReaderKind = {
  id: 'meminfo',
  params: {
    path: { type: 'string', required: true },
  },
  // ⚠️ The table in contract section 2.4 reads `total_bytes, used_bytes,
  // usage` — it leaves out `available_bytes`. But the core vocabulary has
  // `mem.available_bytes` and the board packs really use it (measured
  // `MemAvailable`), so this kind has to produce it. The contract table
  // omits it; the user ruled that the reader produces it anyway.
  samples: ['total_bytes', 'available_bytes', 'used_bytes', 'usage'],
  fetch(args) {
    return `cat -- ${quotePath(argStr(args, 'path'))}`;
  },
  parse(raw, _args, _ctx) {
    if (isBlank(raw)) {
      return missing('/proc/meminfo cannot be read (is the path wrong?)');
    }
    let totalKb = 0;
    // NaN rather than 0: 0 is a legal value ("nothing is available"), so
    // starting from 0 would not distinguish "not read" from "really 0".
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
      // 0 may not stand in (N2): without MemAvailable there is no way to know
      // what "available" is, and a 0 in its place turns the usage into 100% —
      // the board is in fact idle while the panel reports it as saturated.
      // That is the worst kind of false number.
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
