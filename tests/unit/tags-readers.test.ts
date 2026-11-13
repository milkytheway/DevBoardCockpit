import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getKind, type ReaderContext } from '../../src/main/tags/kinds';

/**
 * 8 个 reader kind 的**解析器**——用**真机样本**做黄金向量。
 *
 * 样本在 `fixtures/board/`（2026-11-13 直接从真板上采的）。
 * 逐条结论见 `docs/06-契约核对.md` §五。
 *
 * ── 两条底线 ──
 *
 * **1. 读不到的东西不是 0**（事实 G2）：解析不出来 → `unavailable`，
 * 绝不填 0、绝不返回 NaN。
 * **2. 解析是纯函数**（N1）：同样的输入给同样的输出——
 * 唯一允许的状态是「两次采样之间的历史」，且由 runtime 传进来。
 */

const FIXTURES = join(__dirname, '../../fixtures/board');
const snapshot = readFileSync(join(FIXTURES, 'rk3588-atk-snapshot.txt'), 'utf8');
const devfreq = readFileSync(join(FIXTURES, 'rk3588-atk-devfreq.txt'), 'utf8');
const statPair = readFileSync(join(FIXTURES, 'rk3588-atk-proc-stat-pair.txt'), 'utf8');

/** 把样本按 `###SECTION` 切开 */
function sections(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let current = '';
  let lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('###')) {
      if (current) out[current] = lines.join('\n');
      current = line.slice(3);
      lines = [];
      continue;
    }
    lines.push(line);
  }
  if (current) out[current] = lines.join('\n');
  return out;
}

const snap = sections(snapshot);
const dev = sections(devfreq);
const pair = sections(statPair);

/** 一次解析用的上下文（状态由 runtime 传进来，不藏在模块里） */
function ctx(): ReaderContext {
  return { state: {} };
}

describe('proc_stat · 真机样本', () => {
  const kind = getKind('proc_stat')!;
  const SEP = '--- cpuinfo ---';
  const args = { stat_path: '/proc/stat', cpuinfo_path: '/proc/cpuinfo' };
  const raw = (stat: string) => `${stat}\n${SEP}\n${snap['CPUINFO'] ?? ''}`;

  it('**首读是 pending，不是 0**（规则 5）', () => {
    const result = kind.parse(raw(pair['FIRST'] ?? ''), args, ctx());
    expect(result.status).toBe('pending');
    // 关键：不是「ok + 0」
    expect(result).not.toHaveProperty('samples');
  });

  it('第二次采样才出值', () => {
    const c = ctx();
    expect(kind.parse(raw(pair['FIRST'] ?? ''), args, c).status).toBe('pending');
    const result = kind.parse(raw(pair['SECOND'] ?? ''), args, c);
    expect(result.status).toBe('ok');
  });

  it('cpu.usage 是两次采样做差（5/2403）', () => {
    const c = ctx();
    kind.parse(raw(pair['FIRST'] ?? ''), args, c);
    const result = kind.parse(raw(pair['SECOND'] ?? ''), args, c);
    expect(result.status).toBe('ok');
    const samples = (result as { samples: Record<string, number> }).samples;
    expect(samples['usage']).toBeCloseTo((5 / 2403) * 100, 8);
  });

  it('每个核的占用率也做差（cpu0 是 3/301）', () => {
    const c = ctx();
    kind.parse(raw(pair['FIRST'] ?? ''), args, c);
    const result = kind.parse(raw(pair['SECOND'] ?? ''), args, c);
    const samples = (result as { samples: Record<string, number> }).samples;
    expect(samples['core.0.usage']).toBeCloseTo((3 / 301) * 100, 8);
    expect(samples['core.1.usage']).toBeCloseTo((1 / 301) * 100, 8);
  });

  it('核名来自 /proc/cpuinfo 的 CPU part（A55×4 + A76×4）', () => {
    const c = ctx();
    kind.parse(raw(pair['FIRST'] ?? ''), args, c);
    const result = kind.parse(raw(pair['SECOND'] ?? ''), args, c);
    const samples = (result as { samples: Record<string, string | number> }).samples;
    expect(samples['core.0.cluster']).toBe('A55');
    expect(samples['core.3.cluster']).toBe('A55');
    expect(samples['core.4.cluster']).toBe('A76');
    expect(samples['core.7.cluster']).toBe('A76');
  });

  it('计数器**倒退**时报 error，不是负数（RF-3）', () => {
    const c = ctx();
    kind.parse(raw(pair['FIRST'] ?? ''), args, c);
    // 第二次给一个**更小**的计数器（模拟重启）
    const backwards = (pair['FIRST'] ?? '').replace('48866', '1');
    const result = kind.parse(raw(backwards), args, c);
    // 「读出来了但坏了」= error（契约 §2.1.1）；**不是** unavailable
    expect(result.status).toBe('error');
    expect(result).not.toHaveProperty('samples');
  });

  it('**窗口太短**（两次采样之间一个 tick 都没过）→ pending，不是 error', () => {
    // 背靠背采两次可能一个 tick 都没过（/proc/stat 是 10ms 一格）→
    // 窗口长度为 0，算不出占用率。
    // 这是 **pending** 不是 error：**什么都没坏**，只是这一轮窗口不够长，
    // 基准留着，下一轮就能算出来。（报 error 会让探针判红；报 0 是假数。）
    const c = ctx();
    kind.parse(raw(pair['FIRST'] ?? ''), args, c);
    const same = kind.parse(raw(pair['FIRST'] ?? ''), args, c);
    expect(same.status).toBe('pending');
    expect(same).not.toHaveProperty('samples');
  });

  it('空输入报 unavailable，不是 0', () => {
    const result = kind.parse('', args, ctx());
    expect(result.status).toBe('unavailable');
  });
});

