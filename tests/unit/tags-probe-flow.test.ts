import { describe, it, expect } from 'vitest';
import { probePack } from '../../src/main/tags/probe';
import type { BoardPack } from '../../src/main/tags/schema';
import type { ExecResult } from '../../src/main/hal/connection';

/**
 * 探针的**整条流程**（用假的连接）。
 *
 * 探针要做的两件事：
 * 1. 每个组采**两轮**（`proc_stat` 的占用率是两次采样做差，首读是 pending）；
 * 2. 逐 reader 判定「不多、不少、状态都是 ok」。
 */

const PACK: BoardPack = {
  apiVersion: 'devboard/v1',
  kind: 'BoardPack',
  id: 'tiny',
  name: '最小包',
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

/** 假的连接：按协议吐出带 marker 的输出 */
class FakeConnection {
  calls = 0;
  /** 每个 key 调过几次（决定取数组里的第几个） */
  private readonly counters = new Map<string, number>();
  constructor(private readonly bodies: Record<string, string | null | (string | null)[]>) {}

  /** 这一轮该回什么 */
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

describe('probePack · 整条流程', () => {
  it('全绿', async () => {
    const conn = new FakeConnection({
      '/proc/stat': [`${STAT_FIRST}\n--- cpuinfo ---\n${CPUINFO}`, `${STAT_SECOND}\n--- cpuinfo ---\n${CPUINFO}`],
      '/sys/class/devfreq/fb000000.gpu/load': '37@300000000Hz',
    });
    const report = await probePack(PACK, conn);
    expect(report.ok).toBe(true);
    expect(report.readers.map((r) => r.readerId)).toEqual(['cpu', 'gpu']);
  });

  it('**每个组采两轮**（proc_stat 要两次采样才有值）', async () => {
    const conn = new FakeConnection({
      '/proc/stat': [`${STAT_FIRST}\n--- cpuinfo ---\n${CPUINFO}`, `${STAT_SECOND}\n--- cpuinfo ---\n${CPUINFO}`],
      '/sys/class/devfreq/fb000000.gpu/load': '37@300000000Hz',
    });
    await probePack(PACK, conn);
    expect(conn.calls).toBe(2);
  });

  it('只采一轮 → cpu 是 pending → **不绿**', async () => {
    const conn = new FakeConnection({
      '/proc/stat': `${STAT_FIRST}\n--- cpuinfo ---\n${CPUINFO}`,
      '/sys/class/devfreq/fb000000.gpu/load': '37@300000000Hz',
    });
    const report = await probePack(PACK, conn, { rounds: 1 });
    expect(report.ok).toBe(false);
    const cpu = report.readers.find((r) => r.readerId === 'cpu')!;
    expect(cpu.problems.join('\n')).toContain('pending');
  });

  it('**两轮之间留一个间隔**（否则窗口长度为 0，算不出占用率）', async () => {
    const conn = new FakeConnection({
      '/proc/stat': [`${STAT_FIRST}\n--- cpuinfo ---\n${CPUINFO}`, `${STAT_SECOND}\n--- cpuinfo ---\n${CPUINFO}`],
      '/sys/class/devfreq/fb000000.gpu/load': '37@300000000Hz',
    });
    const started = Date.now();
    await probePack(PACK, conn, { gapMs: 60 });
    // 至少隔了 60ms——**sleep 保证的是「至少」**，所以这条断言不会飘
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
  });

  it('某个 reader 读不到 → **它红，别的照常**', async () => {
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

  it('报告里带上包里声明的 tag 与值', async () => {
    const conn = new FakeConnection({
      '/proc/stat': [`${STAT_FIRST}\n--- cpuinfo ---\n${CPUINFO}`, `${STAT_SECOND}\n--- cpuinfo ---\n${CPUINFO}`],
      '/sys/class/devfreq/fb000000.gpu/load': '37@300000000Hz',
    });
    const report = await probePack(PACK, conn);
    const gpu = report.readers.find((r) => r.readerId === 'gpu')!;
    expect(gpu.tags).toContainEqual({ tag: 'gpu.usage', value: 37, unit: 'percent', status: 'ok' });
  });
});
