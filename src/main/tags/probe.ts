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
      problems.push(`多了一个 tag：${r.tag}（包里没声明）`);
    }
  }

  // 2. 缺失的 tag：包里声明了却一个都没拿到
  for (const pattern of declared) {
    // 带通配符的**不要求「刚好一个」**——
    // 8 核的板子出 8 个 `cpu.core.N.usage`，包里只声明了一个模式。
    // 但**一个都没有**就是缺（这条声明白写了）。
    const got = readings.some((r) => matchTagPattern(pattern, r.tag));
    if (!got) {
      problems.push(`少了一个 tag：${pattern}`);
    }
  }

  // 3. 状态必须都是 ok
  for (const r of readings) {
    if (r.status === 'ok') continue;
    const detail = r.detail ? `（${r.detail}）` : '';
    problems.push(`tag ${r.tag} 的状态是 ${r.status}${detail}——探针要的是真值`);
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

/**
 * 探一个板型包。
 *
 * **每个组采 `rounds` 轮**——`proc_stat` 的占用率是**两次采样做差**
 * （契约 §2.4），首读是 `pending` 而不是 0。探针要的是**真值**。
 */
export async function probePack(
  pack: BoardPack,
  connection: ExecRunner,
  opts: { rounds?: number } = {},
): Promise<ProbeReport> {
  const rounds = opts.rounds ?? 2;
  const store = new TagStore();
  const sampler = new TagSampler(pack, connection, store);

  for (const group of pack.poll_groups) {
    for (let i = 0; i < rounds; i += 1) {
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