describe('meminfo · 真机样本', () => {
  const kind = getKind('meminfo')!;
  const args = { path: '/proc/meminfo' };

  it('kB → byte（×1024），单位换算是 reader 的责任', () => {
    const result = kind.parse(snap['MEM'] ?? '', args, ctx());
    expect(result.status).toBe('ok');
    const s = (result as { samples: Record<string, number> }).samples;
    expect(s['total_bytes']).toBe(8107744 * 1024);
    expect(s['available_bytes']).toBe(7655500 * 1024);
  });

  it('used = total − available', () => {
    const result = kind.parse(snap['MEM'] ?? '', args, ctx());
    const s = (result as { samples: Record<string, number> }).samples;
    expect(s['used_bytes']).toBe((8107744 - 7655500) * 1024);
  });

  it('usage 是百分比', () => {
    const result = kind.parse(snap['MEM'] ?? '', args, ctx());
    const s = (result as { samples: Record<string, number> }).samples;
    expect(s['usage']).toBeCloseTo(((8107744 - 7655500) / 8107744) * 100, 8);
  });

  it('读不到 MemTotal 报 error，不是 0', () => {
    const result = kind.parse('nothing here', args, ctx());
    expect(result.status).toBe('error');
  });

  it('**MemAvailable 缺了**报 error，**不许拿 0 顶上**（否则占用率变成 100%）', () => {
    const result = kind.parse('MemTotal:        8107744 kB', args, ctx());
    expect(result.status).toBe('error');
    expect(result).not.toHaveProperty('samples');
  });
});

describe('devfreq_load · 真机样本', () => {
  const kind = getKind('devfreq_load')!;
  const args = { path: '/x/load', measure: 'duty_cycle' };

  it('NPU 的 devfreq：duty=100、freq=1000000000', () => {
    const result = kind.parse(dev['NPU_DEVFRQ'] ?? '', args, ctx());
    expect(result.status).toBe('ok');
    const s = (result as { samples: Record<string, number> }).samples;
    expect(s['duty']).toBe(100);
    expect(s['freq_hz']).toBe(1000000000);
  });

  it('GPU 的 devfreq：duty=0、freq=300000000', () => {
    const result = kind.parse(dev['GPU_DEVFRQ'] ?? '', args, ctx());
    const s = (result as { samples: Record<string, number> }).samples;
    expect(s['duty']).toBe(0);
    expect(s['freq_hz']).toBe(300000000);
  });

  it('格式不对报 error，不是 0', () => {
    const result = kind.parse('not a number', args, ctx());
    expect(result.status).toBe('error');
  });
});

