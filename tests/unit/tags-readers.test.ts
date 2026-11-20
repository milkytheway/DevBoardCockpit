import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getKind, type ReaderContext } from '../../src/main/tags/kinds';

/**
 * The **parsers** of the eight reader kinds, with the **samples of a real
 * board** as golden vectors.
 *
 * The samples are in `fixtures/board/` (taken from the real board on
 * 2026-11-13).
 *
 * Two bottom lines:
 *
 * **1. A thing that cannot be read is not 0** (fact G2): when it cannot be
 * parsed → `unavailable`, never a 0 and never a NaN.
 * **2. The parsing is a pure function** (N1): the same input gives the same
 * output — the only state it may hold is "the history between the two
 * samples", and the runtime passes that in.
 */

const FIXTURES = join(__dirname, '../../fixtures/board');
const snapshot = readFileSync(join(FIXTURES, 'rk3588-atk-snapshot.txt'), 'utf8');
const devfreq = readFileSync(join(FIXTURES, 'rk3588-atk-devfreq.txt'), 'utf8');
const statPair = readFileSync(join(FIXTURES, 'rk3588-atk-proc-stat-pair.txt'), 'utf8');

/** Cuts the sample by `###SECTION` */
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

/** The context of one parsing (the state comes from the runtime, it is not hidden in the module) */
function ctx(): ReaderContext {
  return { state: {} };
}

describe('proc_stat · a sample from the board', () => {
  const kind = getKind('proc_stat')!;
  const SEP = '--- cpuinfo ---';
  const args = { stat_path: '/proc/stat', cpuinfo_path: '/proc/cpuinfo' };
  const raw = (stat: string) => `${stat}\n${SEP}\n${snap['CPUINFO'] ?? ''}`;

  it('**the first reading is pending, not 0** (rule 5)', () => {
    const result = kind.parse(raw(pair['FIRST'] ?? ''), args, ctx());
    expect(result.status).toBe('pending');
    // The point: not "ok + 0"
    expect(result).not.toHaveProperty('samples');
  });

  it('only the second sample yields a value', () => {
    const c = ctx();
    expect(kind.parse(raw(pair['FIRST'] ?? ''), args, c).status).toBe('pending');
    const result = kind.parse(raw(pair['SECOND'] ?? ''), args, c);
    expect(result.status).toBe('ok');
  });

  it('cpu.usage is the difference of two samples (5/2403)', () => {
    const c = ctx();
    kind.parse(raw(pair['FIRST'] ?? ''), args, c);
    const result = kind.parse(raw(pair['SECOND'] ?? ''), args, c);
    expect(result.status).toBe('ok');
    const samples = (result as { samples: Record<string, number> }).samples;
    expect(samples['usage']).toBeCloseTo((5 / 2403) * 100, 8);
  });

  it('the usage of every core is a difference as well (cpu0 is 3/301)', () => {
    const c = ctx();
    kind.parse(raw(pair['FIRST'] ?? ''), args, c);
    const result = kind.parse(raw(pair['SECOND'] ?? ''), args, c);
    const samples = (result as { samples: Record<string, number> }).samples;
    expect(samples['core.0.usage']).toBeCloseTo((3 / 301) * 100, 8);
    expect(samples['core.1.usage']).toBeCloseTo((1 / 301) * 100, 8);
  });

  it('the core names come from the CPU part of /proc/cpuinfo (A55×4 + A76×4)', () => {
    const c = ctx();
    kind.parse(raw(pair['FIRST'] ?? ''), args, c);
    const result = kind.parse(raw(pair['SECOND'] ?? ''), args, c);
    const samples = (result as { samples: Record<string, string | number> }).samples;
    expect(samples['core.0.cluster']).toBe('A55');
    expect(samples['core.3.cluster']).toBe('A55');
    expect(samples['core.4.cluster']).toBe('A76');
    expect(samples['core.7.cluster']).toBe('A76');
  });

  it('when a counter **goes backwards** it reports an error, not a negative number (RF-3)', () => {
    const c = ctx();
    kind.parse(raw(pair['FIRST'] ?? ''), args, c);
    // The second time it gets a **smaller** counter (it simulates a restart)
    const backwards = (pair['FIRST'] ?? '').replace('48866', '1');
    const result = kind.parse(raw(backwards), args, c);
    // "it was read but it is broken" = error (contract §2.1.1); **not** unavailable
    expect(result.status).toBe('error');
    expect(result).not.toHaveProperty('samples');
  });

  it('**the window is too short** (not a single tick passed between the two samples) → pending, not an error', () => {
    // Two samples back to back may not even span a single tick (/proc/stat has a tick every 10ms) →
    // the window has a length of 0 and the usage cannot be computed.
    // This is **pending**, not error: **nothing is broken**, the window of this round is simply too short,
    // the baseline stays and the next round can compute it. (Reporting an error would make the probe red; reporting 0 would be a false number.)
    const c = ctx();
    kind.parse(raw(pair['FIRST'] ?? ''), args, c);
    const same = kind.parse(raw(pair['FIRST'] ?? ''), args, c);
    expect(same.status).toBe('pending');
    expect(same).not.toHaveProperty('samples');
  });

  it('an empty input reports unavailable, not 0', () => {
    const result = kind.parse('', args, ctx());
    expect(result.status).toBe('unavailable');
  });
});

