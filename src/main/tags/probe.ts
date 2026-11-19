import { matchTagPattern } from './vocabulary';
import { TagStore } from './store';
import { TagSampler, type ExecRunner } from './sampler';
import type { BoardPack, ReaderDef } from './schema';
import type { TagReading, TagStatus } from '../../shared/tag-reading';

/**
 * 探针的判定逻辑。
 *
 * M4 的验收判据是「`probe:board` 对 `rk3588-atk` **全绿**」——
 * 而「全绿」必须有一个**机械的判据**，
 * 不然它只是一个人看着屏幕说「好像都对了」。
 *
 * 一个 reader 绿的条件：
 *
 * 1. 它产出的**每一个** tag 都在包里声明过（**不多**）；
 * 2. 包里声明的**每一个** tag 都至少拿到了一个（**不少**）；
 * 3. 这些 tag 的状态**都是 `ok`**（`pending` 也不算——
 *    探针要的是「取到了真值」，不是「取到了但还没算出来」）。
 */

/** 一个 reader 在包里的声明 */
export interface ProbeExpectation {
  readerId: string;
  kind: string;
  /** 这个 reader 声明的 tag（可能是模式，如 `cpu.core.*.usage`） */
  declaredTags: string[];
}

/** 探针报告里的一个 tag */
export interface ProbeTag {
  tag: string;
  value: unknown;
  unit: string;
  status: TagStatus;
}

/** 一个 reader 的探针报告 */
export interface ProbeReaderReport {
  readerId: string;
  kind: string;
  tags: ProbeTag[];
  /** 为什么红（绿时是空数组） */
  problems: string[];
  ok: boolean;
}

/**
 * 判一个 reader 绿不绿。
 *
 * @param expectation 包里对这个 reader 的声明
 * @param readings 这次采样拿到的读数
 */
export function judgeReader(
  expectation: ProbeExpectation,
  readings: TagReading[],
): ProbeReaderReport {
  const problems: string[] = [];
  const declared = expectation.declaredTags;

  // 1. 多余的 tag：产出了但包里没声明
  for (const r of readings) {
    const known = declared.some((pattern) => matchTagPattern(pattern, r.tag));
    if (!known) {
      problems.push(`one tag too many: ${r.tag} (the pack does not declare it)`);
    }
  }

  // 2. 缺失的 tag：包里声明了却一个都没拿到
  for (const pattern of declared) {
    // 带通配符的**不要求「刚好一个」**——
    // 8 核的板子出 8 个 `cpu.core.N.usage`，包里只声明了一个模式。
    // 但**一个都没有**就是缺（这条声明白写了）。
    const got = readings.some((r) => matchTagPattern(pattern, r.tag));
    if (!got) {
      problems.push(`one tag missing: ${pattern}`);
    }
  }

  // 3. 状态必须都是 ok
  for (const r of readings) {
    if (r.status === 'ok') continue;
    const detail = r.detail ? ` (${r.detail})` : '';
    problems.push(`the status of tag ${r.tag} is ${r.status}${detail} — the probe wants a real reading`);
  }

  return {
    readerId: expectation.readerId,
    kind: expectation.kind,
    tags: readings.map((r) => ({
      tag: r.tag,
      value: r.value,
      unit: r.unit,
      status: r.status,
    })),
    problems,
    ok: problems.length === 0,
  };
}

/** 整个包的探针报告 */
export interface ProbeReport {
  packId: string;
  readers: ProbeReaderReport[];
  /** 全绿才是 true */
  ok: boolean;
}

/**
 * 探针的 `--pack` 参数：**包 id 也认，目录路径也认**。
 *
 * 文档（`docs/04` §12、`profiles/boards/rk3588-atk/README.md`）写的是
 * `--pack rk3588-atk`（**包 id**）——实现只认目录路径的话，
 * **文档里那条命令跑不起来**。
 */
export function resolvePackDir(pack: string | undefined, boardsDir: string): string {
  const fallback = `${boardsDir}/rk3588-atk`;
  if (pack === undefined || pack.length === 0) return fallback;
  // 带路径分隔符的 = 目录路径，原样用
  if (pack.includes('/') || pack.includes('\\')) return pack;
  return `${boardsDir}/${pack}`;
}