describe('rknpu_load · 真机样本', () => {
  const kind = getKind('rknpu_load')!;
  const args = { path: '/sys/kernel/debug/rknpu/load' };

  it('三个核各 0%，末尾的逗号要认', () => {
    const result = kind.parse(dev['NPU_RKNPU'] ?? '', args, ctx());
    expect(result.status).toBe('ok');
    const s = (result as { samples: Record<string, number> }).samples;
    expect(s['usage']).toBe(0);
    expect(s['core.0.usage']).toBe(0);
    expect(s['core.1.usage']).toBe(0);
    expect(s['core.2.usage']).toBe(0);
  });

  it('usage 是各核的最大值', () => {
    const result = kind.parse('NPU load:  Core0: 12%, Core1: 30%, Core2: 5%,', args, ctx());
    const s = (result as { samples: Record<string, number> }).samples;
    expect(s['usage']).toBe(30);
  });

  it('读不到报 unavailable，不是 0', () => {
    const result = kind.parse('', args, ctx());
    expect(result.status).toBe('unavailable');
  });
});

describe('thermal_zone · 真机样本', () => {
  const kind = getKind('thermal_zone')!;
  const args = {
    glob: '/sys/class/thermal/thermal_zone*',
    type_map: { 'soc-thermal': 'soc', 'gpu-thermal': 'gpu', 'npu-thermal': 'npu' },
  };

  it('毫度 → 摄氏度（÷1000），按 type_map 归并', () => {
    const result = kind.parse(snap['TEMP'] ?? '', args, ctx());
    expect(result.status).toBe('ok');
    const s = (result as { samples: Record<string, number> }).samples;
    expect(s['zone.soc']).toBeCloseTo(34.23, 8);
    expect(s['zone.gpu']).toBeCloseTo(33.307, 8);
    expect(s['zone.npu']).toBeCloseTo(34.23, 8);
  });

  it('type_map 里没有的 zone 被跳过（板上有的 zone 比映射多）', () => {
    const result = kind.parse(snap['TEMP'] ?? '', args, ctx());
    const s = (result as { samples: Record<string, number> }).samples;
    expect(s['zone.bigcore0']).toBeUndefined();
    expect(s['zone.center']).toBeUndefined();
  });

  it('一个 zone 都认不出来报 error', () => {
    const result = kind.parse('nothing', args, ctx());
    expect(result.status).toBe('error');
  });
});

describe('file_read · 逃生门 1', () => {
  const kind = getKind('file_read')!;

  it('整行去空白', () => {
    const result = kind.parse('  ATK-DLRK3588 Board\n', { path: '/x' }, ctx());
    const s = (result as { samples: Record<string, string> }).samples;
    expect(s['value']).toBe('ATK-DLRK3588 Board');
  });

  it('format: integer 读出数字', () => {
    const result = kind.parse('200\n', { path: '/x', format: 'integer' }, ctx());
    const s = (result as { samples: Record<string, number> }).samples;
    expect(s['value']).toBe(200);
  });

  it('strip_trailing_null 剥掉设备树模型的 NUL', () => {
    // 设备树模型的文件**末尾真的带一个 NUL**（实测 `/proc/device-tree/model`）——
    // 所以这里用真的 NUL 字符，不是空格。
    const result = kind.parse('ATK-DLRK3588 Board\u0000', { path: '/x', strip_trailing_null: true }, ctx());
    const s = (result as { samples: Record<string, string> }).samples;
    expect(s['value']).toBe('ATK-DLRK3588 Board');
  });

  it('不剥 NUL 时它会留在值里（剥不剥是包的选择，不是隐式的）', () => {
    const result = kind.parse('ATK-DLRK3588 Board\u0000', { path: '/x' }, ctx());
    const s = (result as { samples: Record<string, string> }).samples;
    expect(s['value']).not.toBe('ATK-DLRK3588 Board');
  });

  it('空文件报 unavailable，不是空串', () => {
    const result = kind.parse('', { path: '/x' }, ctx());
    expect(result.status).toBe('unavailable');
  });
});

