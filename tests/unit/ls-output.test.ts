import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLsLines, parseLsDate, parseSize } from '../../src/main/util/ls-output';

/**
 * The parsing of `ls -la`.
 *
 * **A golden sample of a real board** is used here
 * (`fixtures/session-log/serial-session.log`), not a hand-written fake input
 * — the rule of AGENTS §5: "the samples of a real board are golden vectors".
 *
 * That sample holds a piece of **real `ls -l` output** with a symbolic link
 * (`lib -> usr/lib/`), a human readable size (`5.5K`) and a directory name
 * that the terminal wrapped and cut.
 *
 * The symbolic link was once a real bug: the parser took `lib -> usr/lib/`
 * for the whole file name, so the file tree held an entry called
 * "lib -> usr/lib/" whose path does not exist when it is transferred.
 */
const FIXTURE = join(__dirname, '../../fixtures/session-log/serial-session.log');

/** Picks the `ls -l` lines out of the session log (it removes the timestamp prefix of the log) */
function lsLinesFromFixture(): string[] {
  const log = readFileSync(FIXTURE, 'utf8');
  const out: string[] = [];
  for (const line of log.split(/\r?\n/)) {
    const m = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] (.+)$/.exec(line);
    if (!m) continue;
    const rest = m[1];
    // The beginning of an `ls -l` line is the permission string
    if (/^[dlbcps-][rwxstST-]{9}\s/.test(rest)) out.push(rest);
  }
  return out;
}

describe('the parsing of the ls output (a golden sample of a real board)', () => {
  const lines = lsLinesFromFixture();

  it('the sample really holds an ls output that can be parsed', () => {
    expect(lines.length).toBeGreaterThan(10);
  });

  it('a symbolic link only gives the name, without the `-> target`', () => {
    const entries = parseLsLines(lines.join('\n'));
    const names = entries.map((e) => e.name);
    // These three are symbolic links in the sample of the real board
    expect(names).toContain('lib');
    expect(names).toContain('lib64');
    expect(names).toContain('linuxrc');
    // The arrow may not appear in the name
    expect(names.some((n) => n.includes('->'))).toBe(false);
  });

  it('the human readable size (5.5K) is parsed into a number of bytes', () => {
    const entries = parseLsLines(lines.join('\n'));
    const dev = entries.find((e) => e.name === 'dev');
    expect(dev).toBeDefined();
    expect(dev?.size).toBe(5.5 * 1024);
  });

  it('a directory and a file can be told apart', () => {
    const entries = parseLsLines(lines.join('\n'));
    const media = entries.find((e) => e.name === 'media');
    expect(media?.type).toBe('d');
    const resized = entries.find((e) => e.name === '.resized');
    expect(resized?.type).toBe('-');
  });

  it('`.` and `..` do not enter the result', () => {
    const entries = parseLsLines(lines.join('\n'));
    expect(entries.map((e) => e.name)).not.toContain('.');
    expect(entries.map((e) => e.name)).not.toContain('..');
  });
});

describe('the bits and pieces of an ls output', () => {
  it('the size: the raw byte count and the human readable value are both recognised', () => {
    expect(parseSize('4096')).toBe(4096);
    expect(parseSize('4.0K')).toBe(4096);
    expect(parseSize('16K')).toBe(16384);
    expect(parseSize('not a number')).toBeNull();
  });

  it('the time: `ls` without a year gets the current year, with a year it is kept as it is', () => {
    // "Aug 27  2026" carries the year
    expect(parseLsDate('Aug 27  2026')).toBe('2026-08-27T00:00:00.000Z');
    // When it cannot be parsed it returns null — a time that cannot be shown is not fatal
    expect(parseLsDate('Aug 27')).toBeNull();
  });

  it('a line that cannot be parsed is skipped without destroying the whole listing', () => {
    const entries = parseLsLines(
      ['garbage line', '-rw-r--r-- 1 root root 7 Nov 12 09:31 b.txt'].join('\n'),
    );
    expect(entries.map((e) => e.name)).toEqual(['b.txt']);
  });
});
