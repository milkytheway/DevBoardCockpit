import { describe, it, expect } from 'vitest';
import { TagSampler } from '../../src/main/tags/sampler';
import { TagStore } from '../../src/main/tags/store';
import type { BoardPack } from '../../src/main/tags/schema';
import type { ExecResult } from '../../src/main/hal/connection';

/**
 * 采样器 —— 把前六个任务串起来：
 * **取数 → 分段 → 逐 reader 解析 → sample 绑成 tag → 入 store**。
 *
 * 用**假的连接**：它按协议吐出带 marker 的输出，
 * 于是整条链路（除了真的跟板子说话）都能测。
 */

const PACK: BoardPack = {
  apiVersion: 'devboard/v1',
  kind: 'BoardPack',
  id: 'tiny',
  name: '最小包',
  version: '1.0.0',
  requires: { transports: ['adb'], capabilities: ['exec'] },
  poll_groups: [
    { id: 'fast', interval_ms: 1000, readers: ['cpu', 'gpu'] },
    { id: 'slow', interval_ms: 2000, readers: ['mem'] },
  ],
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
  custom: [
    {
      id: 'mem',
      kind: 'meminfo',
      args: { path: '/proc/meminfo' },
      provides: [{ tag: 'mem.total_bytes', sample: 'total_bytes' }],
    },
  ],
  actions: [],
};

/** 一次完整的 proc_stat 输出（两次采样用） */
const STAT_FIRST = `cpu  100 0 50 1000 0 0 0 0 0 0
cpu0 100 0 50 1000 0 0 0 0 0 0`;
const STAT_SECOND = `cpu  160 0 60 1200 0 0 0 0 0 0
cpu0 160 0 60 1200 0 0 0 0 0 0`;
const CPUINFO = 'processor\t: 0\nCPU part\t: 0xd05';

/**
 * 假的连接：按协议吐出带 marker 的输出。
 *
 * **它靠取数片段认读者**——片段里有哪个路径，就是哪个 reader。
 * （marker 是随机的，测试没法提前知道，只能从命令里反推。）
 */
class FakeConnection {
  readonly commands: string[] = [];
  /**
   * 取数片段里的哪个路径 → 回什么。
   *
   * `null` = 这一段没跑起来；
   * **一串**（数组）= 第一次调用给第一个、第二次给第二个——
   * `proc_stat` 需要**两次采样**做差，测试要的就是这个。
   */
  bodies: Record<string, string | null | (string | null)[]> = {
    '/proc/stat': '',
    '/sys/class/devfreq/fb000000.gpu/load': '0@300000000Hz',
    '/proc/meminfo': 'MemTotal:        8107744 kB\nMemAvailable:    7655500 kB',
  };
  /** 整个往返失败 */
  failWith: Error | null = null;
  /** 每个 key 调过几次（决定取数组里的第几个） */
  private readonly counters = new Map<string, number>();

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
    this.commands.push(command);
    if (this.failWith) throw this.failWith;