describe('exec_regex · 逃生门 2', () => {
  const kind = getKind('exec_regex')!;

  it('取第一个捕获组', () => {
    const result = kind.parse('12345.67 89000.00', { command: 'cat /proc/uptime', pattern: '^([0-9.]+)' }, ctx());
    expect(result.status).toBe('ok');
    const s = (result as { samples: Record<string, string> }).samples;
    expect(s['value']).toBe('12345.67');
  });

  it('不匹配报 error，不是 0', () => {
    const result = kind.parse('nothing', { command: 'x', pattern: '^([0-9.]+)' }, ctx());
    expect(result.status).toBe('error');
  });
});

describe('script · 逃生门 3', () => {
  const kind = getKind('script')!;

  it('JSON 的每个键都是一个 sample', () => {
    const result = kind.parse('{"fps": 30, "running": true}', { path: 's.sh', interpreter: '/bin/sh' }, ctx());
    expect(result.status).toBe('ok');
    const s = (result as { samples: Record<string, number | boolean> }).samples;
    expect(s['fps']).toBe(30);
    expect(s['running']).toBe(true);
  });

  it('JSON 坏了报 error', () => {
    const result = kind.parse('{not json', { path: 's.sh', interpreter: '/bin/sh' }, ctx());
    expect(result.status).toBe('error');
  });
});

describe('畸形输入不许炸（N2 · RF-1）', () => {
  // **「资源不在」与「读出来了但坏了」是两件事**（契约 §2.1）：
  // - `unavailable` = 资源此刻不在（路径不存在、设备被拔、挂载丢失）
  // - `error` = 资源在，但读出来的东西坏了（解析失败、越界、类型不符）
  //
  // **两者都不许填 0**——但它们**不是同一件事**，报错了得让人知道是哪一种。
  const cases: { kind: string; args: Record<string, unknown>; raw: string; status: string }[] = [
    // 读到了东西但坏了 → error
    { kind: 'proc_stat', args: { stat_path: '/x', cpuinfo_path: '/y' }, raw: 'garbage', status: 'error' },
    { kind: 'meminfo', args: { path: '/x' }, raw: '\u0000\u0001binary', status: 'error' },
    { kind: 'devfreq_load', args: { path: '/x', measure: 'duty_cycle' }, raw: 'x@y', status: 'error' },
    { kind: 'rknpu_load', args: { path: '/x' }, raw: 'Core0: abc%', status: 'error' },
    { kind: 'thermal_zone', args: { glob: '/x', type_map: {} }, raw: '=== not a zone', status: 'error' },
    { kind: 'exec_regex', args: { command: 'x', pattern: '(' }, raw: 'x', status: 'error' },
    { kind: 'script', args: { path: 's', interpreter: '/bin/sh' }, raw: 'null', status: 'error' },
    // 什么都没有 → 资源不在 → unavailable
    { kind: 'proc_stat', args: { stat_path: '/x', cpuinfo_path: '/y' }, raw: '', status: 'unavailable' },
    { kind: 'meminfo', args: { path: '/x' }, raw: '', status: 'unavailable' },
    { kind: 'rknpu_load', args: { path: '/x' }, raw: '', status: 'unavailable' },
    { kind: 'file_read', args: { path: '/x' }, raw: '   ', status: 'unavailable' },
  ];

  for (const c of cases) {
    it(`${c.kind} 遇到畸形输入报 ${c.status}，不抛异常、不填 0`, () => {
      const kind = getKind(c.kind)!;
      let result: unknown;
      expect(() => {
        result = kind.parse(c.raw, c.args, ctx());
      }).not.toThrow();
      expect((result as { status: string }).status).toBe(c.status);
      expect(result).not.toHaveProperty('samples');
    });
  }
});
