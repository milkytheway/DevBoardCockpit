import { describe, it, expect } from 'vitest';
import { probePack } from '../../src/main/tags/probe';
import type { BoardPack } from '../../src/main/tags/schema';
import type { ExecResult } from '../../src/main/hal/connection';

/**
 * The **whole flow of the probe** (with a fake connection).
 *
 * The two things the probe has to do:
 * 1. sample every group **twice** (the usage of `proc_stat` is the
 *    difference of two samples, the first reading is pending);
 * 2. judge reader by reader: "no more, no less, and every status is ok".
 */

const PACK: BoardPack = {
  apiVersion: 'devboard/v1',
  kind: 'BoardPack',
  id: 'tiny',
  name: 'minimal pack',
  version: '1.0.0',
  requires: { transports: ['adb'], capabilities: ['exec'] },
  poll_groups: [{ id: 'fast', interval_ms: 1000, readers: ['cpu', 'gpu'] }],
  readers: [
    {
      id: 'cpu',
      kind: 'proc_stat',
      args: { stat_path: '/proc/stat', cpuinfo_path: '/proc/cpuinfo' },
      provides: [
        { tag: 'cpu.usage', sample: 'usage' },
        { tag: 'cpu.core.*.usage', sample: 'core.*.usage' },
      ],
    },
    {
      id: 'gpu',
      kind: 'devfreq_load',
      args: { path: '/sys/class/devfreq/fb000000.gpu/load', measure: 'utilization' },
      provides: [{ tag: 'gpu.usage', sample: 'duty' }],
    },
  ],
  custom: [],
  actions: [],
};

const STAT_FIRST = `cpu  100 0 50 1000 0 0 0 0 0 0
cpu0 100 0 50 1000 0 0 0 0 0 0`;
const STAT_SECOND = `cpu  160 0 60 1200 0 0 0 0 0 0
cpu0 160 0 60 1200 0 0 0 0 0 0`;
const CPUINFO = 'processor\t: 0\nCPU part\t: 0xd05';

/** A fake connection: it emits the output with markers according to the protocol */
class FakeConnection {
  calls = 0;
  /** How often each key was called (that decides which entry of the array is taken) */
  private readonly counters = new Map<string, number>();
  constructor(private readonly bodies: Record<string, string | null | (string | null)[]>) {}

  /** What this round has to answer */
  private bodyFor(key: string): string | null | undefined {
    const spec = this.bodies[key];
    if (Array.isArray(spec)) {
      const i = this.counters.get(key) ?? 0;
      this.counters.set(key, i + 1);
      return spec[Math.min(i, spec.length - 1)];
    }
    return spec;
  }

  async exec(command: string): Promise<ExecResult> {
    this.calls += 1;
    const re = /echo '(__DBCGS_[0-9a-f]+__)';([\s\S]*?); echo '(__DBCGE_[0-9a-f]+__)'/g;
    const parts: string[] = [];
    for (const m of command.matchAll(re)) {
      const fragment = m[2] ?? '';
      const key = Object.keys(this.bodies).find((k) => fragment.includes(k));
      const body = key === undefined ? '' : this.bodyFor(key);
      if (body === null || body === undefined) continue;
      parts.push(m[1]!, body, m[3]!);
    }
    return { exitCode: 0, stdout: parts.join('\n'), stderr: '', durationMs: 1, timedOut: false };
  }
}

describe('probePack · the whole flow', () => {
  it('all green', async () => {
    const conn = new FakeConnection({
      '/proc/stat': [`${STAT_FIRST}\n--- cpuinfo ---\n${CPUINFO}`, `${STAT_SECOND}\n--- cpuinfo ---\n${CPUINFO}`],
      '/sys/class/devfreq/fb000000.gpu/load': '37@300000000Hz',
    });
    const report = await probePack(PACK, conn);
    expect(report.ok).toBe(true);
    expect(report.readers.map((r) => r.readerId)).toEqual(['cpu', 'gpu']);
  });

  it('**every group is sampled twice** (proc_stat needs two samples before it has a value)', async () => {
    const conn = new FakeConnection({
      '/proc/stat': [`${STAT_FIRST}\n--- cpuinfo ---\n${CPUINFO}`, `${STAT_SECOND}\n--- cpuinfo ---\n${CPUINFO}`],
      '/sys/class/devfreq/fb000000.gpu/load': '37@300000000Hz',
    });
    await probePack(PACK, conn);
    expect(conn.calls).toBe(2);
  });

  it('one round only → the cpu is pending → **it is not green**', async () => {
    const conn = new FakeConnection({
      '/proc/stat': `${STAT_FIRST}\n--- cpuinfo ---\n${CPUINFO}`,
      '/sys/class/devfreq/fb000000.gpu/load': '37@300000000Hz',
    });
    const report = await probePack(PACK, conn, { rounds: 1 });
    expect(report.ok).toBe(false);
    const cpu = report.readers.find((r) => r.readerId === 'cpu')!;
    expect(cpu.problems.join('\n')).toContain('pending');
  });

  it('**there is a gap between the two rounds** (otherwise the window has a length of 0 and the usage cannot be computed)', async () => {
    const conn = new FakeConnection({
      '/proc/stat': [`${STAT_FIRST}\n--- cpuinfo ---\n${CPUINFO}`, `${STAT_SECOND}\n--- cpuinfo ---\n${CPUINFO}`],
      '/sys/class/devfreq/fb000000.gpu/load': '37@300000000Hz',
    });
    const started = Date.now();
    await probePack(PACK, conn, { gapMs: 60 });
    // At least 60ms have passed — **a sleep guarantees "at least"**, so this assertion does not drift
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
  });

  it('a reader cannot be read → **it is red, the others go on**', async () => {
    const conn = new FakeConnection({
      '/proc/stat': [`${STAT_FIRST}\n--- cpuinfo ---\n${CPUINFO}`, `${STAT_SECOND}\n--- cpuinfo ---\n${CPUINFO}`],
      '/sys/class/devfreq/fb000000.gpu/load': null,
    });
    const report = await probePack(PACK, conn);
    expect(report.ok).toBe(false);
    const gpu = report.readers.find((r) => r.readerId === 'gpu')!;
    expect(gpu.ok).toBe(false);
    const cpu = report.readers.find((r) => r.readerId === 'cpu')!;
    expect(cpu.ok).toBe(true);
  });

  it('the report carries the tags the pack declares and their values', async () => {
    const conn = new FakeConnection({
      '/proc/stat': [`${STAT_FIRST}\n--- cpuinfo ---\n${CPUINFO}`, `${STAT_SECOND}\n--- cpuinfo ---\n${CPUINFO}`],
      '/sys/class/devfreq/fb000000.gpu/load': '37@300000000Hz',
    });
    const report = await probePack(PACK, conn);
    const gpu = report.readers.find((r) => r.readerId === 'gpu')!;
    expect(gpu.tags).toContainEqual({ tag: 'gpu.usage', value: 37, unit: 'percent', status: 'ok' });
  });
});
