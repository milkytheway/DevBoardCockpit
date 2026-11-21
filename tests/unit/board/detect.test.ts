import { describe, it, expect } from 'vitest';
import {
  parseAdbDevices,
  parseIPv4,
  isPlaceholderHost,
  isPlaceholderSerial,
  listAdbDevices,
  readBoardIPv4,
  readBoardModel,
  probeSerialPorts,
  type PortProbe,
} from '../../../src/main/board/detect';
import type { SpawnResult } from '../../../src/main/util/spawn';

/**
 * The detection of the truth about the board ✓.
 *
 * | Criterion | Why |
 * |---|---|
 * | the daemon noise is not a device | otherwise the error message lists "* daemon not running" as a board ✗ |
 * | the loopback address is not the board's address | 127.0.0.1 is the board talking to itself ✗ |
 * | a placeholder address is recognised | the error has to say "this is the placeholder" ✓ instead of "cannot reach 192.0.2.100" ✓ |
 * | only a port that answers is the console | the port existing proves nothing ✓ |
 */

function result(stdout: string): SpawnResult {
  return { exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false };
}

/** A runner that answers with what the test says it should */
function runnerOf(answers: Record<string, string>) {
  return async (_command: string, args: string[]): Promise<SpawnResult> => {
    const key = args.join(' ');
    for (const [pattern, stdout] of Object.entries(answers)) {
      if (key.includes(pattern)) return result(stdout);
    }
    return result('');
  };
}

describe('the detection · the adb devices', () => {
  it('**the header and the daemon noise are not devices** ✓', () => {
    const rows = parseAdbDevices(
      [
        'List of devices attached',
        '* daemon not running; starting now at tcp:5037',
        '* daemon started successfully',
        'f34dca7784396ab2\tdevice',
        '',
      ].join('\n'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.serial).toBe('f34dca7784396ab2');
    expect(rows[0]?.state).toBe('device');
  });

  it('**the state text is kept in full** ✓ (why it is unauthorized ✗ — the text says it ✓)', () => {
    const rows = parseAdbDevices('abc123\tunauthorized\n');
    expect(rows[0]?.stateText).toBe('unauthorized');
  });

  it('**a failing adb is not an error** ✓ — it means "there is no board" ✓', async () => {
    const devices = await listAdbDevices({
      runner: async () => {
        throw new Error('adb is not installed');
      },
    });
    expect(devices).toEqual([]);
  });
});

describe('the detection · the address of the board', () => {
  it('**the loopback address is not the board** ✓', () => {
    const addresses = parseIPv4(
      [
        '1: lo: <LOOPBACK> mtu 65536',
        '    inet 127.0.0.1/8 scope host lo',
        '42: eth0: <BROADCAST> mtu 1500',
        '    inet 192.168.100.10/24 brd 192.168.100.255 scope global eth0',
      ].join('\n'),
    );
    expect(addresses).toEqual(['192.168.100.10']);
  });

  it('**the address is read from the board itself** ✓', async () => {
    const address = await readBoardIPv4('f34dca7784396ab2', {
      runner: runnerOf({ 'ip -4 addr show': '    inet 192.168.100.10/24 scope global eth0' }),
    });
    expect(address).toBe('192.168.100.10');
  });

  it('**no address → null** ✓ (not an invented one ✓)', async () => {
    const address = await readBoardIPv4('f34dca7784396ab2', {
      runner: runnerOf({ 'ip -4 addr show': '    inet 127.0.0.1/8 scope host lo' }),
    });
    expect(address).toBeNull();
  });

  it('**the model the board reports is read back** ✓', async () => {
    const model = await readBoardModel('f34dca7784396ab2', {
      runner: runnerOf({ 'device-tree/model': 'ATK-DLRK3588 Board\n' }),
    });
    expect(model).toBe('ATK-DLRK3588 Board');
  });
});

describe('the detection · the placeholders', () => {
  it('**the documentation addresses are placeholders** ✓', () => {
    expect(isPlaceholderHost('192.0.2.100')).toBe(true);
    expect(isPlaceholderHost('198.51.100.10')).toBe(true);
    expect(isPlaceholderHost('203.0.113.5')).toBe(true);
    expect(isPlaceholderHost('192.168.100.10')).toBe(false);
    expect(isPlaceholderHost('atk-01.local')).toBe(false);
  });

  it('**the all-zero serial is a placeholder** ✓', () => {
    expect(isPlaceholderSerial('0000000000000000')).toBe(true);
    expect(isPlaceholderSerial('f34dca7784396ab2')).toBe(false);
  });
});

describe('the detection · the serial ports', () => {
  const probe = (answers: Record<string, string>): PortProbe => ({
    list: async () => Object.keys(answers).map((path) => ({ path })),
    probe: async (path) => {
      const text = answers[path];
      if (text === undefined) throw new Error('the port could not be opened');
      return text;
    },
  });

  it('**only a port that answers is the console** ✓', async () => {
    const out = await probeSerialPorts(
      [{ path: 'COM3' }, { path: 'COM7' }],
      1500000,
      probe({ COM3: '', COM7: 'ATK-DLRK3588 login:' }),
    );
    expect(out.answering).toEqual(['COM7']);
    expect(out.silent).toEqual(['COM3']);
  });

  it('**a port that cannot be opened is not the console** ✓', async () => {
    const out = await probeSerialPorts([{ path: 'COM3' }], 1500000, probe({}));
    expect(out.answering).toEqual([]);
    expect(out.silent).toEqual(['COM3']);
  });
});
