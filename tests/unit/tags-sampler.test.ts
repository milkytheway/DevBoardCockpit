import { describe, it, expect } from 'vitest';
import { TagSampler } from '../../src/main/tags/sampler';
import { TagStore } from '../../src/main/tags/store';
import type { BoardPack } from '../../src/main/tags/schema';
import type { ExecResult } from '../../src/main/hal/connection';

/**
 * The sampler — it strings the first tasks together:
 * **collect → segment → parse reader by reader → bind the sample to a tag →
 * put it into the store**.
 *
 * It uses a **fake connection** that emits the output with markers according
 * to the protocol, so the whole chain (except the talking to the board) can
 * be tested.
 */

const PACK: BoardPack = {
  apiVersion: 'devboard/v1',
  kind: 'BoardPack',
  id: 'tiny',
  name: 'minimal pack',
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

/** A complete proc_stat output (for two samples) */
const STAT_FIRST = `cpu  100 0 50 1000 0 0 0 0 0 0
cpu0 100 0 50 1000 0 0 0 0 0 0`;
const STAT_SECOND = `cpu  160 0 60 1200 0 0 0 0 0 0
cpu0 160 0 60 1200 0 0 0 0 0 0`;
const CPUINFO = 'processor\t: 0\nCPU part\t: 0xd05';

/**
 * A fake connection: it emits the output with markers according to the
 * protocol.
 *
 * **It recognises the reader by the data snippet** — whichever path is in the
 * snippet is the reader. (The markers are random, the test cannot know them
 * in advance and can only derive them from the command.)
 */
class FakeConnection {
  readonly commands: string[] = [];
  /**
   * Which path of the data snippet → what it answers.
   *
   * `null` = this section did not run;
   * **a list** (an array) = the first call gets the first entry, the second
   * call the second — `proc_stat` needs **two samples** for the difference,
   * and that is what the test wants.
   */
  bodies: Record<string, string | null | (string | null)[]> = {
    '/proc/stat': '',
    '/sys/class/devfreq/fb000000.gpu/load': '0@300000000Hz',
    '/proc/meminfo': 'MemTotal:        8107744 kB\nMemAvailable:    7655500 kB',
  };
  /** The whole round trip fails */
  failWith: Error | null = null;
  /**
   * The keyword of the snippet that swallows the "end marker".
   *
   * It simulates "the board only answered half": the start marker arrived,
   * the end marker did not.
   */
  truncate: string[] = [];
  /** How often each key was called (that decides which entry of the array is taken) */
  private readonly counters = new Map<string, number>();

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
    this.commands.push(command);
    if (this.failWith) throw this.failWith;

    // The pair of "marker + snippet" is cut out of the command
    const re = /echo '(__DBCGS_[0-9a-f]+__)';([\s\S]*?); echo '(__DBCGE_[0-9a-f]+__)'/g;
    const parts: string[] = [];
    for (const m of command.matchAll(re)) {
      const fragment = m[2] ?? '';
      const key = Object.keys(this.bodies).find((k) => fragment.includes(k));
      const body = key === undefined ? '' : this.bodyFor(key);
      if (body === null || body === undefined) continue;
      // Truncated: only the start marker is sent, **the end marker is not**
      const truncated = key !== undefined && this.truncate.some((k) => fragment.includes(k));
      if (truncated) {
        parts.push(m[1]!, body);
        continue;
      }
      parts.push(m[1]!, body, m[3]!);
    }
    return { exitCode: 0, stdout: parts.join('\n'), stderr: '', durationMs: 1, timedOut: false };
  }
}

