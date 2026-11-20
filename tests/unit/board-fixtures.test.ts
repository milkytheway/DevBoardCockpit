import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLsLines } from '../../src/main/util/ls-output';

/**
 * The cross-check of the **samples of a real board** (collected on 2026-11-13,
 * board serial 0000000000000000).
 *
 * The difference to `tests/unit/session-log-format.test.ts`: the samples of
 * that file come from the log of the **old project**, while the samples here
 * were **taken from the real board today** and they are **facts of the
 * contract layer** rather than a format.
 */

const FIXTURES = join(__dirname, '../../fixtures/board');
const lsRoot = readFileSync(join(FIXTURES, 'rk3588-atk-ls-root.txt'), 'utf8');
const snapshot = readFileSync(join(FIXTURES, 'rk3588-atk-snapshot.txt'), 'utf8');
const devfreq = readFileSync(join(FIXTURES, 'rk3588-atk-devfreq.txt'), 'utf8');
const statPair = readFileSync(join(FIXTURES, 'rk3588-atk-proc-stat-pair.txt'), 'utf8');

describe('the samples of the board · the listing of a directory', () => {
  const entries = parseLsLines(lsRoot);

  it('the name of a symbolic link does not carry the `-> target`', () => {
    const names = entries.map((e) => e.name);
    // The real board has 5 symbolic links
    expect(names).toContain('bin');
    expect(names).toContain('lib');
    expect(names).toContain('lib64');
    expect(names).toContain('linuxrc');
    expect(names).toContain('sbin');
    // The arrow is not part of the name
    expect(names.some((n) => n.includes('->'))).toBe(false);
  });

  it('the line `total 92` does not enter the result', () => {
    expect(entries.map((e) => e.name)).not.toContain('total');
  });

  it('an entry with empty permissions (----------) is recognised as well', () => {
    // The real board has `---------- 1 root root 0 Jan  1 08:00 crond.reboot`
    const crond = entries.find((e) => e.name === 'crond.reboot');
    expect(crond).toBeDefined();
    expect(crond?.type).toBe('-');
  });

  it('both the raw byte count and the human readable value are recognised', () => {
    expect(entries.find((e) => e.name === 'busybox.fragment')?.size).toBe(489);
    expect(entries.find((e) => e.name === 'lost+found')?.size).toBe(16384);
  });

  it('a directory and a file can be told apart', () => {
    expect(entries.find((e) => e.name === 'etc')?.type).toBe('d');
    expect(entries.find((e) => e.name === 'up.log')?.type).toBe('-');
  });
});

