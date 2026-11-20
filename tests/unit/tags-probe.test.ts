import { describe, it, expect } from 'vitest';
import { judgeReader, resolvePackDir, describeRequires, probeHint } from '../../src/main/tags/probe';
import type { TagReading } from '../../src/shared/tag-reading';

/**
 * The **decision logic of the probe** (the criteria of M4).
 *
 * "probe:board is all green for rk3588-atk" is the acceptance criterion of
 * M4, and the word "green" needs a **mechanical criterion** — otherwise
 * "green" is only a person looking at a screen saying "it seems right".
 *
 * The conditions for a reader to be green:
 * 1. **every** tag it produces is declared in the pack (**no more**);
 * 2. **every** tag of the pack that carries no wildcard was obtained
 *    (**no less**);
 * 3. the status of those tags is **`ok`** in every case (`pending` does not
 *    count — the probe wants "a real value was taken", not "something was
 *    taken but not computed yet").
 */

function reading(tag: string, value: unknown = 1, status: TagReading['status'] = 'ok'): TagReading {
  return { tag, value: value as TagReading['value'], unit: 'percent', status, at: 1, seq: 1 };
}

describe('judgeReader · the conditions for a reader to be green', () => {
  const exp = {
    readerId: 'cpu',
    kind: 'proc_stat',
    declaredTags: ['cpu.usage', 'cpu.core.*.usage'],
  };

  it('every declared tag was obtained and every status is ok → green', () => {
    const report = judgeReader(exp, [reading('cpu.usage'), reading('cpu.core.0.usage')]);
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
  });

  it('**one tag is missing** → red', () => {
    const report = judgeReader(exp, [reading('cpu.usage')]);
    expect(report.ok).toBe(false);
    expect(report.problems.join('\n')).toContain('cpu.core.*.usage');
  });

  it('**one tag too many** (it was produced although the pack did not declare it) → red', () => {
    const report = judgeReader(exp, [
      reading('cpu.usage'),
      reading('cpu.core.0.usage'),
      reading('cpu.secret'),
    ]);
    expect(report.ok).toBe(false);
    expect(report.problems.join('\n')).toContain('cpu.secret');
  });

  it('the status is not ok → red (**pending does not count either**)', () => {
    const pending = judgeReader(exp, [
      reading('cpu.usage', null, 'pending'),
      reading('cpu.core.0.usage'),
    ]);
    expect(pending.ok).toBe(false);

    const unavailable = judgeReader(exp, [
      reading('cpu.usage', null, 'unavailable'),
      reading('cpu.core.0.usage'),
    ]);
    expect(unavailable.ok).toBe(false);
  });

  it('not a single tag was obtained → red', () => {
    const report = judgeReader(exp, []);
    expect(report.ok).toBe(false);
  });

  it('**the tags of a wildcard are not required to be exactly the declared ones** — as many as there are', () => {
    // A board with 8 cores produces 8 cpu.core.N.usage — the pack declares only
// one pattern
    const readings = [reading('cpu.usage')];
    for (let i = 0; i < 8; i += 1) readings.push(reading(`cpu.core.${i}.usage`));
    const report = judgeReader(exp, readings);
    expect(report.ok).toBe(true);
  });

  it('the report carries the value of every tag (for a person to read)', () => {
    const report = judgeReader(exp, [reading('cpu.usage', 12.5), reading('cpu.core.0.usage', 3)]);
    expect(report.tags).toHaveLength(2);
    expect(report.tags[0]).toMatchObject({ tag: 'cpu.usage', value: 12.5 });
  });

  it('the report carries the id and the kind of the reader', () => {
    const report = judgeReader(exp, [reading('cpu.usage'), reading('cpu.core.0.usage')]);
    expect(report.readerId).toBe('cpu');
    expect(report.kind).toBe('proc_stat');
  });
});

describe('resolvePackDir · --pack accepts a pack id as well as a directory path', () => {
  const BOARDS = '/repo/profiles/boards';

  it('**a pack id** → profiles/boards/<id>', () => {
    // The documentation (the architecture document and the README of the pack) says `--pack rk3588-atk` (the id of the pack),
    // while the implementation only accepts a directory path → **the command of the documentation does not run**.
    expect(resolvePackDir('rk3588-atk', BOARDS)).toBe('/repo/profiles/boards/rk3588-atk');
  });

  it('**a directory path** is used as it is', () => {
    expect(resolvePackDir('/other/place/rk3588-atk', BOARDS)).toBe('/other/place/rk3588-atk');
    expect(resolvePackDir('profiles/boards/rk3588-atk', BOARDS)).toBe('profiles/boards/rk3588-atk');
  });

  it('without one the default pack is used', () => {
    expect(resolvePackDir(undefined, BOARDS)).toBe('/repo/profiles/boards/rk3588-atk');
  });
});

describe('describeRequires · the probe has to report this field (the consumer the contract C9 promised)', () => {
  it('it reports the capabilities and the transports', () => {
    const line = describeRequires({
      apiVersion: 'devboard/v1',
      kind: 'BoardPack',
      id: 'tiny',
      name: 'x',
      version: '1.0.0',
      requires: { transports: ['adb', 'serial'], capabilities: ['shell', 'exec'] },
      poll_groups: [],
      readers: [],
      custom: [],
      actions: [],
    });
    expect(line).toContain('capabilities');
    expect(line).toContain('shell');
    expect(line).toContain('transports');
    expect(line).toContain('adb');
  });
});

describe('probeHint · when the probe is red it gives one sentence about what to check next', () => {
  const green = {
    packId: 'tiny',
    ok: true,
    readers: [{ readerId: 'cpu', kind: 'proc_stat', tags: [{ tag: 'cpu.usage', value: 1, unit: 'percent', status: 'ok' }], problems: [], ok: true }],
  };
  const allEmpty = {
    packId: 'tiny',
    ok: false,
    readers: [
      { readerId: 'cpu', kind: 'proc_stat', tags: [], problems: ['timed out'], ok: false },
      { readerId: 'gpu', kind: 'devfreq_load', tags: [], problems: ['timed out'], ok: false },
    ],
  };

  it('when everything is green there is no hint', () => {
    expect(probeHint(green as never, 'adb')).toBeNull();
  });

  it('**not a single number came out** → the hint says "this connection is not open", not "the reader has a problem"', () => {
    const hint = probeHint(allEmpty as never, 'adb');
    expect(hint).toBeTruthy();
    expect(hint).toContain('connection');
  });

  it('over a **serial port** the hint says "another program has that port to itself"', () => {
    // This is a pitfall that was really hit on a real board: the serial-server.py that the acceptance of plan 1 left behind held COM3 exclusively,
    // **the answers were eaten by it** — the board was alive, but the application never got one.
    const hint = probeHint(allEmpty as never, 'serial');
    expect(hint).toBeTruthy();
    expect(hint).toContain('COM3');
  });

  it('only some readers are red while the others have numbers → there is no hint of "the connection is not open"', () => {
    const mixed = {
      packId: 'tiny',
      ok: false,
      readers: [
        { readerId: 'cpu', kind: 'proc_stat', tags: [{ tag: 'cpu.usage', value: 1, unit: 'percent', status: 'ok' }], problems: [], ok: true },
        { readerId: 'gpu', kind: 'devfreq_load', tags: [], problems: ['timed out'], ok: false },
      ],
    };
    expect(probeHint(mixed as never, 'serial')).toBeNull();
  });
});
