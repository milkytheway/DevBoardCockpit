import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLsLines } from '../../src/main/util/ls-output';

/**
 * **真机样本**的对拍（2026-11-13 采集，板子 serial f34dca7784396ab2）。
 *
 * 与 `tests/unit/session-log-format.test.ts` 的区别：
 * 那份的样本来自**前身工程**的日志；这里的样本是**今天从真板上采的**，
 * 而且是**契约层的事实**（不是格式）。
 *
 * 采集命令与逐条结论见 `docs/06-契约核对.md` §四。
 */

const FIXTURES = join(__dirname, '../../fixtures/board');
const lsRoot = readFileSync(join(FIXTURES, 'rk3588-atk-ls-root.txt'), 'utf8');
const snapshot = readFileSync(join(FIXTURES, 'rk3588-atk-snapshot.txt'), 'utf8');
const devfreq = readFileSync(join(FIXTURES, 'rk3588-atk-devfreq.txt'), 'utf8');
const statPair = readFileSync(join(FIXTURES, 'rk3588-atk-proc-stat-pair.txt'), 'utf8');

describe('真机样本 · 目录列举', () => {
  const entries = parseLsLines(lsRoot);

  it('软链接的名字不带 `-> target`', () => {
    const names = entries.map((e) => e.name);
    // 真板上有 5 个软链接
    expect(names).toContain('bin');
    expect(names).toContain('lib');
    expect(names).toContain('lib64');
    expect(names).toContain('linuxrc');
    expect(names).toContain('sbin');
    // 箭头不是名字的一部分
    expect(names.some((n) => n.includes('->'))).toBe(false);
  });

  it('`total 92` 那行不进结果', () => {
    expect(entries.map((e) => e.name)).not.toContain('total');
  });

  it('权限全空的条目（----------）也认得出来', () => {
    // 真板上有 `---------- 1 root root 0 Jan  1 08:00 crond.reboot`
    const crond = entries.find((e) => e.name === 'crond.reboot');
    expect(crond).toBeDefined();
    expect(crond?.type).toBe('-');
  });

  it('原始字节数与人类可读值都认', () => {
    expect(entries.find((e) => e.name === 'busybox.fragment')?.size).toBe(489);
    expect(entries.find((e) => e.name === 'lost+found')?.size).toBe(16384);
  });

  it('目录与文件分得出来', () => {
    expect(entries.find((e) => e.name === 'etc')?.type).toBe('d');
    expect(entries.find((e) => e.name === 'up.log')?.type).toBe('-');
  });
});

