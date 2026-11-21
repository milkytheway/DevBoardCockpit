import { describe, it, expect } from 'vitest';
import { parseBoardValues } from '../../../src/shared/board-setup';
import { applyValues } from '../../../src/main/board/prepare';
import type { ConnectionProfile } from '../../../src/main/profiles/schema';

/**
 * The values the person confirmed ✓.
 *
 * | Criterion | Why |
 * |---|---|
 * | the payload is read as strings only | the renderer is not trusted ✓ |
 * | an empty field means "not given" | the field keeps its old value ✓ |
 * | only the fields of that transport are filled | the adb connection has no port ✓ · the ssh connection has no serial ✓ |
 * | the nested address is filled for every connection | the guest reaches the board through it ✓ |
 */

const ADB: ConnectionProfile = {
  id: 'board-adb',
  label: 'Board · ADB',
  transport: 'adb',
  board_pack: 'rk3588-atk',
  device_key: 'ATK-DLRK3588',
  options: { serial: '0000000000000000', ssh: { host: '192.0.2.100', port: 22 } },
};

const SSH: ConnectionProfile = {
  id: 'board-ssh',
  label: 'Board · SSH',
  transport: 'ssh',
  board_pack: 'rk3588-atk',
  device_key: 'ATK-DLRK3588',
  options: { host: '192.0.2.100', port: 22, username: 'root' },
};

const SERIAL: ConnectionProfile = {
  id: 'board-serial',
  label: 'Board · Serial',
  transport: 'serial',
  board_pack: 'rk3588-atk',
  device_key: 'ATK-DLRK3588',
  options: { port: 'COM3', baudrate: 1500000, ssh: { host: '192.0.2.100', port: 22 } },
};

const VALUES = {
  boardPack: 'rk3588-atk',
  adbSerial: 'a1b2c3d4e5f60718',
  address: '192.168.100.10',
  serialPort: 'COM7',
  keyFilename: 'C:\\Users\\me\\.ssh\\id_ed25519_board',
};

describe('the confirmed values · the payload', () => {
  it('**only strings are read** ✓ (the renderer is not trusted ✓)', () => {
    const values = parseBoardValues({
      boardPack: 'rk3588-atk',
      adbSerial: 42,
      address: ' 192.168.100.10 ',
      serialPort: null,
    });
    expect(values.adbSerial).toBe('');
    expect(values.address).toBe('192.168.100.10');
    expect(values.serialPort).toBe('');
  });

  it('**something that is not an object is empty** ✓', () => {
    expect(parseBoardValues('nonsense').address).toBe('');
    expect(parseBoardValues(null).boardPack).toBe('');
  });
});

describe('the confirmed values · the profiles', () => {
  it('**the adb connection gets the serial** ✓', () => {
    const profile = applyValues(ADB, VALUES);
    expect(profile.options['serial']).toBe('a1b2c3d4e5f60718');
  });

  it('**the ssh connection gets the address** ✓', () => {
    const profile = applyValues(SSH, VALUES);
    expect(profile.options['host']).toBe('192.168.100.10');
  });

  it('**the ssh connection gets the credential** ✓', () => {
    const profile = applyValues(SSH, VALUES);
    expect(profile.options['key_filename']).toBe('C:\\Users\\me\\.ssh\\id_ed25519_board');
  });

  it('**the serial connection gets the port** ✓', () => {
    const profile = applyValues(SERIAL, VALUES);
    expect(profile.options['port']).toBe('COM7');
  });

  it('**the nested address is filled for every connection** ✓ (the guest reaches the board through it ✓)', () => {
    for (const profile of [ADB, SERIAL]) {
      const filled = applyValues(profile, VALUES);
      const ssh = filled.options['ssh'] as { host: string };
      expect(ssh.host).toBe('192.168.100.10');
    }
  });

  it('**a field that was not given keeps its value** ✓', () => {
    const profile = applyValues(ADB, { ...VALUES, adbSerial: '' });
    expect(profile.options['serial']).toBe('0000000000000000');
  });

  it('**the connection that is not a board keeps its own address** ✓', () => {
    const guest: ConnectionProfile = {
      id: 'ubuntu-ssh',
      label: 'Guest',
      transport: 'ssh',
      options: { host: '198.51.100.10', port: 22 },
    };
    const profile = applyValues(guest, VALUES);
    expect(profile.options['host']).toBe('198.51.100.10');
  });
});
