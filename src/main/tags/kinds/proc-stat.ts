import { quotePath } from '../../util/shell-quote';
import { argStr } from './util';
import { error, isBlank, leadingInts, missing, ok, outOfRange } from './parse-util';
import type { ReaderKind } from './types';

/**
 * `proc_stat` —— CPU 占用率与核名。
 *
 * **需要两次采样**：占用率是两次采样做差（契约 §2.4）。
 * 首读的结果是 `pending`——**不是 0**（规则 5）。
 *
 * 取两个文件：`/proc/stat` 给计数器，`/proc/cpuinfo` 给核名与簇。
 * 中间用一个**分隔行**隔开——它是这段输出里唯一的一行非计数器内容。
 *
 * ── 公式沿用前身工程（`core/metrics.py` 的 `_parse_proc_stat`）──
 *
 * - **busy = user + nice + system**（前三个字段）；
 * - **total = 全部字段之和**；
 * - 占用率 = Δbusy / Δtotal × 100，夹在 0..100。
 *
 * 沿用的理由：这两个公式是**真机换来的**，
 * 而且它们的注释写着「idle 必须排除，否则板子看起来永远 100% 忙」。
 */

/** 两段之间的分隔行。`/proc/stat` 的行都以 `cpu` 开头，不会撞上它 */
export const CPUINFO_SEPARATOR = '--- cpuinfo ---';

/** ARMv8 架构的 CPU part id → 簇名（与前身工程同一张表） */
const CORE_NAMES: Record<number, string> = {
  0xd05: 'A55',
  0xd0b: 'A76',
};

/** `/proc/stat` 的汇总行与各核行 */
interface ProcStat {
  /** [busy, total] 的 jiffies */
  total?: [number, number];
  /** 核号 → [busy, total] */
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
      // **先切出第一个词再判断**——`cpu0 41283 0 …` 整行不是 `cpu\d+`
      // （真机样本的黄金向量在这里逮到过这个 bug）。
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
 * 从 `/proc/cpuinfo` 取「核号 → 簇名」。
 *
 * **未知名字按字符串原样上报，不报错**（契约词表：`cpu.core.*.cluster`）——
 * 前身工程的兜底是 `cpu<十六进制>`，这里沿用同一个形状。
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

/** 上一次的采样（存在 runtime 给的 ctx.state 里，不藏在模块变量里） */
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
  parse(raw, _args, ctx) {
    if (isBlank(raw)) {
      return missing('/proc/stat 读不到（路径不对？）');
    }
    const at = raw.indexOf(CPUINFO_SEPARATOR);
    if (at < 0) {
      return error('parse_error', `输出里找不到「${CPUINFO_SEPARATOR}」这一段（取数片段与解析对不上？）`);
    }
    const statText = raw.slice(0, at);
    const cpuinfoText = raw.slice(at + CPUINFO_SEPARATOR.length);

    const { total, cores } = parseProcStat(statText);
    if (total === undefined) {
      return error('parse_error', '/proc/stat 里没有 cpu 汇总行');
    }

    const prev = ctx.state['proc_stat'] as ProcStatSnapshot | undefined;

    // 首读：把这次记下来，**返回 pending 而不是 0**（规则 5）
    if (prev === undefined) {
      ctx.state['proc_stat'] = { total, cores } satisfies ProcStatSnapshot;
      return { status: 'pending' };
    }

    const samples: Record<string, number | string | boolean> = {};
    const dTotal = total[1] - prev.total[1];
    const dBusy = total[0] - prev.total[0];

    if (dTotal <= 0 || dBusy < 0) {
      // 计数器倒退 = 板子重启过；间隔为 0 = 采样太快。
      // **两种都不可信**——重置基准，如实报「读不到」，**不报负数**（RF-3）。
      ctx.state['proc_stat'] = { total, cores } satisfies ProcStatSnapshot;
      return error('parse_error', '计数器没有前进（或倒退）——板子重启了？采样间隔太短？');
    }

    const usage = (dBusy / dTotal) * 100;
    if (outOfRange(usage)) {
      // 契约 §2.1.1：**不许夹到区间当 ok**（那是撒谎），也不许当 0（更糟）。
      // 计数器只回绕一部分字段时就会算出 >100。
      return error(
        'out_of_domain',
        `算出来的占用率是 ${usage}（不在 0..100）——计数器可能只回绕了一部分字段`,
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
        return error('out_of_domain', `核 ${index} 算出来的占用率是 ${pct}（不在 0..100）`);
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
