import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionLog, formatTimestamp, stripAnsi } from '../../src/main/logging/session-log';

/**
 * 日志格式的**黄金向量测试**。
 *
 * `fixtures/session-log/serial-session.log` 是真机样本（AGENTS.md §5：fixtures 是黄金向量，
 * 样本只增不改）。格式契约写在 `docs/02` 事实 G4：时间戳前缀、剥 ANSI、事件行。
 *
 * ── 之前这个文件是假的对拍 ──
 *
 * 它只断言**样本文件自己长什么样**，**从来没有让实现去跑一遍样本**——
 * 于是实现换成什么样它都绿。
 * 这正是 `docs/11-计划1评审报告.md` R-56 说的：
 * 「8 份 fixture 只有 1 份被测试读，而那 1 份读的还是样本自己」。
 *
 * 现在的做法：**把样本喂给实现，比对实现的输出**。
 * 实现复现不出样本的形状，这条测试就红。
 *
 * 样本的出处是旧工程的 `DevBoardConsole/devboard_console/core/session_log.py`——
 * 所以格式的权威是那份实现，不是猜的。
 */
const SAMPLE = join(process.cwd(), 'fixtures/session-log/serial-session.log');
const sample = readFileSync(SAMPLE, 'utf8');

/** 样本的每一行：带时间戳前缀的解析成 {stamp, body}，收尾那行没有前缀 */
function parseSample(): Array<{ stamp: string | null; body: string }> {
  return sample
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .map((line) => {
      const m = /^\[(\d{2}:\d{2}:\d{2}\.\d{3})\] (.*)$/.exec(line);
      return m ? { stamp: m[1], body: m[2] } : { stamp: null, body: line };
    });
}

/** 去掉时间戳前缀，只留内容 */
function bodies(lines: string[]): string[] {
  return lines.map((l) => l.replace(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] /, ''));
}

/**
 * 归一化事件行里的绝对时刻。
 *
 * 样本是 2026-11-12 02:15 录的，收尾是 02:20（会话跑了五分钟）；
 * 实现的时钟是注入的固定值。**时刻本来就该不一样**——要比的是形状。
 */
function normalizeTimes(lines: string[]): string[] {
  return lines.map((l) => l.replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g, '<时刻>'));
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dblog-fmt-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const FIXED = () => new Date(2026, 10, 12, 2, 15, 7, 54);

describe('会话日志格式与黄金样本同构', () => {
  it('样本本身符合 [HH:mm:ss.SSS] 前缀（收尾那一行除外）', () => {
    const parsed = parseSample();
    const stamped = parsed.filter((p) => p.stamp !== null);
    expect(stamped.length).toBeGreaterThan(10);
    // 最后一行是收尾，没有前缀
    expect(parsed[parsed.length - 1].stamp).toBeNull();
  });

  it('样本里没有 ANSI 码（事实 G4：ANSI 要剥掉）', () => {
    expect(sample).not.toContain('\x1b[');
    expect(stripAnsi(sample)).toBe(sample);
  });

  it('formatTimestamp 产出与样本同形的时间戳', () => {
    expect(formatTimestamp(new Date(2026, 10, 12, 2, 15, 7, 54))).toBe('02:15:07.054');
  });

  it('样本含事件行（会话开/关、连接、断流）', () => {
    expect(sample).toContain('=== session opened');
    expect(sample).toContain('--- connected');
    expect(sample).toContain('--- disconnected');
    expect(sample).toContain('=== session closed');
  });

  // ── 下面这条才是真的对拍 ──
  it('实现能把样本喂进去、写出同样形状的日志', () => {
    const parsed = parseSample();

    const log = new SessionLog({
      label: '板子 · 串口',
      transport: 'serial',
      dataDir: dir,
      now: FIXED,
    });

    // 样本的第一行是「session opened」——实现自己在构造时写了一行，
    // 所以这里从第二行开始喂。
    const feed = parsed.slice(1).filter((p) => p.stamp !== null);
    for (const p of feed) log.write(p.body);
    log.close();

    const out = readFileSync(log.filePath, 'utf8').split(/\r?\n/).filter((l) => l.length > 0);

    // 1) 行数一致：样本 N 行 → 实现 N 行（多一行是实现自己写的开场行，
    //    正好抵掉样本里的开场行）
    expect(out.length).toBe(parsed.length);

    // 2) **逐行内容一致**（时间戳不同，比内容）
    const expected = normalizeTimes(parsed.map((p) => p.body));
    const actual = normalizeTimes(bodies(out));
    for (let i = 0; i < expected.length; i += 1) {
      expect(actual[i]).toBe(expected[i]);
    }

    // 3) **时间戳的位置也要一致**：除了最后一行，每行都有前缀
    for (const line of out.slice(0, -1)) {
      expect(line).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] /);
    }
    expect(out[out.length - 1]).not.toMatch(/^\[/);
  });
});

