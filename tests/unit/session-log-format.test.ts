import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatTimestamp, stripAnsi } from '../../src/main/logging/session-log';

/**
 * 日志格式的**黄金向量测试**。
 *
 * `fixtures/session-log/serial-session.log` 是真机样本（AGENTS.md §5：fixtures 是黄金向量，
 * 样本只增不改）。格式契约写在 `docs/02` 事实 G4：时间戳前缀、剥 ANSI、事件行。
 * 之前实现写的是 ISO + UTC，与样本对不上——却没有测试消费这个样本。
 */
describe('会话日志格式与黄金样本同构', () => {
  const sample = readFileSync(
    join(process.cwd(), 'fixtures/session-log/serial-session.log'),
    'utf8',
  );

  it('样本本身符合 [HH:mm:ss.SSS] 前缀', () => {
    const lines = sample.split(/\r?\n/).filter((l) => l.startsWith('['));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] /);
    }
  });

  it('样本里没有 ANSI 码（事实 G4：ANSI 要剥掉）', () => {
    expect(sample).not.toContain('[');
    expect(stripAnsi(sample)).toBe(sample);
  });

  it('formatTimestamp 产出与样本同形的时间戳', () => {
    // 2026-11-12 02:15:07.054 本地时间
    const at = new Date(2026, 10, 12, 2, 15, 7, 54);
    expect(formatTimestamp(at)).toBe('02:15:07.054');
  });

  it('样本含事件行（会话开/关、连接、断流）', () => {
    expect(sample).toContain('=== session opened');
    expect(sample).toContain('--- connected');
    expect(sample).toContain('--- disconnected');
    expect(sample).toContain('=== session closed');
  });
});
