import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProfile, modelMatches } from '../../../src/main/board/resolve';
import { persistProfile } from '../../../src/main/board/persist';
import type { ConnectionProfile } from '../../../src/main/profiles/schema';
import type { PortProbe } from '../../../src/main/board/detect';
import type { SpawnResult } from '../../../src/main/util/spawn';

/**
 * The resolution of the machine-specific values ✓.
 *
 * | Criterion | Why |
 * |---|---|
 * | the pinned serial that is really there is left alone | the profile is already right ✗ → nothing to detect ✓ |
 * | exactly one board → its serial is filled in | one candidate is not a choice ✓ |
 * | several boards → nothing is chosen | "never guess" ✓ — the user has to say ✓ |
 * | a board that is not this board is not adopted | the model has to match ✓ |
 * | the placeholder address is replaced by the address the board reports | the shipped value can never work ✓ |
 * | the address cannot be read → the problem says so | the message has to name the placeholder ✓ |
 * | one answering serial port → it is filled in | only a port that answers is the console ✓ |
 * | the user's own file is never overwritten | it is the person's configuration ✓ |
 */

function result(stdout: string): SpawnResult {
  return { exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false };
}

/** A runner that answers by what the command asks for */
function runnerOf(answers: { devices?: string; address?: string; model?: string }) {
  return async (_command: string, args: string[]): Promise<SpawnResult> => {
    const key = args.join(' ');
    if (key.includes('devices')) return result(answers.devices ?? '');
    if (key.includes('ip -4 addr show')) return result(answers.address ?? '');
    if (key.includes('device-tree/model')) return result(answers.model ?? '');
    return result('');
  };
}

const ADB_PROFILE: ConnectionProfile = {
  id: 'board-adb',
  label: 'Board · ADB',
  transport: 'adb',
  board_pack: 'rk3588-atk',
  device_key: 'atk-01',
  options: {
    pty: false,
    serial: '0000000000000000',
    ssh: { host: '192.0.2.100', port: 22, username: 'root' },
  },
};

describe('the resolution · the adb serial', () => {
  it('**the pinned serial that is really there is left alone** ✓', async () => {
    const outcome = await resolveProfile(
      { ...ADB_PROFILE, options: { ...ADB_PROFILE.options, serial: 'a1b2c3d4e5f60718' } },
      { runner: runnerOf({ devices: 'a1b2c3d4e5f60718\tdevice' }) },
    );
    expect(outcome.changes).toEqual([]);
    expect(outcome.profile.options['serial']).toBe('a1b2c3d4e5f60718');
  });

  it('**exactly one board → its serial is filled in** ✓', async () => {
    const outcome = await resolveProfile(ADB_PROFILE, {
      runner: runnerOf({ devices: 'a1b2c3d4e5f60718\tdevice', model: 'ATK-DLRK3588 Board' }),
      expectedModels: ['ATK-DLRK3588'],
    });
    expect(outcome.profile.options['serial']).toBe('a1b2c3d4e5f60718');
    expect(outcome.changes.map((change) => change.field)).toContain('options.serial');
    expect(outcome.problems).toEqual([]);
  });

  it('**several boards → nothing is chosen** ✓ (the user has to say which one ✓)', async () => {
    const outcome = await resolveProfile(ADB_PROFILE, {
      runner: runnerOf({ devices: 'aaa\tdevice\nbbb\tdevice' }),
      expectedModels: ['ATK-DLRK3588'],
    });
    expect(outcome.profile.options['serial']).toBe('0000000000000000');
    expect(outcome.problems.join(' ')).toMatch(/2 boards/);
  });

  it('**a board that is not this board is not adopted** ✓', async () => {
    const outcome = await resolveProfile(ADB_PROFILE, {
      runner: runnerOf({ devices: 'other-device\tdevice', model: 'Raspberry Pi 5' }),
      expectedModels: ['ATK-DLRK3588'],
    });
    expect(outcome.profile.options['serial']).toBe('0000000000000000');
    expect(outcome.problems.join(' ')).toMatch(/Raspberry Pi 5/);
  });

  it('**no board at all → the message says so** ✓', async () => {
    const outcome = await resolveProfile(ADB_PROFILE, {
      runner: runnerOf({ devices: '' }),
      expectedModels: ['ATK-DLRK3588'],
    });
    expect(outcome.problems.join(' ')).toMatch(/no board/);
  });
});

