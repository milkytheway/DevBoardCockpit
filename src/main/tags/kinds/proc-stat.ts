import { quotePath } from '../../util/shell-quote';
import { argStr } from './util';
import { error, isBlank, leadingInts, missing, ok, outOfRange } from './parse-util';
import type { ReaderKind } from './types';

/**
 * `proc_stat` — CPU utilisation and core names.
 *
 * Two samples are needed: the utilisation is the difference between two
 * samples (contract section 2.4). The first read yields `pending`, not 0
 * (rule 5).
 *
 * Two files are read: `/proc/stat` for the counters, `/proc/cpuinfo` for the
 * core names and the clusters. They are separated by a separator line, which
 * is the only line in this output that is not a counter.
 *
 * ── The formulas are carried over from the predecessor project
 *    (`_parse_proc_stat` in `core/metrics.py`) ──
 *
 * - busy = user + nice + system (the first three fields);
 * - total = the sum of all fields;
 * - utilisation = Δbusy / Δtotal × 100, clamped into 0..100.
 *
 * The reason for carrying them over: both formulas were paid for on real
 * hardware, and the comment on them says "idle must be excluded, otherwise
 * the board looks 100% busy forever".
 */

/** The separator between the two sections. The lines of `/proc/stat` start with `cpu`, so they never collide with it */
export const CPUINFO_SEPARATOR = '--- cpuinfo ---';

/** ARMv8 CPU part id → cluster name (the same table as in the predecessor project) */
const CORE_NAMES: Record<number, string> = {
  0xd05: 'A55',
  0xd0b: 'A76',
};

/** The summary line and the per-core lines of `/proc/stat` */
interface ProcStat {
  /** The jiffies of [busy, total] */
  total?: [number, number];
  /** Core number → [busy, total] */
  cores: Record<number, [number, number]>;
}

function parseProcStat(text: string): ProcStat {
  let total: [number, number] | undefined;
  const cores: Record<number, [number, number]> = {};

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;

    if (line.startsWith('cpu ')) {
      const nums = leadingInts(line.split(/\s+/).slice(1));
      if (nums.length >= 4) {
        total = [nums[0]! + nums[1]! + nums[2]!, nums.reduce((a, b) => a + b, 0)];
      }
    } else {
      // The first word has to be cut off before the test: the whole line
      // `cpu0 41283 0 …` is not `cpu\d+` (the golden vector of a real-device
      // sample caught this bug here).
      const parts = line.split(/\s+/);
      const tag = parts[0]!;
      if (!/^cpu\d+$/.test(tag)) continue;
      const index = Number(tag.slice(3));
      const nums = leadingInts(parts.slice(1));
      if (nums.length >= 4) {
        cores[index] = [nums[0]! + nums[1]! + nums[2]!, nums.reduce((a, b) => a + b, 0)];
      }
    }
  }
  return { total, cores };
}

/**
 * Read "core number → cluster name" from `/proc/cpuinfo`.
 *
 * An unknown name is reported verbatim as a string and is not an error
 * (the contract vocabulary: `cpu.core.*.cluster`) — the predecessor
 * project's fallback is `cpu<hex>`, and the same shape is used here.
 */
function parseCoreNames(text: string): Record<number, string> {
  const names: Record<number, string> = {};
  let index = -1;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith('processor')) {
      const m = /:\s*(\d+)/.exec(raw);
      index = m ? Number(m[1]) : -1;
    } else if (raw.startsWith('CPU part') && index >= 0) {
      const m = /0x([0-9a-fA-F]+)/.exec(raw);
      if (m) {
        const part = Number.parseInt(m[1]!, 16);
        names[index] = CORE_NAMES[part] ?? `cpu${m[1]}`;
      }
    }
  }
  return names;
}

