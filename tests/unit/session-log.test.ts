import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionLog, stripAnsi, logFileName } from '../../src/main/logging/session-log';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dblog-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('stripAnsi', () => {
  it('去掉颜色码但保留可读文本', () => {
    expect(stripAnsi('\u001b[32mroot@board\u001b[0m:~$ ')).toBe('root@board:~$ ');
  });
});

describe('logFileName', () => {
  it('格式是 <label>-<HHMMSS>.log', () => {
    expect(logFileName('board-serial', new Date(2026, 10, 12, 9, 5, 3))).toBe('board-serial-090503.log');
  });
});

describe('SessionLog', () => {
  it('每行落盘、带时间戳前缀、剥掉 ANSI', () => {
    const log = new SessionLog({ label: 't', transport: 'serial', dataDir: dir, now: () => new Date(2026, 10, 12, 9, 5, 3) });
    log.write('\u001b[31mhello\u001b[0m');
    log.write('world');
    log.close();
    const content = readFileSync(log.filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    // 开场行 + 两行正文 + 收尾行（与黄金样本同构）
    expect(lines).toHaveLength(4);
    expect(content).not.toContain('\u001b[');
    expect(content).toContain('hello');
    expect(content).toContain('world');
  });

  it('文件名是 <label>-<HHMMSS>.log —— 之前少切了一位数字', () => {
    // 之前写的是 `logFileName('', at).slice(0, 6)`：
    // 空 label 会多带一个连字符，切 6 位又**少切一位数字**，
    // 于是 09:05:03 的会话落成 `t--09050.log`。
    const log = new SessionLog({ label: 't', transport: 'serial', dataDir: dir, now: () => new Date(2026, 10, 12, 9, 5, 3) });
    expect(log.filePath.endsWith('t-090503.log')).toBe(true);
    log.close();
  });

  it('路径落在 <dataDir>/logs/<date>/ 下', () => {
    const log = new SessionLog({ label: 't', dataDir: dir, now: () => new Date(2026, 10, 12, 9, 5, 3) });
    expect(log.filePath).toContain(join('logs', '2026-11-12'));
    log.close();
  });
});
