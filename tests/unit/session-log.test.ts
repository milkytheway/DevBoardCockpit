import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionLog, stripAnsi, logFileName } from '../../src/main/logging/session-log';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dblog-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('stripAnsi', () => {
  it('the colour codes are removed and the readable text is kept', () => {
    expect(stripAnsi('\u001b[32mroot@board\u001b[0m:~$ ')).toBe('root@board:~$ ');
  });
});

describe('logFileName', () => {
  it('the format is <label>-<HHMMSS>.log', () => {
    expect(logFileName('board-serial', new Date(2026, 10, 12, 9, 5, 3))).toBe('board-serial-090503.log');
  });
});

describe('SessionLog', () => {
  it('every line is written, with the timestamp prefix, and the ANSI is stripped', () => {
    const log = new SessionLog({ label: 't', transport: 'serial', dataDir: dir, now: () => new Date(2026, 10, 12, 9, 5, 3) });
    log.write('\u001b[31mhello\u001b[0m');
    log.write('world');
    log.close();
    const content = readFileSync(log.filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    // The opening line + two lines of body + the closing line (isomorphic with the golden sample)
    expect(lines).toHaveLength(4);
    expect(content).not.toContain('\u001b[');
    expect(content).toContain('hello');
    expect(content).toContain('world');
  });

  it('the file name is <label>-<HHMMSS>.log — before, one digit was cut off', () => {
    // Before it wrote `logFileName('', at).slice(0, 6)`:
    // an empty label brings one hyphen too many and cutting six characters **cuts one digit too few**,
    // so the session of 09:05:03 landed as `t--09050.log`.
    const log = new SessionLog({ label: 't', transport: 'serial', dataDir: dir, now: () => new Date(2026, 10, 12, 9, 5, 3) });
    expect(log.filePath.endsWith('t-090503.log')).toBe(true);
    log.close();
  });

  it('the path lands in <dataDir>/logs/<date>/', () => {
    const log = new SessionLog({ label: 't', dataDir: dir, now: () => new Date(2026, 10, 12, 9, 5, 3) });
    expect(log.filePath).toContain(join('logs', '2026-11-12'));
    log.close();
  });
});