describe('the resolution · the address of the board', () => {
  it('**the placeholder address is replaced by the address the board reports** ✓', async () => {
    const outcome = await resolveProfile(
      {
        id: 'board-ssh',
        label: 'Board · SSH',
        transport: 'ssh',
        board_pack: 'rk3588-atk',
        device_key: 'atk-01',
        options: { host: '192.0.2.100', port: 22, username: 'root' },
      },
      {
        runner: runnerOf({
          devices: 'a1b2c3d4e5f60718\tdevice',
          address: '    inet 192.168.100.10/24 scope global eth0',
          model: 'ATK-DLRK3588 Board',
        }),
        expectedModels: ['ATK-DLRK3588'],
      },
    );
    expect(outcome.profile.options['host']).toBe('192.168.100.10');
    expect(outcome.changes.map((change) => change.field)).toContain('options.host');
  });

  it('**the nested address (the guest reaches the board through it) is replaced too** ✓', async () => {
    const outcome = await resolveProfile(ADB_PROFILE, {
      runner: runnerOf({
        devices: 'a1b2c3d4e5f60718\tdevice',
        address: '    inet 192.168.100.10/24 scope global eth0',
        model: 'ATK-DLRK3588 Board',
      }),
      expectedModels: ['ATK-DLRK3588'],
    });
    const ssh = outcome.profile.options['ssh'] as { host: string };
    expect(ssh.host).toBe('192.168.100.10');
  });

  it('**the address cannot be read → the problem names the placeholder** ✓', async () => {
    const outcome = await resolveProfile(
      {
        id: 'board-ssh',
        label: 'Board · SSH',
        transport: 'ssh',
        board_pack: 'rk3588-atk',
        device_key: 'atk-01',
        options: { host: '192.0.2.100', port: 22, username: 'root' },
      },
      { runner: runnerOf({ devices: '' }) },
    );
    expect(outcome.profile.options['host']).toBe('192.0.2.100');
    expect(outcome.problems.join(' ')).toMatch(/adb sees no board/);
  });

  it('**a real address is left alone** ✓', async () => {
    const outcome = await resolveProfile(
      {
        id: 'board-ssh',
        label: 'Board · SSH',
        transport: 'ssh',
        board_pack: 'rk3588-atk',
        device_key: 'atk-01',
        options: { host: '192.168.100.10', port: 22, username: 'root' },
      },
      {
        runner: runnerOf({
          devices: 'a1b2c3d4e5f60718\tdevice',
          address: '    inet 192.168.100.10/24 scope global eth0',
        }),
      },
    );
    expect(outcome.changes).toEqual([]);
  });
});

