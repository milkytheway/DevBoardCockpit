import { matchTagPattern } from './vocabulary';
import { TagStore } from './store';
import { TagSampler, type ExecRunner } from './sampler';
import type { BoardPack, ReaderDef } from './schema';
import type { TagReading, TagStatus } from '../../shared/tag-reading';

/**
 * The verdict logic of the probe.
 *
 * The acceptance criterion of M4 is "probe:board is all green on
 * `rk3588-atk`" — and "all green" needs a mechanical criterion, otherwise
 * it is only a person looking at a screen saying "it looks right".
 *
 * A reader is green when:
 *
 * 1. every tag it produces is declared in the pack (no more than that);
 * 2. every tag the pack declares was obtained at least once (no less than
 *    that);
 * 3. the status of those tags is `ok` (`pending` does not count — the probe
 *    wants a real value, not one that has not been computed yet).
 */

/** What a reader declares in the pack */
export interface ProbeExpectation {
  readerId: string;
  kind: string;
  /** The tags this reader declares (possibly patterns, such as `cpu.core.*.usage`) */
  declaredTags: string[];
}

/** One tag in the probe report */
export interface ProbeTag {
  tag: string;
  value: unknown;
  unit: string;
  status: TagStatus;
}

/** The probe report of one reader */
export interface ProbeReaderReport {
  readerId: string;
  kind: string;
  tags: ProbeTag[];
  /** Why it is red (an empty array when it is green) */
  problems: string[];
  ok: boolean;
}

/**
 * Decide whether a reader is green.
 *
 * @param expectation what the pack declares for this reader
 * @param readings the readings this sampling produced
 */
export function judgeReader(
  expectation: ProbeExpectation,
  readings: TagReading[],
): ProbeReaderReport {
  const problems: string[] = [];
  const declared = expectation.declaredTags;

  // 1. One tag too many: it was produced but the pack does not declare it
  for (const r of readings) {
    const known = declared.some((pattern) => matchTagPattern(pattern, r.tag));
    if (!known) {
      problems.push(`one tag too many: ${r.tag} (the pack does not declare it)`);
    }
  }

  // 2. One tag missing: the pack declares it but nothing was obtained
  for (const pattern of declared) {
    // A pattern with a wildcard does not require "exactly one" —
    // a board with 8 cores produces 8 `cpu.core.N.usage` while the pack
    // declares one pattern. But not one at all is a miss (the declaration
    // says so).
    const got = readings.some((r) => matchTagPattern(pattern, r.tag));
    if (!got) {
      problems.push(`one tag missing: ${pattern}`);
    }
  }

  // 3. The status has to be ok
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

/** The probe report of a whole pack */
export interface ProbeReport {
  packId: string;
  readers: ProbeReaderReport[];
  /** True only when everything is green */
  ok: boolean;
}

/**
 * The `--pack` argument of the probe: a pack id is accepted and so is a
 * directory path.
 *
 * The documented invocation is `--pack rk3588-atk` (a pack id, as in
 * `profiles/boards/rk3588-atk/README.md`) — if only a directory path were
 * accepted, that command would not run.
 */
export function resolvePackDir(pack: string | undefined, boardsDir: string): string {
  const fallback = `${boardsDir}/rk3588-atk`;
  if (pack === undefined || pack.length === 0) return fallback;
  // A value with a path separator is a directory path, use it as it is
  if (pack.includes('/') || pack.includes('\\')) return pack;
  return `${boardsDir}/${pack}`;
}

/**
 * The probe has to report the `requires` of the pack (the capabilities and
 * the transports).
 *
 * This is the only consumer of `requires.capabilities` in v1 (the "pack
 * description query" promised by the contract) — if it is not reported, the
 * field stays a field that nobody consumes.
 */
export function describeRequires(pack: BoardPack): string {
  const caps = pack.requires.capabilities.join(', ');
  const transports = pack.requires.transports.join(', ');
  return `  requires: capabilities=[${caps}]  transports=[${transports}]`;
}

/**
 * The readings of one reader (found by the tag patterns it declares).
 *
 * Only the tags this reader declares count — the readings of another reader
 * are not its own.
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

/** Wait a little (milliseconds) */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * When the probe is red, say what to check next.
 *
 * Why it is needed: when the probe times out on every reader over a serial
 * line, the original form was "11 readers each report a timeout" — it does
 * not show whether the connection never came up or the reader is at fault,
 * and it takes several minutes. The shape of the failure is very poor: it
 * turns "one connection never came up" into "every reader is broken".
 *
 * The real trap (measured on real hardware on 2026-11-13): the
 * `serial-server.py` left behind by the plan 1 acceptance run on the host
 * held COM3 exclusively — the board was alive and the serial line was fine,
 * but the reply was swallowed by that process, so the exec of the
 * application itself never received anything. In that situation the verdict
 * "the reader is at fault" leads a person a long way off.
 *
 * @param report the probe report
 * @param transport the kind of transport of this connection
 * @returns one hint; null when no hint is needed
 */
export function probeHint(report: ProbeReport, transport: string): string | null {
  if (report.ok) return null;

  // Not a single number came out → the whole connection never came up once, not a reader problem
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
 * Probe a board pack.
 *
 * Every group is sampled for `rounds` rounds — the utilisation of
 * `proc_stat` is the difference between two samples (contract section 2.4)
 * and the first read is `pending`, not 0. The probe wants a real value.
 */
export async function probePack(
  pack: BoardPack,
  connection: ExecRunner,
  opts: { rounds?: number; gapMs?: number } = {},
): Promise<ProbeReport> {
  const rounds = opts.rounds ?? 2;
  // A gap has to be left between the two rounds — the counters of
  // `/proc/stat` tick every 10 ms (USER_HZ=100), and two back-to-back
  // samplings may not span a single tick → the window is 0 → the utilisation
  // cannot be computed.
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
