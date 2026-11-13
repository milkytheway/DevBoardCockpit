import { describe, it, expect } from 'vitest';
import { READER_KINDS, getKind, kindIds } from '../../src/main/tags/kinds';

/**
 * reader kind 注册表。
 *
 * 契约：`docs/spec/02-board-pack.md` §2.4（内置 reader kind 清单，v1）。
 *
 * **这份表是契约的一部分**——它的机器可读形态由实现层提供：
 * 每个 kind 声明「接受什么参数」「产出什么 sample」「怎么从板子上取」。
 * 没有它，规则 6（sample 存在吗）、8（参数名拼错了吗）、9（必填参数缺了吗）
 * **无从谈起**。
 */

describe('注册表', () => {
  it('恰好 8 个 kind，id 与契约 §2.4 的清单一致', () => {
    expect(kindIds()).toEqual([
      'proc_stat',
      'meminfo',
      'devfreq_load',
      'rknpu_load',
      'thermal_zone',
      'file_read',
      'exec_regex',
      'script',
    ]);
  });

  it('每个 kind 都能按 id 取到', () => {
    for (const id of kindIds()) {
      expect(getKind(id)).toBeDefined();
    }
  });

  it('取不到的 kind 返回 undefined（不抛异常）', () => {
    expect(getKind('nosuchkind')).toBeUndefined();
  });
});

describe('每个 kind 产出的 sample（契约 §2.4 的表）', () => {
  const expected: Record<string, string[]> = {
    proc_stat: ['usage', 'core.*.usage', 'core.*.cluster'],
    meminfo: ['total_bytes', 'available_bytes', 'used_bytes', 'usage'],
    devfreq_load: ['duty', 'freq_hz'],
    rknpu_load: ['usage', 'core.*.usage'],
    thermal_zone: ['zone.*'],
    file_read: ['value'],
    exec_regex: ['value'],
    script: ['value'],
  };

  for (const [id, samples] of Object.entries(expected)) {
    it(`${id} 产出 ${samples.join(' / ')}`, () => {
      expect(getKind(id)!.samples).toEqual(samples);
    });
  }

  it('script 的 sample 段数不限（契约 §3.3 末段）', () => {
    // script 的 sample 来自 JSON 的键，所以**不能**写成固定清单。
    // 契约原话：「`script` 是唯一一个 sample 名段数不限的 kind」。
    expect(getKind('script')!.samples).toEqual(['value']);
    expect(getKind('script')!.unboundedSamples).toBe(true);
    for (const id of kindIds().filter((k) => k !== 'script')) {
      // 字段是可选的（没写就是「不是」）——`?? false` 把「没写」与「写了 false」
      // 看成同一件事：**只有 script 的 sample 段数不限**。
      expect(getKind(id)!.unboundedSamples ?? false).toBe(false);
    }
  });
});

describe('每个 kind 的参数（契约 §2.4 的表）', () => {
  it('proc_stat 收 stat_path 与 cpuinfo_path', () => {
    const kind = getKind('proc_stat')!;
    expect(Object.keys(kind.params).sort()).toEqual(['cpuinfo_path', 'stat_path']);
    expect(kind.params['stat_path'].required).toBe(true);
    expect(kind.params['cpuinfo_path'].required).toBe(true);
  });

  it('meminfo 收 path', () => {
    const kind = getKind('meminfo')!;
    expect(Object.keys(kind.params)).toEqual(['path']);
    expect(kind.params['path'].required).toBe(true);
  });

  it('devfreq_load 的 measure 有取值域，且**在 schema 里不是必填**', () => {
    // 契约 §2.4 末段：「**`measure` 不是可选的**：绑到 `*.usage` 而没声明
    // `measure`，校验器报错。沉默的默认值会骗人——『没说是利用率』
    // 不能当成『是利用率』。」
    //
    // **但这条强制是「上下文相关」的**：只提供 `freq_hz` 的 reader 不需要它。
    // 所以它在 schema 里是可选的，由**规则 4** 在「绑到 *.usage」时强制——
    // 若在 schema 里写成必填，「没声明 measure」会被报成规则 9，
    // **规则 4 就永远走不到**（两条规则管同一件事）。
    const kind = getKind('devfreq_load')!;
    expect(kind.params['measure'].required ?? false).toBe(false);
    expect(kind.params['measure'].values).toEqual(['utilization', 'duty_cycle']);
  });

  it('rknpu_load 收 path', () => {
    expect(Object.keys(getKind('rknpu_load')!.params)).toEqual(['path']);
  });

  it('thermal_zone 收 glob 与 type_map', () => {
    const kind = getKind('thermal_zone')!;
    expect(Object.keys(kind.params).sort()).toEqual(['glob', 'type_map']);
    expect(kind.params['glob'].required).toBe(true);
    expect(kind.params['type_map'].required).toBe(true);
  });

  it('file_read 的 path 与 glob 是**二选一**', () => {
    // 契约 §2.4：`path`/`glob`——不是一个必填、一个可选，
    // 而是「这两个里至少给一个」。
    const kind = getKind('file_read')!;
    expect(kind.params['path'].required).toBe(false);
    expect(kind.params['glob'].required).toBe(false);
    expect(kind.params['path'].oneOf).toEqual(['path', 'glob']);
  });

  it('exec_regex 收 command 与 pattern', () => {
    const kind = getKind('exec_regex')!;
    expect(Object.keys(kind.params).sort()).toEqual(['command', 'format', 'pattern']);
    expect(kind.params['command'].required).toBe(true);
    expect(kind.params['pattern'].required).toBe(true);
  });

  it('script 收 path 与 interpreter', () => {
    const kind = getKind('script')!;
    expect(Object.keys(kind.params).sort()).toEqual(['format', 'interpreter', 'path']);
    expect(kind.params['path'].required).toBe(true);
    expect(kind.params['interpreter'].required).toBe(true);
  });
});