describe('the resolution · the serial port', () => {
  const SERIAL_PROFILE: ConnectionProfile = {
    id: 'board-serial',
    label: 'Board · Serial',
    transport: 'serial',
    board_pack: 'rk3588-atk',
    device_key: 'atk-01',
    options: { port: 'COM3', baudrate: 1500000, pty: true },
  };

  const probe = (answers: Record<string, string>, list?: string[]): PortProbe => ({
    list: async () => (list ?? Object.keys(answers)).map((path) => ({ path })),
    probe: async (path) => {
      const text = answers[path];
      if (text === undefined) throw new Error('the port could not be opened');
      return text;
    },
  });

  it('**one answering port → it is filled in** ✓', async () => {
    const outcome = await resolveProfile(SERIAL_PROFILE, {
      runner: runnerOf({ devices: '' }),
      ports: probe({ COM3: '', COM7: 'ATK-DLRK3588 login:' }),
    });
    expect(outcome.profile.options['port']).toBe('COM7');
  });

  it('**the configured port answers → nothing is changed** ✓ (it is the board console ✓)', async () => {
    const outcome = await resolveProfile(SERIAL_PROFILE, {
      runner: runnerOf({ devices: '' }),
      ports: probe({ COM3: 'ATK-DLRK3588 login:', COM7: 'something else' }),
    });
    expect(outcome.profile.options['port']).toBe('COM3');
    expect(outcome.changes).toEqual([]);
  });

  it('**several answering ports → nothing is chosen** ✓', async () => {
    const outcome = await resolveProfile(SERIAL_PROFILE, {
      runner: runnerOf({ devices: '' }),
      ports: probe({ COM3: '', COM7: 'ATK-DLRK3588 login:', COM9: 'other board' }),
    });
    expect(outcome.profile.options['port']).toBe('COM3');
    expect(outcome.problems.join(' ')).toMatch(/2 serial ports answered/);
  });

  it('**a busy port is not a silent port** ✓ (the application must not look for another one ✓)', async () => {
    // The port cannot be opened → another program holds it ✓ (the runtime's
    // own connection ✓) → the honest error is "busy" ✓
    const outcome = await resolveProfile(SERIAL_PROFILE, {
      runner: runnerOf({ devices: '' }),
      ports: probe({ COM7: 'ATK-DLRK3588 login:' }, ['COM3', 'COM7']),
    });
    expect(outcome.profile.options['port']).toBe('COM3');
    expect(outcome.changes).toEqual([]);
    expect(outcome.problems.join(' ')).not.toMatch(/serial ports answered/);
  });

  it('**no port answers → the problem says so** ✓', async () => {
    const outcome = await resolveProfile(SERIAL_PROFILE, {
      runner: runnerOf({ devices: '' }),
      ports: probe({ COM3: '', COM7: '' }),
    });
    expect(outcome.problems.join(' ')).toMatch(/no serial port answered/);
  });
});

describe('the model match', () => {
  it('**an empty expectation takes every model** ✓', () => {
    expect(modelMatches('anything', [])).toBe(true);
  });

  it('**substring matching, case-insensitive** ✓', () => {
    expect(modelMatches('ALIENTEK ATK-DLRK3588', ['atk-dlrk3588'])).toBe(true);
    expect(modelMatches('Raspberry Pi 5', ['atk-dlrk3588'])).toBe(false);
  });
});

describe('the persistence', () => {
  it('**the profile is written into the user directory** ✓', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-user-profiles-'));
    const out = persistProfile(ADB_PROFILE, dir);
    expect(out.written).toBe(true);
    expect(existsSync(join(dir, 'board-adb.json'))).toBe(true);
    const written = JSON.parse(readFileSync(join(dir, 'board-adb.json'), 'utf8')) as ConnectionProfile;
    expect(written.id).toBe('board-adb');
  });

  it("**the user's own file is never overwritten** ✓", () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-user-profiles-'));
    persistProfile(ADB_PROFILE, dir);
    const second = persistProfile(
      { ...ADB_PROFILE, options: { ...ADB_PROFILE.options, serial: 'other' } },
      dir,
    );
    expect(second.written).toBe(false);
    const written = JSON.parse(readFileSync(join(dir, 'board-adb.json'), 'utf8')) as ConnectionProfile;
    expect(written.options['serial']).toBe('0000000000000000');
  });
});

/**
 * **The machine's own values** ✓ — the address of a machine that is not a
 * board ✓ and the credential ✓.
 *
 * | Criterion | Why |
 * |---|---|
 * | the address of the guest comes from the ssh records | it is the person's own ✓ — the board's address must never leak into it ✓ |
 * | the credential is the key that authenticates | a key that does not authenticate is not the credential ✓ |
 * | a profile that names a credential keeps it | the person's own choice ✓ |
 * | no key authenticates → it is reported | the failure has to say which problem it is ✓ |
 */
const GUEST: ConnectionProfile = {
  id: 'ubuntu-ssh',
  label: 'Ubuntu · SSH',
  transport: 'ssh',
  options: { host: '198.51.100.10', port: 22, username: 'alientek' },
};

const RECORDS = {
  addresses: ['192.168.136.131'],
  keys: [] as string[],
};

