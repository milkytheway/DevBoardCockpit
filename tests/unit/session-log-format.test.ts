import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionLog, formatTimestamp, stripAnsi } from '../../src/main/logging/session-log';

/**
 * The **golden vector test** of the log format.
 *
 * `fixtures/session-log/serial-session.log` is a sample of a real board
 * (AGENTS.md §5: the fixtures are golden vectors and a sample is only added,
 * never changed). The contract of the format is written down in
 * `docs/02-device-facts.md`, fact G4: the timestamp prefix, the stripping of
 * ANSI, the event lines.
 *
 * Before, this file was a cross-check in name only:
 *
 * It only asserted **what the sample file looks like** and **never let the
 * implementation run over the sample**, so it stayed green whatever the
 * implementation became.
 *
 * The way it works now: **the sample is fed to the implementation and the
 * output of the implementation is compared**. If the implementation cannot
 * reproduce the shape of the sample, this test fails.
 *
 * The sample comes from `DevBoardConsole/devboard_console/core/session_log.py`
 * of the old project, so the authority of the format is that implementation
 * and not a guess.
 */
const SAMPLE = join(process.cwd(), 'fixtures/session-log/serial-session.log');
const sample = readFileSync(SAMPLE, 'utf8');

/** Every line of the sample: the ones with a timestamp prefix are parsed into {stamp, body}, the closing line has no prefix */
function parseSample(): Array<{ stamp: string | null; body: string }> {
  return sample
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .map((line) => {
      const m = /^\[(\d{2}:\d{2}:\d{2}\.\d{3})\] (.*)$/.exec(line);
      return m ? { stamp: m[1], body: m[2] } : { stamp: null, body: line };
    });
}

/** Removes the timestamp prefix and keeps the content */
function bodies(lines: string[]): string[] {
  return lines.map((l) => l.replace(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] /, ''));
}

/**
 * Normalises the absolute times in the event lines.
 *
 * The sample was recorded on 2026-11-12 at 02:15 and closes at 02:20 (the
 * session ran for five minutes), while the clock of the implementation is an
 * injected fixed value. **The times are supposed to differ** — what is
 * compared is the shape.
 */
function normalizeTimes(lines: string[]): string[] {
  return lines.map((l) => l.replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g, '<timestamp>'));
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dblog-fmt-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const FIXED = () => new Date(2026, 10, 12, 2, 15, 7, 54);

describe('the format of the session log is isomorphic with the golden sample', () => {
  it('the sample itself carries the [HH:mm:ss.SSS] prefix (except for the closing line)', () => {
    const parsed = parseSample();
    const stamped = parsed.filter((p) => p.stamp !== null);
    expect(stamped.length).toBeGreaterThan(10);
    // The last line is the closing one and has no prefix
    expect(parsed[parsed.length - 1].stamp).toBeNull();
  });

  it('the sample holds no ANSI codes (fact G4: ANSI has to be stripped)', () => {
    expect(sample).not.toContain('\x1b[');
    expect(stripAnsi(sample)).toBe(sample);
  });

  it('formatTimestamp produces a timestamp of the same shape as the sample', () => {
    expect(formatTimestamp(new Date(2026, 10, 12, 2, 15, 7, 54))).toBe('02:15:07.054');
  });

  it('the sample holds event lines (the session opens and closes, the connection, the broken stream)', () => {
    expect(sample).toContain('=== session opened');
    expect(sample).toContain('--- connected');
    expect(sample).toContain('--- disconnected');
    expect(sample).toContain('=== session closed');
  });

  // — the case below is the real cross-check —
  it('the implementation can be fed with the sample and writes a log of the same shape', () => {
    const parsed = parseSample();

    const log = new SessionLog({
      label: '板子 · 串口',
      transport: 'serial',
      dataDir: dir,
      now: FIXED,
    });

    // The first line of the sample is "session opened" — the implementation writes
// a line itself when it is constructed,
    // so the feeding starts at the second line here.
    const feed = parsed.slice(1).filter((p) => p.stamp !== null);
    for (const p of feed) log.write(p.body);
    log.close();

    const out = readFileSync(log.filePath, 'utf8').split(/\r?\n/).filter((l) => l.length > 0);

    // 1) The number of lines agrees: N lines in the sample → N lines in the
// implementation (the extra line is the opening line the implementation writes
// itself,
    //    which cancels the opening line of the sample)
    expect(out.length).toBe(parsed.length);

    // 2) **The content of every line agrees** (the timestamps differ, the content
// is compared)
    const expected = normalizeTimes(parsed.map((p) => p.body));
    const actual = normalizeTimes(bodies(out));
    for (let i = 0; i < expected.length; i += 1) {
      expect(actual[i]).toBe(expected[i]);
    }

    // 3) **The position of the timestamps agrees as well**: except for the last
// line, every line has a prefix
    for (const line of out.slice(0, -1)) {
      expect(line).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] /);
    }
    expect(out[out.length - 1]).not.toMatch(/^\[/);
  });
});

