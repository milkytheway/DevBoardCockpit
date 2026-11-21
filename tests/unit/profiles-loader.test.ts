import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProfiles } from '../../src/main/profiles/loader';

let builtin: string, user: string;
beforeEach(() => {
  builtin = mkdtempSync(join(tmpdir(), 'builtin-'));
  user = mkdtempSync(join(tmpdir(), 'user-'));
});
afterEach(() => {
  rmSync(builtin, { recursive: true, force: true });
  rmSync(user, { recursive: true, force: true });
});

const prof = (id: string) => JSON.stringify({ id, label: id, transport: 'local', options: {} });

describe('loadProfiles', () => {
  it('the built-in and the user directory are merged, one profile per id', () => {
    writeFileSync(join(builtin, 'a.json'), prof('dup'));
    writeFileSync(join(user, 'a.json'), JSON.stringify({ id: 'dup', label: 'the one of the user', transport: 'local', options: {} }));
    writeFileSync(join(builtin, 'b.json'), prof('b'));
    const list = loadProfiles({ builtinDir: builtin, userDir: user });
    expect(list.map(p => p.id).sort()).toEqual(['b', 'dup']);
    // → **The identity comes from the built-in profile** ✓ (the label is
    //   part of the identity ✓ — the shipped one wins ✓).
    expect(list.find(p => p.id === 'dup')!.label).toBe('dup');
  });

  it('a broken file does not drag the other profiles down', () => {
    writeFileSync(join(builtin, 'ok.json'), prof('ok'));
    writeFileSync(join(builtin, 'bad.json'), '{ not json');
    expect(loadProfiles({ builtinDir: builtin }).map(p => p.id)).toEqual(['ok']);
  });
});

/**
 * **The two layers of one profile** ✓.
 *
 * → The **identity** (`label` · `transport` · `board_pack` · `device_key`) is
 *   the **contract** of the connection ✓ — it says which board it is and
 *   which channel it uses ✓ — and it does not belong to one machine ✓.
 * → The **options** are the **machine-specific values** ✓ (the address ✓ ·
 *   the serial number ✓ · the serial port ✓ · the credential ✓) — they
 *   belong to the machine the profile is used on ✓.
 *
 * → The merge: **the identity comes from the built-in profile** ✓ and **the
 *   options are merged field by field** ✓ (the user's value wins ✓ · the
 *   built-in's fields that the user's copy does not name survive ✓).
 */
