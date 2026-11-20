import { describe, it, expect } from 'vitest';
import { parseProfile, deviceKeyOf, deviceKeyConflicts } from '../../../src/main/profiles/schema';

/**
 * The two new fields of a connection profile (contract `spec/02` §10.1–10.3).
 *
 * `device_key`: **the board itself** and **the connection** are two layers:
 *
 * → One board has **three connections, ADB / serial / SSH**, so **the
 *   interface groups by board**, which means it has to know **which
 *   connections are the same board** — that is what this is for.
 * → **The default is the `id`** (a connection with one board and one link
 *   simply does that).
 *
 * `options.ssh`: the SSH endpoint of **the machine behind this connection**:
 *
 * → **An action across machines is started on the other machine**, so that
 *   command has to use **the SSH address of the board**, and **the workflow
 *   pack should not know the address of the board** — **it follows the
 *   profile**.
 */
describe('the connection profile · device_key and options.ssh', () => {
  it('**the default of `device_key` is the profile id**', () => {
    const p = parseProfile(
      { id: 'board-adb', label: 'the board', transport: 'adb', options: {} },
      'x.json',
    );
    expect(p.device_key).toBe('board-adb');
  });

  it('**`device_key` may be written explicitly** (**the several connections of one board write the same one**)', () => {
    const p = parseProfile(
      {
        id: 'board-adb',
        label: 'the board',
        transport: 'adb',
        device_key: 'atk-01',
        options: {},
      },
      'x.json',
    );
    expect(p.device_key).toBe('atk-01');
  });

  it('**`device_key` has to be a string**', () => {
    expect(() =>
      parseProfile(
        { id: 'x', label: 'x', transport: 'adb', device_key: 7, options: {} },
        'x.json',
      ),
    ).toThrow(/device_key/);
  });

  it('**`options.ssh` may be carried** (**a fact that crosses the transports**)', () => {
    const p = parseProfile(
      {
        id: 'board-adb',
        label: 'the board',
        transport: 'adb',
        options: { ssh: { host: '192.168.5.100', port: 22, username: 'root' } },
      },
      'x.json',
    );
    expect(p.options['ssh']).toEqual({ host: '192.168.5.100', port: 22, username: 'root' });
  });

  it('**a profile of the ssh transport may not carry `options.ssh`** (**it is the endpoint itself** — writing it twice means drift)', () => {
    // **The criterion has to be exact** — "unknown field 'ssh'" also contains the
// word ssh, and that would **pass by accident**
    expect(() =>
      parseProfile(
        {
          id: 'board-ssh',
          label: 'the board',
          transport: 'ssh',
          options: { host: '192.168.5.100', ssh: { host: '192.168.5.100' } },
        },
        'x.json',
      ),
    ).toThrow(/makes it drift/);
  });

  it('**a profile of the local transport may not carry `options.ssh`** (it is the host itself)', () => {
    expect(() =>
      parseProfile(
        {
          id: 'local',
          label: 'this machine',
          transport: 'local',
          options: { ssh: { host: '1.2.3.4' } },
        },
        'x.json',
      ),
    ).toThrow(/the host itself/);
  });

  it('**the shape of `options.ssh` is closed** (an unknown key is reported — **the key of the inner level**)', () => {
    expect(() =>
      parseProfile(
        {
          id: 'board-adb',
          label: 'the board',
          transport: 'adb',
          options: { ssh: { host: '1.2.3.4', key: '/root/.ssh/id' } },
        },
        'x.json',
      ),
    ).toThrow(/Unknown field 'key'/);
  });

  it('**`options.ssh.host` is mandatory**', () => {
    expect(() =>
      parseProfile(
        {
          id: 'board-adb',
          label: 'the board',
          transport: 'adb',
          options: { ssh: { port: 22 } },
        },
        'x.json',
      ),
    ).toThrow(/host is required/);
  });

  it('**an unknown top-level field is reported** (a field other than `device_key` is still reported)', () => {
    expect(() =>
      parseProfile(
        { id: 'x', label: 'x', transport: 'adb', options: {}, board: 'atk' },
        'x.json',
      ),
    ).toThrow(/Unknown field 'board'/);
  });

  it('**`deviceKeyOf` is the only way to read the value** (**the default falls back to the id**)', () => {
    // **No `device_key` was written** → **it is the profile id**
    expect(deviceKeyOf({ id: 'x', label: 'x', transport: 'adb', options: {} })).toBe('x');
    // **It was written** → **it is that one**
    expect(
      deviceKeyOf({ id: 'x', label: 'x', transport: 'adb', device_key: 'atk-01', options: {} }),
    ).toBe('atk-01');
  });
});

/**
 * **One `device_key` may only stand for one board** (contract `spec/02`
 * §10.2).
 *
 * → **One board has one model**, so the same `device_key` declaring **two
 *   board packs** is **a configuration mistake** and **it has to be said**
 *   (**not silently**).
 */
describe('the connection profile · a conflict of the device_key', () => {
  const board = (id: string, key: string, pack: string | null) =>
    parseProfile(
      { id, label: id, transport: 'adb', board_pack: pack, device_key: key, options: {} },
      `${id}.json`,
    );

  it('**the same key + the same board pack → no conflict**', () => {
    const conflicts = deviceKeyConflicts([
      board('board-adb', 'atk-01', 'rk3588-atk'),
      board('board-ssh', 'atk-01', 'rk3588-atk'),
    ]);
    expect(conflicts).toEqual([]);
  });

  it('**the same key + two board packs → a conflict** (**one board cannot have two models**)', () => {
    const conflicts = deviceKeyConflicts([
      board('board-adb', 'atk-01', 'rk3588-atk'),
      board('board-other', 'atk-01', 'rk3588-other'),
    ]);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]?.device_key).toBe('atk-01');
    // **It states which two**
    expect(conflicts[0]?.profile_ids.sort()).toEqual(['board-adb', 'board-other']);
  });

  it('**different keys → no conflict** (**two boards of the same model** — they **share one pack**, but they are not one board)', () => {
    const conflicts = deviceKeyConflicts([
      board('board-a', 'atk-01', 'rk3588-atk'),
      board('board-b', 'atk-02', 'rk3588-atk'),
    ]);
    expect(conflicts).toEqual([]);
  });
});