describe('meminfo · a sample from the board', () => {
  const kind = getKind('meminfo')!;
  const args = { path: '/proc/meminfo' };

  it('kB → byte (×1024), the conversion of the unit is the responsibility of the reader', () => {
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

  it('the usage is a percentage', () => {
    const result = kind.parse(snap['MEM'] ?? '', args, ctx());
    const s = (result as { samples: Record<string, number> }).samples;
    expect(s['usage']).toBeCloseTo(((8107744 - 7655500) / 8107744) * 100, 8);
  });

  it('when MemTotal cannot be read it reports an error, not 0', () => {
    const result = kind.parse('nothing here', args, ctx());
    expect(result.status).toBe('error');
  });

  it('a **missing MemAvailable** reports an error, **it may not be replaced by 0** (otherwise the usage becomes 100%)', () => {
    const result = kind.parse('MemTotal:        8107744 kB', args, ctx());
    expect(result.status).toBe('error');
    expect(result).not.toHaveProperty('samples');
  });
});

describe('devfreq_load · a sample from the board', () => {
  const kind = getKind('devfreq_load')!;
  const args = { path: '/x/load', measure: 'duty_cycle' };

  it('the devfreq of the NPU: duty=100, freq=1000000000', () => {
    const result = kind.parse(dev['NPU_DEVFRQ'] ?? '', args, ctx());
    expect(result.status).toBe('ok');
    const s = (result as { samples: Record<string, number> }).samples;
    expect(s['duty']).toBe(100);
    expect(s['freq_hz']).toBe(1000000000);
  });

  it('the devfreq of the GPU: duty=0, freq=300000000', () => {
    const result = kind.parse(dev['GPU_DEVFRQ'] ?? '', args, ctx());
    const s = (result as { samples: Record<string, number> }).samples;
    expect(s['duty']).toBe(0);
    expect(s['freq_hz']).toBe(300000000);
  });

  it('a wrong format reports an error, not 0', () => {
    const result = kind.parse('not a number', args, ctx());
    expect(result.status).toBe('error');
  });
});

describe('rknpu_load · a sample from the board', () => {
  const kind = getKind('rknpu_load')!;
  const args = { path: '/sys/kernel/debug/rknpu/load' };

  it('three cores at 0% each, the trailing comma has to be recognised', () => {
    const result = kind.parse(dev['NPU_RKNPU'] ?? '', args, ctx());
    expect(result.status).toBe('ok');
    const s = (result as { samples: Record<string, number> }).samples;
    expect(s['usage']).toBe(0);
    expect(s['core.0.usage']).toBe(0);
    expect(s['core.1.usage']).toBe(0);
    expect(s['core.2.usage']).toBe(0);
  });

  it('the usage is the maximum of the cores', () => {
    const result = kind.parse('NPU load:  Core0: 12%, Core1: 30%, Core2: 5%,', args, ctx());
    const s = (result as { samples: Record<string, number> }).samples;
    expect(s['usage']).toBe(30);
  });

  it('when it cannot be read it reports unavailable, not 0', () => {
    const result = kind.parse('', args, ctx());
    expect(result.status).toBe('unavailable');
  });
});

describe('thermal_zone · a sample from the board', () => {
  const kind = getKind('thermal_zone')!;
  const args = {
    glob: '/sys/class/thermal/thermal_zone*',
    type_map: { 'soc-thermal': 'soc', 'gpu-thermal': 'gpu', 'npu-thermal': 'npu' },
  };

  it('millidegrees → degrees Celsius (÷1000), merged by type_map', () => {
    const result = kind.parse(snap['TEMP'] ?? '', args, ctx());
    expect(result.status).toBe('ok');
    const s = (result as { samples: Record<string, number> }).samples;
    expect(s['zone.soc']).toBeCloseTo(34.23, 8);
    expect(s['zone.gpu']).toBeCloseTo(33.307, 8);
    expect(s['zone.npu']).toBeCloseTo(34.23, 8);
  });

  it('a zone that is not in the type_map is skipped (the board has more zones than the map)', () => {
    const result = kind.parse(snap['TEMP'] ?? '', args, ctx());
    const s = (result as { samples: Record<string, number> }).samples;
    expect(s['zone.bigcore0']).toBeUndefined();
    expect(s['zone.center']).toBeUndefined();
  });

  it('when not a single zone can be recognised it reports an error', () => {
    const result = kind.parse('nothing', args, ctx());
    expect(result.status).toBe('error');
  });
});

describe('file_read · escape hatch 1', () => {
  const kind = getKind('file_read')!;

  it('the whole line is trimmed', () => {
    const result = kind.parse('  ATK-DLRK3588 Board\n', { path: '/x' }, ctx());
    const s = (result as { samples: Record<string, string> }).samples;
    expect(s['value']).toBe('ATK-DLRK3588 Board');
  });

  it('format: integer reads out a number', () => {
    const result = kind.parse('200\n', { path: '/x', format: 'integer' }, ctx());
    const s = (result as { samples: Record<string, number> }).samples;
    expect(s['value']).toBe(200);
  });

  it('strip_trailing_null removes the NUL of the device tree model', () => {
    // The file of the device tree model **really ends with a NUL** (measured at `/proc/device-tree/model`) —
    // so a real NUL character is used here, not a space.
    const result = kind.parse('ATK-DLRK3588 Board\u0000', { path: '/x', strip_trailing_null: true }, ctx());
    const s = (result as { samples: Record<string, string> }).samples;
    expect(s['value']).toBe('ATK-DLRK3588 Board');
  });

  it('without stripping the NUL it stays in the value (whether it is stripped is the choice of the pack, not something implicit)', () => {
    const result = kind.parse('ATK-DLRK3588 Board\u0000', { path: '/x' }, ctx());
    const s = (result as { samples: Record<string, string> }).samples;
    expect(s['value']).not.toBe('ATK-DLRK3588 Board');
  });

  it('an empty file reports unavailable, not an empty string', () => {
    const result = kind.parse('', { path: '/x' }, ctx());
    expect(result.status).toBe('unavailable');
  });
});

describe('exec_regex · escape hatch 2', () => {
  const kind = getKind('exec_regex')!;

  it('it takes the first capture group', () => {
    const result = kind.parse('12345.67 89000.00', { command: 'cat /proc/uptime', pattern: '^([0-9.]+)' }, ctx());
    expect(result.status).toBe('ok');
    const s = (result as { samples: Record<string, string> }).samples;
    expect(s['value']).toBe('12345.67');
  });

  it('when it does not match it reports an error, not 0', () => {
    const result = kind.parse('nothing', { command: 'x', pattern: '^([0-9.]+)' }, ctx());
    expect(result.status).toBe('error');
  });
});

describe('script · escape hatch 3', () => {
  const kind = getKind('script')!;

  it('every key of the JSON is one sample', () => {
    const result = kind.parse('{"fps": 30, "running": true}', { path: 's.sh', interpreter: '/bin/sh' }, ctx());
    expect(result.status).toBe('ok');
    const s = (result as { samples: Record<string, number | boolean> }).samples;
    expect(s['fps']).toBe(30);
    expect(s['running']).toBe(true);
  });

  it('a broken JSON reports an error', () => {
    const result = kind.parse('{not json', { path: 's.sh', interpreter: '/bin/sh' }, ctx());
    expect(result.status).toBe('error');
  });
});

describe('a malformed input may not blow up (N2 · RF-1)', () => {
  // **"the resource is not there" and "it was read but it is broken" are two different things** (contract §2.1):
  // - `unavailable` = the resource is not there at this moment (the path does not exist, the device was pulled, the mount is gone)
  // - `error` = the resource is there, but what was read is broken (the parse failed, it is out of range, the type does not fit)
  //
  // **Neither may be filled with 0** — but they are **not the same thing**, and the report has to say which one it is.
  const cases: { kind: string; args: Record<string, unknown>; raw: string; status: string }[] = [
    // Something was read but it is broken → error
    { kind: 'proc_stat', args: { stat_path: '/x', cpuinfo_path: '/y' }, raw: 'garbage', status: 'error' },
    { kind: 'meminfo', args: { path: '/x' }, raw: '\u0000\u0001binary', status: 'error' },
    { kind: 'devfreq_load', args: { path: '/x', measure: 'duty_cycle' }, raw: 'x@y', status: 'error' },
    { kind: 'rknpu_load', args: { path: '/x' }, raw: 'Core0: abc%', status: 'error' },
    { kind: 'thermal_zone', args: { glob: '/x', type_map: {} }, raw: '=== not a zone', status: 'error' },
    { kind: 'exec_regex', args: { command: 'x', pattern: '(' }, raw: 'x', status: 'error' },
    { kind: 'script', args: { path: 's', interpreter: '/bin/sh' }, raw: 'null', status: 'error' },
    // Nothing at all → the resource is not there → unavailable
    { kind: 'proc_stat', args: { stat_path: '/x', cpuinfo_path: '/y' }, raw: '', status: 'unavailable' },
    { kind: 'meminfo', args: { path: '/x' }, raw: '', status: 'unavailable' },
    { kind: 'rknpu_load', args: { path: '/x' }, raw: '', status: 'unavailable' },
    { kind: 'file_read', args: { path: '/x' }, raw: '   ', status: 'unavailable' },
  ];

  for (const c of cases) {
    it(`${c.kind} reports ${c.status} on a malformed input, it throws no exception and does not fill in 0`, () => {
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