describe('the samples of the board · the facts of the contract layer', () => {
  it('the CPU clusters are A55×4 + A76×4 (CPU part 0xd05 / 0xd0b)', () => {
    // The source of the value of `cpu.core.*.cluster` in the contract
    const parts = [...snapshot.matchAll(/CPU part\s*:\s*(0x[0-9a-f]+)/g)].map((m) => m[1]);
    expect(parts.length).toBe(8);
    expect(parts.filter((p) => p === '0xd05').length).toBe(4);
    expect(parts.filter((p) => p === '0xd0b').length).toBe(4);
  });

  it('the devfreq load of the NPU reads 100 while idle — it is a duty cycle, not a utilisation', () => {
    // **This is exactly what contract `spec/01` §7 warns about**.
    // Measured on the board: while idle `/sys/class/devfreq/fdab0000.npu/load` =
// `100@1000000000Hz`.
    // Taken as a utilisation, **an idle board would show 100% busy**.
    const npuDevfreq = /###NPU_DEVFRQ\n([^\n]*)/.exec(devfreq)?.[1] ?? '';
    expect(npuDevfreq).toMatch(/^100@/);
  });

  it('the real utilisation of the NPU is in rknpu, with the format `NPU load:  Core0: N%, ...`', () => {
    const rknpu = /###NPU_RKNPU\n([^\n]*)/.exec(devfreq)?.[1] ?? '';
    // Three cores, **with a trailing comma** — the parser has to recognise that
    expect(rknpu).toMatch(/NPU load:\s+Core0:\s+\d+%/);
    expect(rknpu).toContain('Core2:');
    expect(rknpu.trimEnd().endsWith(',')).toBe(true);
  });

  it('the devfreq load of the GPU reads 0 while idle — the opposite of the NPU', () => {
    const gpu = /###GPU_DEVFRQ\n([^\n]*)/.exec(devfreq)?.[1] ?? '';
    expect(gpu).toMatch(/^0@/);
  });

  it('the type of a thermal zone carries the suffix `-thermal` — merging it into temp.soc has to recognise that', () => {
    // The zone types on the real board are `soc-thermal` / `gpu-thermal` /
// `npu-thermal`…
    const temps = /###TEMP\n([\s\S]*?)###/.exec(snapshot)?.[1] ?? '';
    expect(temps).toContain('soc-thermal=');
    expect(temps).toContain('gpu-thermal=');
    expect(temps).toContain('npu-thermal=');
    // Millidegrees (34230 = 34.23°C)
    expect(temps).toMatch(/soc-thermal=\d{4,5}/);
  });

  it('debugfs **is mounted** on this board — rknpu can be read', () => {
    expect(devfreq).toContain('debugfs on /sys/kernel/debug');
  });

  it('MemTotal and MemAvailable are both there (contract mem.total_bytes / mem.available_bytes)', () => {
    const mem = /###MEM\n([\s\S]*?)###/.exec(snapshot)?.[1] ?? '';
    expect(mem).toMatch(/MemTotal:\s+\d+ kB/);
    expect(mem).toMatch(/MemAvailable:\s+\d+ kB/);
  });
});

describe('the samples of the board · the difference vector of cpu.usage', () => {
  /** Takes the `cpu` summary line of a section */
  function totalLine(section: '###FIRST' | '###SECOND'): number[] {
    const body = /###FIRST\n([\s\S]*?)###SECOND\n([\s\S]*)/.exec(statPair);
    const chunk = section === '###FIRST' ? body?.[1] : body?.[2];
    const line = (chunk ?? '').split('\n').find((l) => l.startsWith('cpu '));
    return (line ?? '').trim().split(/\s+/).slice(1).map(Number);
  }

  it('the difference between two real samples yields the busy share', () => {
    const a = totalLine('###FIRST');
    const b = totalLine('###SECOND');
    expect(a.length).toBeGreaterThanOrEqual(4);
    expect(b.length).toBe(a.length);

    // The cpu line of /proc/stat: user nice system idle iowait irq softirq ...
    const totalA = a.reduce((x, y) => x + y, 0);
    const totalB = b.reduce((x, y) => x + y, 0);
    const idleA = a[3];
    const idleB = b[3];

    const total = totalB - totalA;
    const busy = total - (idleB - idleA);
    expect(total).toBeGreaterThan(0);
    // The board was idle while it was sampled → the busy share is small, but
// **not 0**
    // (the opposite of `unavailable ≠ 0`: a real 0 has to be reported as 0 as well)
    const usage = busy / total;
    expect(usage).toBeGreaterThanOrEqual(0);
    expect(usage).toBeLessThan(0.1);
  });

  it('the two sections of the sample have the same number of lines — the parser does not have to handle "one line more in the middle"', () => {
    const body = /###FIRST\n([\s\S]*?)###SECOND\n([\s\S]*)/.exec(statPair);
    expect(body).not.toBeNull();
    const firstLines = (body?.[1] ?? '').split('\n').filter(Boolean);
    const secondLines = (body?.[2] ?? '').split('\n').filter(Boolean);
    expect(firstLines.length).toBe(secondLines.length);
    // 8 cores + a few summary lines
    expect(firstLines.filter((l) => l.startsWith('cpu')).length).toBe(9);
  });
});
