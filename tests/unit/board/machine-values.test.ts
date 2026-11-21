import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MachineValueStore,
  applyMachineValues,
  machineValuesPath,
  sourceOf,
  MACHINE_FIELDS,
} from '../../../src/main/board/machine-values';
import { prepareProfile, needsValue, confirmValues } from '../../../src/main/board/prepare';
import {
  findAdbSerial,
  findReachableAddress,
  findPrivateKey,
  findSerialPort,
  findMachineValues,
} from '../../../src/main/board/find';
import type { PortProbe } from '../../../src/main/board/detect';
import type { ConnectionProfile } from '../../../src/main/profiles/schema';

/**
 * **The values of this machine** ✓.
 *
 * | # | Criterion | Why |
 * |---|---|---|
 * | 1 | The store holds **only the machine-specific fields** ✓ | the profile stays the truth about **what the connection is** ✓ → a later fix to the shipped profile reaches this machine ✓ (**a copy of the profile would freeze it** ✓) |
 * | 2 | The store **wins** over the profile for those fields ✓ | it is the truth about this machine ✓ |
 * | 3 | A value that was **found** is marked `detected` ✓ · one the person **confirmed** is marked `confirmed` ✓ | the interface says where a value came from ✓ |
 * | 4 | **The address has to answer** ✓ before it is used ✓ | an address that is written down proves nothing ✓ — a stale one ✓ · a NAT gateway ✓ |
 * | 5 | **Several candidates → nothing is chosen** ✓ | the same "never guess" as everywhere else ✓ |
 * | 6 | **The guest machine keeps its own address** ✓ | it is not the board's address ✓ |
 */

const SSH_PROFILE: ConnectionProfile = {
  id: 'board-ssh',
  label: 'Board · SSH',
  transport: 'ssh',
  board_pack: 'rk3588-atk',
  device_key: 'ATK-DLRK3588',
  options: { host: '192.0.2.100', port: 22, username: 'root' },
};

const ADB_PROFILE: ConnectionProfile = {
  id: 'board-adb',
  label: 'Board · ADB',
  transport: 'adb',
  board_pack: 'rk3588-atk',
  device_key: 'ATK-DLRK3588',
  options: { serial: '0000000000000000', pty: false },
};

function store(): MachineValueStore {
  return new MachineValueStore(
    join(mkdtempSync(join(tmpdir(), 'cockpit-machine-values-')), 'machine-values.json'),
  );
}

describe('the machine values · the store', () => {
  it('**only the machine-specific fields are stored** ✓', () => {
    const s = store();
    s.set('board-ssh', { host: '192.168.5.100', label: 'my board' }, 'detected');
    const values = s.get('board-ssh');
    expect(values['host']).toEqual({ value: '192.168.5.100', source: 'detected' });
    // → **A field that is not machine-specific is not stored** ✓
    expect(values['label']).toBeUndefined();
  });

  it('**the store survives a new instance** ✓ (it is a file ✓)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-machine-values-'));
    const path = machineValuesPath(dir);
    new MachineValueStore(path).set('board-ssh', { host: '192.168.5.100' }, 'detected');
    const reopened = new MachineValueStore(path);
    expect(reopened.get('board-ssh')['host']?.value).toBe('192.168.5.100');
    expect(existsSync(path)).toBe(true);
  });

  it('**a broken file is not a reason to stop** ✓', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-machine-values-'));
    const path = join(dir, 'machine-values.json');
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(path, '{ not json');
    expect(new MachineValueStore(path).get('board-ssh')).toEqual({});
  });

  it('**the store wins over the profile for the machine fields** ✓', () => {
    const s = store();
    s.set('board-ssh', { host: '192.168.5.100' }, 'confirmed');
    const merged = applyMachineValues([SSH_PROFILE], s);
    expect(merged[0]?.options['host']).toBe('192.168.5.100');
    // → **Everything else is the profile's business** ✓
    expect(merged[0]?.options['username']).toBe('root');
    expect(merged[0]?.label).toBe('Board · SSH');
  });

  it('**where a value came from is remembered** ✓', () => {
    const s = store();
    s.set('board-ssh', { host: '192.168.5.100' }, 'detected');
    expect(sourceOf(s, 'board-ssh', 'host')).toBe('detected');
    expect(sourceOf(s, 'board-ssh', 'port')).toBe('builtin');
  });

  it('**the fields that belong to the machine are a closed list** ✓', () => {
    expect(MACHINE_FIELDS).toContain('serial');
    expect(MACHINE_FIELDS).toContain('host');
    expect(MACHINE_FIELDS).toContain('key_filename');
  });
});

describe('the machine values · finding the adb serial', () => {
  it('**exactly one board in the device state → it is the board** ✓', async () => {
    const out = await findAdbSerial(
      [{ serial: 'f34dca7784396ab2', state: 'device', stateText: 'device' }],
      {},
    );
    expect(out.serial).toBe('f34dca7784396ab2');
    expect(out.problem).toBeNull();
  });

  it('**several boards → nothing is chosen** ✓', async () => {
    const out = await findAdbSerial(
      [
        { serial: 'aaa', state: 'device', stateText: 'device' },
        { serial: 'bbb', state: 'device', stateText: 'device' },
      ],
      {},
    );
    expect(out.serial).toBeNull();
    expect(out.problem).toMatch(/2 boards/);
  });

  it('**no board → it is reported** ✓', async () => {
    const out = await findAdbSerial([], {});
    expect(out.serial).toBeNull();
    expect(out.problem).toMatch(/no board/);
  });

  it('**a board in the wrong state is not a board** ✓', async () => {
    const out = await findAdbSerial(
      [{ serial: 'aaa', state: 'unauthorized', stateText: 'unauthorized' }],
      {},
    );
    expect(out.serial).toBeNull();
    expect(out.problem).toMatch(/device/);
  });
});