    // 从命令里把「marker + 片段」对抠出来
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

describe('采样器', () => {
  it('采一次组，store 里出现该组 reader 提供的全部 tag', async () => {
    const store = new TagStore();
    const conn = new FakeConnection();
    const sampler = new TagSampler(PACK, conn, store);

    await sampler.sampleGroup('fast');

    expect(store.get('gpu.usage')).toBeDefined();
    expect(store.get('gpu.usage')!.value).toBe(0);
  });

  it('**sample 绑成 tag**：core.0.usage → cpu.core.0.usage', async () => {
    const store = new TagStore();
    const conn = new FakeConnection();
    conn.bodies['/proc/stat'] = [
      `${STAT_FIRST}\n--- cpuinfo ---\n${CPUINFO}`,
      `${STAT_SECOND}\n--- cpuinfo ---\n${CPUINFO}`,
    ];
    const sampler = new TagSampler(PACK, conn, store);

    await sampler.sampleGroup('fast');
    await sampler.sampleGroup('fast');

    expect(store.get('cpu.usage')).toBeDefined();
    expect(store.get('cpu.core.0.usage')).toBeDefined();
    // **不是** `cpu.core.*.usage` —— 通配段要被具体值替掉
    expect(store.get('cpu.core.*.usage')).toBeUndefined();
  });

  it('绑不上的 sample **不绑**（不多绑一个 tag）', async () => {
    const store = new TagStore();
    const conn = new FakeConnection();
    conn.bodies['/proc/stat'] = `${STAT_FIRST}\n--- cpuinfo ---\n${CPUINFO}`;
    const sampler = new TagSampler(PACK, conn, store);

    await sampler.sampleGroup('fast');
    await sampler.sampleGroup('fast');

    // gpu 只提供 duty → 只有 gpu.usage，没有 gpu.freq_hz
    expect(store.get('gpu.freq_hz')).toBeUndefined();
  });

  it('某个 reader 解析失败 → **只有它自己的 tag** 报 error，别的照常', async () => {
    const store = new TagStore();
    const conn = new FakeConnection();
    conn.bodies['/sys/class/devfreq/fb000000.gpu/load'] = 'not a number';
    const sampler = new TagSampler(PACK, conn, store);

    await sampler.sampleGroup('fast');

    // 「读出来了但坏了」= error（契约 §2.1.1），不是 unavailable
    expect(store.get('gpu.usage')!.status).toBe('error');
    expect(store.get('gpu.usage')!.value).toBeNull();
    expect(store.get('gpu.usage')!.reason).toBe('parse_error');
    // gpu 的失败**不影响** cpu 那一组
    expect(store.get('cpu.usage')).toBeDefined();
  });

  it('往返失败 → 该组**全部** tag 报 error（还没成功过时，没有旧值可保留）', async () => {
    const store = new TagStore();
    const conn = new FakeConnection();
    conn.failWith = new Error('传输断了');
    const sampler = new TagSampler(PACK, conn, store);

    await sampler.sampleGroup('fast');

    // 从没成功过 → error（契约 §2.1：「pending → error = 采样过程本身失败」）
    expect(store.get('gpu.usage')!.status).toBe('error');
    expect(store.get('cpu.usage')!.status).toBe('error');
  });

  it('**刷新失败但之前成功过** → 报 stale 并**保留旧值**（契约 §2.1）', async () => {
    // 「ok → stale = 本次刷新失败，但保留上一次的值」——
    // 一次 ADB 抖动不该让面板上的仪表整片消失。
    const store = new TagStore();
    const conn = new FakeConnection();
    conn.bodies['/proc/stat'] = [
      `${STAT_FIRST}\n--- cpuinfo ---\n${CPUINFO}`,
      `${STAT_SECOND}\n--- cpuinfo ---\n${CPUINFO}`,
    ];
    const sampler = new TagSampler(PACK, conn, store);

    await sampler.sampleGroup('fast');
    await sampler.sampleGroup('fast');
    expect(store.get('cpu.usage')!.status).toBe('ok');
    const good = store.get('cpu.usage')!.value;

    // 接下来这次往返断了
    conn.failWith = new Error('传输断了');
    await sampler.sampleGroup('fast');

    const after = store.get('cpu.usage')!;
    expect(after.status).toBe('stale');
    expect(after.value).toBe(good);
  });

  it('**超时**归一到 reason=timeout（事实 G1：统一 124）', async () => {
    const store = new TagStore();
    const conn = new FakeConnection();
    conn.failWith = new Error('timeout');
    const sampler = new TagSampler(PACK, conn, store);

    await sampler.sampleGroup('fast');

    expect(store.get('gpu.usage')!.reason).toBe('timeout');
  });

  it('proc_stat **首读是 pending**，第二次才有值', async () => {
    const store = new TagStore();
    const conn = new FakeConnection();
    conn.bodies['/proc/stat'] = [
      `${STAT_FIRST}\n--- cpuinfo ---\n${CPUINFO}`,
      `${STAT_SECOND}\n--- cpuinfo ---\n${CPUINFO}`,
    ];
    const sampler = new TagSampler(PACK, conn, store);

    await sampler.sampleGroup('fast');
    expect(store.get('cpu.usage')!.status).toBe('pending');
    expect(store.get('cpu.usage')!.value).toBeNull();

    await sampler.sampleGroup('fast');
    expect(store.get('cpu.usage')!.status).toBe('ok');
    // busy Δ = (160+60) - (100+50) = 70；total Δ = 1420 - 1150 = 270
    expect(store.get('cpu.usage')!.value).toBeCloseTo((70 / 270) * 100, 8);
  });

  it('reader 缺 provides → 它产出的 sample **不出现在 store 里**', async () => {
    const store = new TagStore();
    const conn = new FakeConnection();
    const pack: BoardPack = {
      ...PACK,
      readers: PACK.readers.map((r) => (r.id === 'gpu' ? { ...r, provides: [] } : r)),
    };
    const sampler = new TagSampler(pack, conn, store);

    await sampler.sampleGroup('fast');

    expect(store.get('gpu.usage')).toBeUndefined();
  });

  it('采别的组只影响那个组的 reader', async () => {
    const store = new TagStore();
    const conn = new FakeConnection();
    const sampler = new TagSampler(PACK, conn, store);

    await sampler.sampleGroup('slow');

    expect(store.get('mem.total_bytes')).toBeDefined();
    expect(store.get('mem.total_bytes')!.value).toBe(8107744 * 1024);
    expect(store.get('gpu.usage')).toBeUndefined();
  });

  it('**script 没有远端路径** → 如实报「没推上去」，不生成注定失败的命令', async () => {
    // 脚本住在宿主上，要先推到板子的 /tmp 才跑得起来（契约 §3.3）。
    // 运行时还没推 → **不生成那条注定失败的命令**。
    const pack: BoardPack = {
      ...PACK,
      poll_groups: [
        { id: 'fast', interval_ms: 1000, readers: ['cpu', 'gpu'] },
        { id: 'slow', interval_ms: 2000, readers: ['mem', 'pipe'] },
      ],
      custom: [
        {
          id: 'mem',
          kind: 'meminfo',
          args: { path: '/proc/meminfo' },
          provides: [{ tag: 'mem.total_bytes', sample: 'total_bytes' }],
        },
        {
          id: 'pipe',
          kind: 'script',
          args: { path: 'scripts/pipeline_status.sh', interpreter: '/bin/sh' },
          provides: [{ tag: 'custom.tiny.fps', sample: 'fps' }],
        },
      ],
    };
    const store = new TagStore();
    const conn = new FakeConnection();
    const sampler = new TagSampler(pack, conn, store);

    await sampler.sampleGroup('slow');

    expect(store.get('custom.tiny.fps')!.status).toBe('unavailable');
    expect(store.get('custom.tiny.fps')!.detail).toContain('remote_path');
    // **命令里不该有那条注定失败的脚本调用**
    expect(conn.commands.join('\n')).not.toContain('pipeline_status.sh');
  });

  it('不认识的组**报错**，不是静默什么都不做', async () => {
    const sampler = new TagSampler(PACK, new FakeConnection(), new TagStore());
    await expect(sampler.sampleGroup('nosuch')).rejects.toThrow(/nosuch/);
  });
});
