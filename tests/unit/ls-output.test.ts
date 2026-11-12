import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLsLines, parseLsDate, parseSize } from '../../src/main/util/ls-output';

/**
 * `ls -la` 解析。
 *
 * **这里用的是真机黄金样本**（`fixtures/session-log/serial-session.log`），
 * 不是手写的假输入——AGENTS §5 的规矩：「真机样本做黄金向量」。
 *
 * 那份样本里有一段**真的 `ls -l` 输出**，带着符号链接
 * （`lib -> usr/lib/`）、人类可读的大小（`5.5K`）、
 * 以及一条被终端折行截断的目录名。
 *
 * 符号链接那条曾经是个真 bug：解析器把 `lib -> usr/lib/` 整个当成了文件名，
 * 于是文件树里出现一个叫「lib -> usr/lib/」的条目，
 * 对它做传输时路径根本不存在。
 */
const FIXTURE = join(__dirname, '../../fixtures/session-log/serial-session.log');

/** 从会话日志里挑出 `ls -l` 的那些行（去掉日志自己的时间戳前缀） */
function lsLinesFromFixture(): string[] {
  const log = readFileSync(FIXTURE, 'utf8');
  const out: string[] = [];
  for (const line of log.split(/\r?\n/)) {
    const m = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] (.+)$/.exec(line);
    if (!m) continue;
    const rest = m[1];
    // `ls -l` 的行首是权限串
    if (/^[dlbcps-][rwxstST-]{9}\s/.test(rest)) out.push(rest);
  }
  return out;
}

describe('ls 输出解析（真机黄金样本）', () => {
  const lines = lsLinesFromFixture();

  it('样本里确实有 ls 输出可解析', () => {
    expect(lines.length).toBeGreaterThan(10);
  });

  it('符号链接只取名字，不带 `-> target`', () => {
    const entries = parseLsLines(lines.join('\n'));
    const names = entries.map((e) => e.name);
    // 真机样本里这三个是符号链接
    expect(names).toContain('lib');
    expect(names).toContain('lib64');
    expect(names).toContain('linuxrc');
    // 名字里不许出现箭头
    expect(names.some((n) => n.includes('->'))).toBe(false);
  });

  it('人类可读的大小（5.5K）能解析成字节数', () => {
    const entries = parseLsLines(lines.join('\n'));
    const dev = entries.find((e) => e.name === 'dev');
    expect(dev).toBeDefined();
    expect(dev?.size).toBe(5.5 * 1024);
  });

  it('目录与文件分得出来', () => {
    const entries = parseLsLines(lines.join('\n'));
    const media = entries.find((e) => e.name === 'media');
    expect(media?.type).toBe('d');
    const resized = entries.find((e) => e.name === '.resized');
    expect(resized?.type).toBe('-');
  });

  it('`.` 与 `..` 不进结果', () => {
    const entries = parseLsLines(lines.join('\n'));
    expect(entries.map((e) => e.name)).not.toContain('.');
    expect(entries.map((e) => e.name)).not.toContain('..');
  });
});

describe('ls 输出的零碎', () => {
  it('大小：原始字节数与人类可读值都认', () => {
    expect(parseSize('4096')).toBe(4096);
    expect(parseSize('4.0K')).toBe(4096);
    expect(parseSize('16K')).toBe(16384);
    expect(parseSize('不是数字')).toBeNull();
  });

  it('时间：`ls` 不带年份，补当前年份；带年份的按原样', () => {
    // 「Aug 27  2026」带年份
    expect(parseLsDate('Aug 27  2026')).toBe('2026-08-27T00:00:00.000Z');
    // 解析不出来就返回 null——时间显示不出来不是致命问题
    expect(parseLsDate('Aug 27')).toBeNull();
  });

  it('解析不了的行跳过而不毁掉整次列举', () => {
    const entries = parseLsLines(
      ['garbage line', '-rw-r--r-- 1 root root 7 Nov 12 09:31 b.txt'].join('\n'),
    );
    expect(entries.map((e) => e.name)).toEqual(['b.txt']);
  });
});