describe('loadProfiles · the two layers of one profile', () => {
  it('**the identity comes from the built-in profile** ✓ (the shipped fix reaches the machine ✓)', () => {
    writeFileSync(
      join(builtin, 'board-ssh.json'),
      JSON.stringify({
        id: 'board-ssh',
        label: 'Board · SSH',
        transport: 'ssh',
        board_pack: 'rk3588-atk',
        device_key: 'ATK-DLRK3588',
        options: { host: '192.0.2.100', port: 22, username: 'root' },
      }),
    );
    // → The copy in the user directory is **stale** ✓ (it carries the old name ✓)
    writeFileSync(
      join(user, 'board-ssh.json'),
      JSON.stringify({
        id: 'board-ssh',
        label: 'Board · SSH',
        transport: 'ssh',
        board_pack: 'rk3588-atk',
        device_key: 'atk-01',
        options: { host: '192.0.2.100', port: 22, username: 'root' },
      }),
    );
    const list = loadProfiles({ builtinDir: builtin, userDir: user });
    expect(list).toHaveLength(1);
    expect(list[0]!.device_key).toBe('ATK-DLRK3588');
  });

  it('**the machine-specific values come from the user directory** ✓', () => {
    writeFileSync(
      join(builtin, 'board-ssh.json'),
      JSON.stringify({
        id: 'board-ssh',
        label: 'Board · SSH',
        transport: 'ssh',
        board_pack: 'rk3588-atk',
        device_key: 'ATK-DLRK3588',
        options: { host: '192.0.2.100', port: 22, username: 'root' },
      }),
    );
    writeFileSync(
      join(user, 'board-ssh.json'),
      JSON.stringify({
        id: 'board-ssh',
        label: 'Board · SSH',
        transport: 'ssh',
        board_pack: 'rk3588-atk',
        device_key: 'ATK-DLRK3588',
        options: { host: '192.168.5.100', port: 22, username: 'root' },
      }),
    );
    const list = loadProfiles({ builtinDir: builtin, userDir: user });
    expect(list[0]!.options['host']).toBe('192.168.5.100');
  });

  it('**a built-in option that the user copy does not name survives** ✓ (a shipped default reaches the machine ✓)', () => {
    writeFileSync(
      join(builtin, 'board-ssh.json'),
      JSON.stringify({
        id: 'board-ssh',
        label: 'Board · SSH',
        transport: 'ssh',
        board_pack: 'rk3588-atk',
        device_key: 'ATK-DLRK3588',
        options: { host: '192.0.2.100', port: 22, username: 'root', key_filename: 'C:\\keys\\board' },
      }),
    );
    writeFileSync(
      join(user, 'board-ssh.json'),
      JSON.stringify({
        id: 'board-ssh',
        label: 'Board · SSH',
        transport: 'ssh',
        board_pack: 'rk3588-atk',
        device_key: 'ATK-DLRK3588',
        options: { host: '192.168.5.100', port: 22, username: 'root' },
      }),
    );
    const list = loadProfiles({ builtinDir: builtin, userDir: user });
    expect(list[0]!.options['key_filename']).toBe('C:\\keys\\board');
    expect(list[0]!.options['host']).toBe('192.168.5.100');
  });

  it('**a profile that only the user directory has is used as it is** ✓ (the wizard\\u2019s own board ✓)', () => {
    writeFileSync(
      join(user, 'board-atk-01.json'),
      JSON.stringify({
        id: 'board-atk-01',
        label: 'Board · ATK-01',
        transport: 'serial',
        board_pack: 'atk-01',
        device_key: 'atk-01',
        options: { port: 'COM7', baudrate: 1500000 },
      }),
    );
    const list = loadProfiles({ builtinDir: builtin, userDir: user });
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe('board-atk-01');
    expect(list[0]!.options['port']).toBe('COM7');
  });

  it('**a stale copy in the user directory is reported** ✓ (the person learns that it was ignored ✓)', () => {
    writeFileSync(
      join(builtin, 'board-ssh.json'),
      JSON.stringify({
        id: 'board-ssh',
        label: 'Board · SSH',
        transport: 'ssh',
        board_pack: 'rk3588-atk',
        device_key: 'ATK-DLRK3588',
        options: { host: '192.0.2.100' },
      }),
    );
    writeFileSync(
      join(user, 'board-ssh.json'),
      JSON.stringify({
        id: 'board-ssh',
        label: 'Board · SSH',
        transport: 'ssh',
        board_pack: 'rk3588-atk',
        device_key: 'atk-01',
        options: { host: '192.0.2.100' },
      }),
    );
    const warnings: string[] = [];
    loadProfiles({ builtinDir: builtin, userDir: user, warn: (m) => warnings.push(m) });
    expect(warnings.some((m) => m.includes('board-ssh') && m.includes('atk-01'))).toBe(true);
  });

  it('**an option of the user copy that the transport does not allow is dropped** ✓ (not a broken profile ✓)', () => {
    writeFileSync(
      join(builtin, 'board.json'),
      JSON.stringify({
        id: 'board',
        label: 'Board · SSH',
        transport: 'ssh',
        board_pack: 'rk3588-atk',
        device_key: 'ATK-DLRK3588',
        options: { host: '192.0.2.100' },
      }),
    );
    // → The copy in the user directory was written for **another transport**
    //   ✓ (it is a valid profile on its own ✓) → its options do not fit the
    //   shipped transport ✓ → they are dropped ✓.
    writeFileSync(
      join(user, 'board.json'),
      JSON.stringify({
        id: 'board',
        label: 'Board · Serial',
        transport: 'serial',
        board_pack: 'rk3588-atk',
        device_key: 'ATK-DLRK3588',
        options: { port: 'COM3', baudrate: 1500000 },
      }),
    );
    const list = loadProfiles({ builtinDir: builtin, userDir: user });
    expect(list).toHaveLength(1);
    // → The identity comes from the built-in profile ✓
    expect(list[0]!.transport).toBe('ssh');
    expect(list[0]!.options['host']).toBe('192.0.2.100');
    // → The options that do not fit are gone ✓ (`port` is the ssh default ✓,
    //   not the serial port of the other copy ✓)
    expect(list[0]!.options['port']).toBe(22);
    expect(list[0]!.options['baudrate']).toBeUndefined();
  });
});