/**
 * 探针要报出这个包的 `requires`（capabilities 与 transports）。
 *
 * **这是 `requires.capabilities` 在 v1 唯一的消费者**
 * （`docs/06` C9 承诺的「包描述查询」）——
 * 不报出来，这个字段就仍然是「无人消费的字段」。
 */
export function describeRequires(pack: BoardPack): string {
  const caps = pack.requires.capabilities.join(', ');
  const transports = pack.requires.transports.join(', ');
  return `  requires: capabilities=[${caps}]  transports=[${transports}]`;
}

/**
 * 一个 reader 的读数（按它声明的 tag 模式找）。
 *
 * **只认这个 reader 声明的 tag**——别的 reader 的读数不算它的。
 */
export function readingsOf(reader: ReaderDef, store: TagStore): TagReading[] {
  const all = store.all();
  const seen = new Set<string>();
  const out: TagReading[] = [];
  for (const p of reader.provides) {
    for (const r of all) {
      if (seen.has(r.tag)) continue;
      if (!matchTagPattern(p.tag, r.tag)) continue;
      seen.add(r.tag);
      out.push(r);
    }
  }
  return out;
}

/** 等一小会儿（毫秒） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 探针红了的时候，给一句「**下一步查什么**」。
 *
 * **为什么需要它**：探针在串口上全超时的时候，原来的形态是
 * 「11 个 reader 各报一条超时」——**看不出是连接没通，还是 reader 有问题**，
 * 而且要等好几分钟。**失败形态极差**：它把「一条连接没通」说成了
 * 「每个 reader 都不行」。
 *
 * 真实的坑（2026-11-13 真机实测）：宿主上计划 1 验收留下的
 * `serial-server.py` **独占打开了 COM3** —— 板子是活的、串口是通的，
 * 但**回包被那个进程吃掉了**，所以应用自己的 `exec` 永远等不到。
 * 这种情况下「reader 有问题」这个判断会把人带偏很远。
 *
 * @param report 探针报告
 * @param transport 这条连接的传输种类
 * @returns 一句提示；不需要提示时返回 null
 */
export function probeHint(report: ProbeReport, transport: string): string | null {
  if (report.ok) return null;

  // 一个数都没出来 → 整条连接一次都没通，不是 reader 的问题
  const allEmpty = report.readers.every((r) => r.tags.length === 0);
  if (!allEmpty) return null;

  if (transport === 'serial') {
    return [
      'not a single number came out — **it is most likely not the problem of the reader, this connection never came up once**.',
      '  the most common serial trap: **another program is holding the port exclusively** (COM3 on this host).',
      '  (the serial-server.py left by the Plan 1 acceptance run swallows the reply: the board is alive, the serial line is fine,',
      '    but the exec of the application itself never receives anything — so every reader reports "timeout").)',
      '  stop that process first, then run it again.',
    ].join('\n');
  }
  return [
    'not a single number came out — **it is most likely not the problem of the reader, this connection never came up once**.',
    '  check the connection itself first (can it connect, is the board there), then check the reader.',
  ].join('\n');
}

/**
 * 探一个板型包。
 *
 * **每个组采 `rounds` 轮**——`proc_stat` 的占用率是**两次采样做差**
 * （契约 §2.4），首读是 `pending` 而不是 0。探针要的是**真值**。
 */
export async function probePack(
  pack: BoardPack,
  connection: ExecRunner,
  opts: { rounds?: number; gapMs?: number } = {},
): Promise<ProbeReport> {
  const rounds = opts.rounds ?? 2;
  // **两轮之间要留一个间隔**——`/proc/stat` 的计数器是 10ms 一格（USER_HZ=100），
  // 背靠背采两次可能一个 tick 都没过 → 窗口长度为 0 → 算不出占用率。
  const gapMs = opts.gapMs ?? 500;
  const store = new TagStore();
  const sampler = new TagSampler(pack, connection, store);

  for (const group of pack.poll_groups) {
    for (let i = 0; i < rounds; i += 1) {
      if (i > 0 && gapMs > 0) await sleep(gapMs);
      await sampler.sampleGroup(group.id);
    }
  }

  const readers: ProbeReaderReport[] = [...pack.readers, ...pack.custom].map((reader) =>
    judgeReader(
      {
        readerId: reader.id,
        kind: reader.kind,
        declaredTags: reader.provides.map((p) => p.tag),
      },
      readingsOf(reader, store),
    ),
  );

  return {
    packId: pack.id,
    readers,
    ok: readers.every((r) => r.ok),
  };
}