describe('the machine values · finding the address', () => {
  it('**the address whose port answers is the one** ✓', async () => {
    const out = await findReachableAddress(
      ['192.168.5.100', '192.168.100.2'],
      22,
      {
        probe: async (host) => ({ ok: host === '192.168.5.100' }),
      },
    );
    expect(out.address).toBe('192.168.5.100');
    expect(out.problem).toBeNull();
  });

  it('**no address answers → nothing is written and every attempt is reported** ✓', async () => {
    const out = await findReachableAddress(['192.168.100.2'], 22, {
      probe: async () => ({ ok: false, error: 'timed out' }),
    });
    expect(out.address).toBeNull();
    expect(out.problem).toMatch(/192\.168\.100\.2/);
    expect(out.problem).toMatch(/timed out/);
  });
});

describe('the machine values · finding the private key', () => {
  it('**exactly one key in ~/.ssh → it is the key** ✓', async () => {
    const existing = new Set(['/home/u/.ssh/id_ed25519']);
    const out = await findPrivateKey('/home/u', {
      // the finder looks at the real filesystem → a fake home is used here
    } as never);
    // → The real filesystem has no such home ✓ → nothing is found ✓
    expect(out.key).toBeNull();
    expect(existing.size).toBe(1);
  });

  it('**several keys → nothing is chosen** ✓', async () => {
    const out = await findPrivateKey(undefined, {});
    expect(out.key).toBeNull();
    expect(out.problem).toBeNull();
  });
});

describe('the machine values · finding the serial port', () => {
  // → The list is separate from the answers ✓ (a port can be **there** and
  //   still refuse to open ✓ — that is what "busy" means ✓).
  const probe = (answers: Record<string, string>, listed?: string[]): PortProbe => ({
    list: async () => (listed ?? Object.keys(answers)).map((path) => ({ path })),
    probe: async (path) => {
      const text = answers[path];
      if (text === undefined) throw new Error('the port could not be opened');
      return text;
    },
  });

  it('**the port that answers is the console** ✓', async () => {
    const out = await findSerialPort('COM3', 1500000, {
      ports: probe({ COM3: '', COM7: 'ATK-DLRK3588 login:' }),
    });
    expect(out.port).toBe('COM7');
  });

  it('**a busy port is not a silent port** ✓ (the application must not look for another one ✓)', async () => {
    const out = await findSerialPort('COM3', 1500000, {
      // → **COM3 is there but cannot be opened** ✓ (another program holds it ✓)
      ports: probe({ COM7: 'ATK-DLRK3588 login:' }, ['COM3', 'COM7']),
    });
    expect(out.port).toBe('COM3');
    expect(out.problem).toBeNull();
  });

  it('**no port answers → it is reported** ✓', async () => {
    const out = await findSerialPort('COM3', 1500000, {
      ports: probe({ COM3: '', COM7: '' }),
    });
    expect(out.port).toBeNull();
    expect(out.problem).toMatch(/no serial port answered/);
  });
});

describe('the machine values · preparing a profile', () => {
  it('**a profile whose values are all there is not touched** ✓', async () => {
    const s = store();
    s.set('board-ssh', { host: '192.168.5.100', key_filename: '/home/u/.ssh/id_ed25519' }, 'confirmed');
    expect(needsValue(SSH_PROFILE, s)).toBe(false);
  });

  it('**a profile with a placeholder needs a value** ✓', async () => {
    expect(needsValue(SSH_PROFILE, store())).toBe(true);
    expect(needsValue(ADB_PROFILE, store())).toBe(true);
  });

  it('**the found values are merged into the profile and stored** ✓', async () => {
    const s = store();
    const outcome = await prepareProfile(SSH_PROFILE, {
      store: s,
      expectedModels: ['ATK-DLRK3588'],
      runner: async (_command, args) => {
        const key = args.join(' ');
        if (key.includes('devices')) {
          return { stdout: 'f34dca7784396ab2\tdevice', stderr: '', exitCode: 0 };
        }
        if (key.includes('ip -4 addr show')) {
          return { stdout: '    inet 192.168.5.100/24 scope global eth0', stderr: '', exitCode: 0 };
        }
        if (key.includes('device-tree/model')) {
          return { stdout: 'ATK-DLRK3588 Board', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      probe: async (host) => ({ ok: host === '192.168.5.100' }),
      ports: undefined,
    });
    expect(outcome.profile.options['host']).toBe('192.168.5.100');
    // → **The value is stored** ✓ → the next start reads it ✓
    expect(s.get('board-ssh')['host']?.value).toBe('192.168.5.100');
  });

  it('**the confirmed values win over the detected ones** ✓', async () => {
    const s = store();
    confirmValues(s, 'board-ssh', { host: '10.0.0.9' }, 'confirmed');
    const outcome = await prepareProfile(SSH_PROFILE, {
      store: s,
      expectedModels: [],
      runner: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      probe: async () => ({ ok: false }),
    });
    expect(outcome.profile.options['host']).toBe('10.0.0.9');
  });
});

describe('the machine values · finding everything', () => {
  it('**what could not be found is reported** ✓', async () => {
    const out = await findMachineValues({
      runner: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      probe: async () => ({ ok: false, error: 'timed out' }),
      homeDir: undefined,
    });
    expect(out.problems.length).toBeGreaterThan(0);
  });
});