describe('真机样本 · 契约层的事实', () => {
  it('CPU 簇是 A55×4 + A76×4（CPU part 0xd05 / 0xd0b）', () => {
    // 契约 `cpu.core.*.cluster` 的取值来源
    const parts = [...snapshot.matchAll(/CPU part\s*:\s*(0x[0-9a-f]+)/g)].map((m) => m[1]);
    expect(parts.length).toBe(8);
    expect(parts.filter((p) => p === '0xd05').length).toBe(4);
    expect(parts.filter((p) => p === '0xd0b').length).toBe(4);
  });

  it('NPU 的 devfreq load 空闲时读 100 —— 它是占空比，不是利用率', () => {
    // **契约 `spec/01` §七 警告的正是这个**。
    // 真机实测：空闲时 `/sys/class/devfreq/fdab0000.npu/load` = `100@1000000000Hz`。
    // 拿它当利用率，**空闲的板会显示 100% 忙**。
    const npuDevfreq = /###NPU_DEVFRQ\n([^\n]*)/.exec(devfreq)?.[1] ?? '';
    expect(npuDevfreq).toMatch(/^100@/);
  });

  it('NPU 真正的利用率在 rknpu 里，格式是 `NPU load:  Core0: N%, ...`', () => {
    const rknpu = /###NPU_RKNPU\n([^\n]*)/.exec(devfreq)?.[1] ?? '';
    // 三个核，**末尾带逗号** —— 解析器要认这个
    expect(rknpu).toMatch(/NPU load:\s+Core0:\s+\d+%/);
    expect(rknpu).toContain('Core2:');
    expect(rknpu.trimEnd().endsWith(',')).toBe(true);
  });

  it('GPU 的 devfreq load 空闲时读 0 —— 与 NPU 的行为相反', () => {
    const gpu = /###GPU_DEVFRQ\n([^\n]*)/.exec(devfreq)?.[1] ?? '';
    expect(gpu).toMatch(/^0@/);
  });

  it('thermal zone 的 type 带 `-thermal` 后缀 —— 归并到 temp.soc 要认这个', () => {
    // 真板上的 zone type 是 `soc-thermal` / `gpu-thermal` / `npu-thermal`……
    const temps = /###TEMP\n([\s\S]*?)###/.exec(snapshot)?.[1] ?? '';
    expect(temps).toContain('soc-thermal=');
    expect(temps).toContain('gpu-thermal=');
    expect(temps).toContain('npu-thermal=');
    // 毫度（34230 = 34.23°C）
    expect(temps).toMatch(/soc-thermal=\d{4,5}/);
  });

  it('debugfs 在这块板上**是挂着的** —— rknpu 读得到', () => {
    expect(devfreq).toContain('debugfs on /sys/kernel/debug');
  });

  it('MemTotal / MemAvailable 都在（契约 mem.total_bytes / mem.available_bytes）', () => {
    const mem = /###MEM\n([\s\S]*?)###/.exec(snapshot)?.[1] ?? '';
    expect(mem).toMatch(/MemTotal:\s+\d+ kB/);
    expect(mem).toMatch(/MemAvailable:\s+\d+ kB/);
  });
});

describe('真机样本 · cpu.usage 的差值向量', () => {
  /** 取一段里的 `cpu` 汇总行 */
  function totalLine(text: string, section: '###FIRST' | '###SECOND'): number[] {
    const body = /###FIRST\n([\s\S]*?)###SECOND\n([\s\S]*)/.exec(
      section === '###FIRST' ? statPair : statPair,
    );
    const chunk = section === '###FIRST' ? body?.[1] : body?.[2];
    const line = (chunk ?? '').split('\n').find((l) => l.startsWith('cpu '));
    return (line ?? '').trim().split(/\s+/).slice(1).map(Number);
  }

  it('两次真采样之间的差值能算出忙碌占比', () => {
    const a = totalLine(statPair, '###FIRST');
    const b = totalLine(statPair, '###SECOND');
    expect(a.length).toBeGreaterThanOrEqual(4);
    expect(b.length).toBe(a.length);

    // /proc/stat 的 cpu 行：user nice system idle iowait irq softirq ...
    const totalA = a.reduce((x, y) => x + y, 0);
    const totalB = b.reduce((x, y) => x + y, 0);
    const idleA = a[3];
    const idleB = b[3];

    const total = totalB - totalA;
    const busy = total - (idleB - idleA);
    expect(total).toBeGreaterThan(0);
    // 这块板在采样时是闲的 → 忙碌占比很小，但**不为 0**
    // （`unavailable ≠ 0` 的反面：真的 0 也要如实报 0）
    const usage = busy / total;
    expect(usage).toBeGreaterThanOrEqual(0);
    expect(usage).toBeLessThan(0.1);
  });

  it('样本里两段的行数一致 —— 解析器不必处理「中途多了一行」', () => {
    const body = /###FIRST\n([\s\S]*?)###SECOND\n([\s\S]*)/.exec(statPair);
    expect(body).not.toBeNull();
    const firstLines = (body?.[1] ?? '').split('\n').filter(Boolean);
    const secondLines = (body?.[2] ?? '').split('\n').filter(Boolean);
    expect(firstLines.length).toBe(secondLines.length);
    // 8 个核 + 若干汇总行
    expect(firstLines.filter((l) => l.startsWith('cpu')).length).toBe(9);
  });
});