describe('取数片段', () => {
  it('file_read 的片段含路径', () => {
    const frag = getKind('file_read')!.fetch({ path: '/sys/class/backlight/backlight/brightness' });
    expect(frag).toContain('/sys/class/backlight/backlight/brightness');
  });

  it('exec_regex 的片段含命令', () => {
    const frag = getKind('exec_regex')!.fetch({ command: 'cat /proc/uptime', pattern: '^([0-9.]+)' });
    expect(frag).toContain('cat /proc/uptime');
  });

  it('script 的片段含解释器与**远端**路径', () => {
    // 包里写的是**宿主**路径；脚本要先推到板子上（契约 §3.3）。
    // 所以取数时用的是运行时给的远端路径。
    const frag = getKind('script')!.fetch({
      path: 'scripts/pipeline_status.sh',
      interpreter: '/bin/sh',
      remote_path: '/tmp/devboard-123/pipeline_status.sh',
    });
    expect(frag).toContain('/bin/sh');
    expect(frag).toContain('/tmp/devboard-123/pipeline_status.sh');
  });

  it('script 没给远端路径时退回宿主路径（总比什么都不做要好）', () => {
    const frag = getKind('script')!.fetch({
      path: 'scripts/pipeline_status.sh',
      interpreter: '/bin/sh',
    });
    expect(frag).toContain('scripts/pipeline_status.sh');
  });

  it('meminfo / devfreq_load / rknpu_load 的片段含各自的路径', () => {
    expect(getKind('meminfo')!.fetch({ path: '/proc/meminfo' })).toContain('/proc/meminfo');
    expect(getKind('devfreq_load')!.fetch({ path: '/x/load', measure: 'utilization' })).toContain('/x/load');
    expect(getKind('rknpu_load')!.fetch({ path: '/y/load' })).toContain('/y/load');
  });

  it('proc_stat 的片段含**两个**路径', () => {
    const frag = getKind('proc_stat')!.fetch({
      stat_path: '/proc/stat',
      cpuinfo_path: '/proc/cpuinfo',
    });
    expect(frag).toContain('/proc/stat');
    expect(frag).toContain('/proc/cpuinfo');
  });

  it('thermal_zone 的片段含 glob', () => {
    const frag = getKind('thermal_zone')!.fetch({
      glob: '/sys/class/thermal/thermal_zone*',
      type_map: { 'soc-thermal': 'soc' },
    });
    expect(frag).toContain('/sys/class/thermal/thermal_zone*');
  });

  it('取数片段是**一行**（串口一次往返只能是一行命令，事实 S6）', () => {
    const frags = [
      getKind('file_read')!.fetch({ path: '/x' }),
      getKind('meminfo')!.fetch({ path: '/proc/meminfo' }),
      getKind('devfreq_load')!.fetch({ path: '/x/load', measure: 'utilization' }),
      getKind('rknpu_load')!.fetch({ path: '/y/load' }),
      getKind('proc_stat')!.fetch({ stat_path: '/proc/stat', cpuinfo_path: '/proc/cpuinfo' }),
      getKind('thermal_zone')!.fetch({ glob: '/z*', type_map: {} }),
    ];
    for (const frag of frags) {
      expect(frag.includes('\n')).toBe(false);
    }
  });
});

describe('两次采样的 kind', () => {
  it('只有 proc_stat 需要两次采样', () => {
    // 契约 §2.4：`proc_stat` **需要两次采样**，首次为 pending。
    expect(getKind('proc_stat')!.needsTwoSamples).toBe(true);
    for (const id of kindIds().filter((k) => k !== 'proc_stat')) {
      expect(getKind(id)!.needsTwoSamples ?? false).toBe(false);
    }
  });
});

describe('注册表本身', () => {
  it('每个 kind 的 id 与注册表的键一致', () => {
    for (const kind of READER_KINDS) {
      expect(kind.id).toBeTruthy();
    }
    expect(new Set(READER_KINDS.map((k) => k.id)).size).toBe(READER_KINDS.length);
  });
});