/** A key file that really exists ✓ (the candidates are read from the disk ✓) */
function keyFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-keys-'));
  const path = join(dir, name);
  writeFileSync(path, 'KEY', 'utf8');
  return path;
}

/** A probe that accepts exactly one key ✓ */
function probeOf(accepted: string) {
  return async (
    _target: { host: string; port: number; username: string },
    candidate: { path: string; key: Buffer },
  ): Promise<boolean> => candidate.path === accepted;
}

describe('the resolution · the address of a machine', () => {
  it('**the address comes from the ssh records of this machine** ✓', async () => {
    const outcome = await resolveProfile(GUEST, {
      runner: runnerOf({ devices: '' }),
      ssh: RECORDS,
      probeCredential: probeOf(''),
    });
    expect(outcome.profile.options['host']).toBe('192.168.136.131');
    expect(outcome.changes.map((c) => c.field)).toContain('options.host');
  });

  it('**the guest never gets the address of the board** ✓ (adb is not asked at all ✓)', async () => {
    let called = false;
    const outcome = await resolveProfile(GUEST, {
      runner: async () => {
        called = true;
        return result('a1b2c3d4e5f60718\tdevice');
      },
      ssh: RECORDS,
      probeCredential: probeOf(''),
    });
    expect(called).toBe(false);
    expect(outcome.profile.options['host']).toBe('192.168.136.131');
  });

  it('**several addresses → the person says which one** ✓ (the value that is there stays ✓)', async () => {
    const outcome = await resolveProfile(GUEST, {
      runner: runnerOf({ devices: '' }),
      ssh: { addresses: ['192.168.136.131', '10.0.0.5'], keys: RECORDS.keys },
      probeCredential: probeOf(''),
    });
    expect(outcome.profile.options['host']).toBe('198.51.100.10');
    expect(outcome.problems.join(' ')).toMatch(/2 ssh addresses/);
  });
});

describe('the resolution · the credential', () => {
  it('**the key that authenticates becomes the credential** ✓', async () => {
    const key = keyFile('id_ed25519_codex_vm');
    const outcome = await resolveProfile(GUEST, {
      runner: runnerOf({ devices: '' }),
      ssh: { addresses: RECORDS.addresses, keys: [key] },
      probeCredential: probeOf(key),
    });
    expect(outcome.profile.options['key_filename']).toBe(key);
    expect(outcome.changes.map((c) => c.field)).toContain('options.key_filename');
  });

  it('**a profile that names a credential keeps it** ✓ (the search does not run ✓)', async () => {
    let probed = false;
    const mine = keyFile('mine');
    const outcome = await resolveProfile(
      { ...GUEST, options: { ...GUEST.options, key_filename: mine } },
      {
        runner: runnerOf({ devices: '' }),
        ssh: RECORDS,
        probeCredential: async () => {
          probed = true;
          return true;
        },
      },
    );
    expect(probed).toBe(false);
    expect(outcome.profile.options['key_filename']).toBe(mine);
  });

  it('**no key authenticates → it is reported** ✓ (the caller has to say so ✓)', async () => {
    const key = keyFile('id_ed25519_codex_vm');
    const outcome = await resolveProfile(GUEST, {
      runner: runnerOf({ devices: '' }),
      ssh: { addresses: RECORDS.addresses, keys: [key] },
      probeCredential: probeOf('something-else'),
    });
    expect(outcome.profile.options['key_filename']).toBeUndefined();
    expect(outcome.problems.join(' ')).toMatch(/none of the 1 private keys/);
  });

  it('**the ssh connection of the board gets the key of the board** ✓', async () => {
    const key = keyFile('id_ed25519_codex_board');
    const outcome = await resolveProfile(
      {
        ...GUEST,
        id: 'board-ssh',
        board_pack: 'rk3588-atk',
        options: { host: '192.168.5.100', port: 22, username: 'root' },
      },
      {
        runner: runnerOf({ devices: '' }),
        ssh: { addresses: RECORDS.addresses, keys: [key] },
        probeCredential: probeOf(key),
      },
    );
    expect(outcome.profile.options['key_filename']).toBe(key);
  });
});