describe('会话日志的逐行与剥码', () => {
  it('多行 chunk 每一行都加时间戳 —— 远端一次回包常常是好几行', () => {
    const log = new SessionLog({ label: 't', transport: 'serial', dataDir: dir, now: FIXED });
    log.write('line1\nline2\nline3');
    log.close();
    const lines = readFileSync(log.filePath, 'utf8').split('\n').filter(Boolean);
    // 一行是开场行，三行是刚写的
    const written = lines.slice(1, 4);
    expect(written).toHaveLength(3);
    for (const l of written) expect(l).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] /);
    expect(written[1]).toContain('line2');
  });

  it('剥掉 ESC[?25l（隐藏光标）与 OSC 序列 —— 旧实现漏了这两种', () => {
    expect(stripAnsi('\x1b[?25lhidden\x1b[?25h')).toBe('hidden');
    expect(stripAnsi('\x1b]0;title\x07text')).toBe('text');
    expect(stripAnsi('\x1b[32mgreen\x1b[0m')).toBe('green');
  });

  it('CR 归一成 LF —— 串口控制台的行尾是 CR', () => {
    const log = new SessionLog({ label: 't', transport: 'serial', dataDir: dir, now: FIXED });
    log.write('a\rb\r\nc');
    log.close();
    const lines = readFileSync(log.filePath, 'utf8').split('\n').filter(Boolean);
    // 第 0 行是开场行，末尾是收尾行；中间三行才是刚写的
    expect(lines.slice(1, 4).map((l) => l.replace(/^\[[^\]]+\] /, ''))).toEqual(['a', 'b', 'c']);
  });

  it('事件行是 --- kind --- 的形状', () => {
    const log = new SessionLog({ label: 't', transport: 'serial', dataDir: dir, now: FIXED });
    log.writeEvent('connected', '板子 · 串口');
    log.writeEvent('disconnected');
    log.close();
    const text = readFileSync(log.filePath, 'utf8');
    expect(text).toContain('--- connected 板子 · 串口 ---');
    expect(text).toContain('--- disconnected ---');
  });

  it('开场行与收尾行同构旧工程', () => {
    const log = new SessionLog({ label: '板子 · 串口', transport: 'serial', dataDir: dir, now: FIXED });
    log.close();
    const lines = readFileSync(log.filePath, 'utf8').split('\n').filter(Boolean);
    expect(lines[0]).toContain('=== session opened 2026-11-12 02:15:07 target=板子 · 串口 transport=serial ===');
    expect(lines[lines.length - 1]).toBe('=== session closed 2026-11-12 02:15:07 ===');
  });

  it('同一秒开两个会话不许撞名 —— 撞了第二个会追加到第一个的日志里', () => {
    const a = new SessionLog({ label: 't', transport: 'serial', dataDir: dir, now: FIXED });
    const b = new SessionLog({ label: 't', transport: 'serial', dataDir: dir, now: FIXED });
    expect(b.filePath).not.toBe(a.filePath);
  });
});