describe('the sampler', () => {
  it('sampling a group once puts every tag its readers offer into the store', async () => {
    const store = new TagStore();
    const conn = new FakeConnection();
    const sampler = new TagSampler(PACK, conn, store);

    await sampler.sampleGroup('fast');

    expect(store.get('gpu.usage')).toBeDefined();
    expect(store.get('gpu.usage')!.value).toBe(0);
  });

  it('**a sample is bound to a tag**: core.0.usage → cpu.core.0.usage', async () => {
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
    // **not** `cpu.core.*.usage` — the wildcard segment is replaced by a concrete value
    expect(store.get('cpu.core.*.usage')).toBeUndefined();
  });

  it('a sample that cannot be bound is **not bound** (no extra tag is bound)', async () => {
    const store = new TagStore();
    const conn = new FakeConnection();
    conn.bodies['/proc/stat'] = `${STAT_FIRST}\n--- cpuinfo ---\n${CPUINFO}`;
    const sampler = new TagSampler(PACK, conn, store);

    await sampler.sampleGroup('fast');
    await sampler.sampleGroup('fast');

    // The gpu offers only duty → there is gpu.usage, there is no gpu.freq_hz
    expect(store.get('gpu.freq_hz')).toBeUndefined();
  });

  it('when a reader fails to parse → **only its own tags** report an error, the others go on', async () => {
    const store = new TagStore();
    const conn = new FakeConnection();
    conn.bodies['/sys/class/devfreq/fb000000.gpu/load'] = 'not a number';
    const sampler = new TagSampler(PACK, conn, store);

    await sampler.sampleGroup('fast');

    // "it was read but it is broken" = error (contract §2.1.1), not unavailable
    expect(store.get('gpu.usage')!.status).toBe('error');
    expect(store.get('gpu.usage')!.value).toBeNull();
    expect(store.get('gpu.usage')!.reason).toBe('parse_error');
    // The failure of the gpu **does not affect** the group of the cpu
    expect(store.get('cpu.usage')).toBeDefined();
  });

  it('the round trip fails → **every** tag of the group reports an error (it has never succeeded, so there is no old value to keep)', async () => {
    const store = new TagStore();
    const conn = new FakeConnection();
    conn.failWith = new Error('the transport broke');
    const sampler = new TagSampler(PACK, conn, store);

    await sampler.sampleGroup('fast');

    // It never succeeded → error (contract §2.1: "pending → error = the sampling itself failed")
    expect(store.get('gpu.usage')!.status).toBe('error');
    expect(store.get('cpu.usage')!.status).toBe('error');
  });

  it('**the refresh fails although it succeeded before** → it reports stale and **keeps the old value** (contract §2.1)', async () => {
    // "ok → stale = this refresh failed, but the value of the last time is kept" —
    // one hiccup of ADB may not make the gauges of the panel disappear.
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

    // The next round trip breaks
    conn.failWith = new Error('the transport broke');
    await sampler.sampleGroup('fast');

    const after = store.get('cpu.usage')!;
    expect(after.status).toBe('stale');
    expect(after.value).toBe(good);
  });

  it('**the instances of a wildcard tag are marked stale when the refresh fails** (C27 — contract §2.3: "the refresh stopped → stale")', async () => {
    // — what this case defends against —
    //
    // A whole `cpu` reader fails → **the wildcard instances** (`cpu.core.0.usage`)
    // used to **not be marked stale** → the reading stayed `ok` with the old value
    // → **the cards that depend on it are not judged degraded** → **stale data is taken for new**
    //
    // → the fix: **mark "the instances that were already read"** (**it does not guess** — it uses the ones it read)
    const store = new TagStore();
    const conn = new FakeConnection();
    conn.bodies['/proc/stat'] = [
      `${STAT_FIRST}\n--- cpuinfo ---\n${CPUINFO}`,
      `${STAT_SECOND}\n--- cpuinfo ---\n${CPUINFO}`,
    ];
    const sampler = new TagSampler(PACK, conn, store);

    await sampler.sampleGroup('fast');
    await sampler.sampleGroup('fast');
    // **The wildcard instances are already there** (they are concrete tags)
    expect(store.get('cpu.core.0.usage')!.status).toBe('ok');
    const good = store.get('cpu.core.0.usage')!.value;

    // The next round trip breaks
    conn.failWith = new Error('the transport broke');
    await sampler.sampleGroup('fast');

    const after = store.get('cpu.core.0.usage')!;
    expect(after.status).toBe('stale');
    // **The old value is kept** (contract §2.1 — one hiccup may not make the gauges disappear)
    expect(after.value).toBe(good);
  });

  it('**the first read already fails → not a single wildcard instance** (**it does not guess** — it does not invent one)', async () => {
    const store = new TagStore();
    const conn = new FakeConnection();
    conn.failWith = new Error('the transport broke');
    const sampler = new TagSampler(PACK, conn, store);

    await sampler.sampleGroup('fast');

    // **Not a single concrete instance was invented**
    expect(store.get('cpu.core.0.usage')).toBeUndefined();
    // **The one without a wildcard reports as usual**
    expect(store.get('cpu.usage')!.status).toBe('error');
  });

  it('a **timeout** is normalised to reason=timeout (fact G1: the uniform 124)', async () => {
    const store = new TagStore();
    const conn = new FakeConnection();
    conn.failWith = new Error('timeout');
    const sampler = new TagSampler(PACK, conn, store);

    await sampler.sampleGroup('fast');

    expect(store.get('gpu.usage')!.reason).toBe('timeout');
  });

  it('the first reading of proc_stat **is pending**, only the second one has a value', async () => {
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

  it('a reader without provides → the samples it produces **do not appear in the store**', async () => {
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

  it('sampling another group affects only the readers of that group', async () => {
    const store = new TagStore();
    const conn = new FakeConnection();
    const sampler = new TagSampler(PACK, conn, store);

    await sampler.sampleGroup('slow');

    expect(store.get('mem.total_bytes')).toBeDefined();
    expect(store.get('mem.total_bytes')!.value).toBe(8107744 * 1024);
    expect(store.get('gpu.usage')).toBeUndefined();
  });

  it('**a script has no remote path** → it reports honestly that nothing was pushed, it does not build a command that is bound to fail', async () => {
    // The script lives on the host, it has to be pushed to the /tmp of the board before it can run (contract §3.3).
    // The runtime has not pushed it → **the command that is bound to fail is not generated**.
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
    // **The command may not hold that script call that is bound to fail**
    expect(conn.commands.join('\n')).not.toContain('pipeline_status.sh');
  });

  it('the **truncated** section (the end marker never arrived) → it reports an error and **publishes no half data**', async () => {
    // "The board only answered half" — the 1000 of `format: integer` is cut to 100
    // Publishing it as a normal value would be a **false number** (the same argument as fact G2).
    const store = new TagStore();
    const conn = new FakeConnection();
    conn.truncate = ['gpu/load'];
    const sampler = new TagSampler(PACK, conn, store);

    await sampler.sampleGroup('fast');

    const gpu = store.get('gpu.usage')!;
    expect(gpu.status).toBe('error');
    expect(gpu.value).toBeNull();
    expect(gpu.detail).toContain('halfway');
    // The other readers go on as usual
    expect(store.get('cpu.usage')).toBeDefined();
  });

  it('an unknown group **reports an error**, it does not silently do nothing', async () => {
    const sampler = new TagSampler(PACK, new FakeConnection(), new TagStore());
    await expect(sampler.sampleGroup('nosuch')).rejects.toThrow(/nosuch/);
  });
});