describe('the line by line handling and the stripping of codes in the session log', () => {
  it('every line of a multi-line chunk gets a timestamp — one answer of the remote side is often several lines', () => {
    const log = new SessionLog({ label: 't', transport: 'serial', dataDir: dir, now: FIXED });
    log.write('line1\nline2\nline3');
    log.close();
    const lines = readFileSync(log.filePath, 'utf8').split('\n').filter(Boolean);
    // One line is the opening line, three lines are the ones just written
    const written = lines.slice(1, 4);
    expect(written).toHaveLength(3);
    for (const l of written) expect(l).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] /);
    expect(written[1]).toContain('line2');
  });

  it('it strips ESC[?25l (the hidden cursor) and the OSC sequences — the old implementation missed those two', () => {
    expect(stripAnsi('\x1b[?25lhidden\x1b[?25h')).toBe('hidden');
    expect(stripAnsi('\x1b]0;title\x07text')).toBe('text');
    expect(stripAnsi('\x1b[32mgreen\x1b[0m')).toBe('green');
  });

  it('a CR is normalised to an LF — the line ending of a serial console is CR', () => {
    const log = new SessionLog({ label: 't', transport: 'serial', dataDir: dir, now: FIXED });
    log.write('a\rb\r\nc');
    log.close();
    const lines = readFileSync(log.filePath, 'utf8').split('\n').filter(Boolean);
    // The line 0 is the opening line and the last one is the closing line; only
// the three in between were just written
    expect(lines.slice(1, 4).map((l) => l.replace(/^\[[^\]]+\] /, ''))).toEqual(['a', 'b', 'c']);
  });

  it('an event line has the shape --- kind ---', () => {
    const log = new SessionLog({ label: 't', transport: 'serial', dataDir: dir, now: FIXED });
    log.writeEvent('connected', '板子 · 串口');
    log.writeEvent('disconnected');
    log.close();
    const text = readFileSync(log.filePath, 'utf8');
    expect(text).toContain('--- connected 板子 · 串口 ---');
    expect(text).toContain('--- disconnected ---');
  });

  it('the opening line and the closing line are isomorphic with the old project', () => {
    const log = new SessionLog({ label: '板子 · 串口', transport: 'serial', dataDir: dir, now: FIXED });
    log.close();
    const lines = readFileSync(log.filePath, 'utf8').split('\n').filter(Boolean);
    expect(lines[0]).toContain('=== session opened 2026-11-12 02:15:07 target=板子 · 串口 transport=serial ===');
    expect(lines[lines.length - 1]).toBe('=== session closed 2026-11-12 02:15:07 ===');
  });

  it('two sessions opened in the same second may not share a name — otherwise the second is appended to the log of the first', () => {
    const a = new SessionLog({ label: 't', transport: 'serial', dataDir: dir, now: FIXED });
    const b = new SessionLog({ label: 't', transport: 'serial', dataDir: dir, now: FIXED });
    expect(b.filePath).not.toBe(a.filePath);
  });
});