/** The previous sample (kept in the ctx.state the runtime supplies, not hidden in a module variable) */
interface ProcStatSnapshot {
  total: [number, number];
  cores: Record<number, [number, number]>;
}

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
  /**
   * Parse `/proc/stat` (and `/proc/cpuinfo`).
   *
   * ── Known boundary: with an irregular sampling interval this percentage
   *    means nothing ──
   *
   * Contract section 1.2.1 says "with an irregular interval it means
   * nothing" — but only the runtime knows when the previous round was
   * sampled (the reader gets no timestamp), so the reader cannot decide how
   * long the window of this round was. All this kind can guarantee is that
   * the difference of the counters is right. A scheduler that skips a round,
   * a board that suspends — the reader cannot see those.
   * The scheduler owns that boundary.
   */
  parse(raw, _args, ctx) {
    if (isBlank(raw)) {
      return missing('/proc/stat cannot be read (is the path wrong?)');
    }
    const at = raw.indexOf(CPUINFO_SEPARATOR);
    if (at < 0) {
      return error('parse_error', `the output has no "${CPUINFO_SEPARATOR}" section (do the fetch fragment and the parser disagree?)`);
    }
    const statText = raw.slice(0, at);
    const cpuinfoText = raw.slice(at + CPUINFO_SEPARATOR.length);

    const { total, cores } = parseProcStat(statText);
    if (total === undefined) {
      return error('parse_error', '/proc/stat has no cpu summary line');
    }

    const prev = ctx.state['proc_stat'] as ProcStatSnapshot | undefined;

    // The first read: remember it and return pending rather than 0 (rule 5)
    if (prev === undefined) {
      ctx.state['proc_stat'] = { total, cores } satisfies ProcStatSnapshot;
      return { status: 'pending' };
    }

    const samples: Record<string, number | string | boolean> = {};
    const dTotal = total[1] - prev.total[1];
    const dBusy = total[0] - prev.total[0];

    if (dTotal < 0 || dBusy < 0) {
      // A counter that went backwards means the board rebooted, so the value
      // is not trustworthy. Reset the baseline, report honestly that it
      // cannot be read, and never report a negative number (RF-3).
      ctx.state['proc_stat'] = { total, cores } satisfies ProcStatSnapshot;
      return error('parse_error', 'a counter went backwards — did the board reboot?');
    }
    if (dTotal === 0) {
      // The window is too short (not a single tick passed between the two
      // samples): the utilisation cannot be computed.
      //
      // This is `pending` and not `error`: nothing is broken, the window of
      // this round is simply too short — the baseline is kept, so the next
      // round can compute it. (Reporting an error would turn the probe red;
      // reporting 0 would be a false number.)
      return { status: 'pending' };
    }

    const usage = (dBusy / dTotal) * 100;
    if (outOfRange(usage)) {
      // Contract section 2.1.1: it may not be clamped into the range and
      // passed off as ok (that would be lying), and it may not be treated as
      // 0 (that would be a worse lie). A value above 100 comes out when only
      // some of the counters have wrapped around.
      return error(
        'out_of_domain',
        `the computed usage is ${usage} (not within 0..100) — the counters may only have wrapped around for some of the fields`,
      );
    }
    samples['usage'] = usage;

    for (const [index, current] of Object.entries(cores)) {
      const before = prev.cores[Number(index)];
      if (before === undefined) continue;
      const dc = current[1] - before[1];
      const db = current[0] - before[0];
      if (dc <= 0 || db < 0) continue;
      const pct = (db / dc) * 100;
      if (outOfRange(pct)) {
        return error('out_of_domain', `the computed usage of core ${index} is ${pct} (not within 0..100)`);
      }
      samples[`core.${index}.usage`] = pct;
    }

    for (const [index, name] of Object.entries(parseCoreNames(cpuinfoText))) {
      samples[`core.${index}.cluster`] = name;
    }

    ctx.state['proc_stat'] = { total, cores } satisfies ProcStatSnapshot;
    return ok(samples);
  },
};
