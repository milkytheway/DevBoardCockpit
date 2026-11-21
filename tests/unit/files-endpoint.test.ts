import { describe, it, expect, vi } from 'vitest';
import {
  FILE_ENDPOINT_ORDER,
  FileEndpoint,
  fileEndpointCandidates,
} from '../../src/main/files/endpoint';
import type { Connection } from '../../src/main/hal/connection';
import type { ConnectionProfile } from '../../src/main/profiles/schema';

/**
 * **The link that carries the files** ✓.
 *
 * | Criterion | Why |
 * |---|---|
 * | the order is **ADB → SSH → serial** ✓ | the board is usually on adb ✓ · ssh survives a board without a USB cable ✓ · the serial line is exclusive ✓ and cannot carry files ✓ (fact S7 ✓) |
 * | **only the board that is current** ✓ | the machine can have several boards ✓ → a transfer must not go to the other one ✗ (the leak of 2026-11-21 ✓) |
 * | **the previous one is not there → the next one is probed** ✓ | a board that is not plugged in is normal ✓ — the next link is tried ✓ |
 * | a link that **cannot carry files** is not the endpoint ✓ | the serial one ✗ (fact S7 ✓) |
 * | **none works → the error names every one of them** ✓ | never a guess ✓ |
 */
function profile(
  id: string,
  transport: ConnectionProfile['transport'],
  deviceKey = 'ATK-DLRK3588',
): ConnectionProfile {
  return {
    id,
    label: id,
    transport,
    board_pack: 'rk3588-atk',
    device_key: deviceKey,
    options: transport === 'ssh' ? { host: 'h', port: 22 } : {},
  };
}

const PROFILES: ConnectionProfile[] = [
  profile('board-serial', 'serial'),
  profile('board-ssh', 'ssh'),
  profile('board-adb', 'adb'),
  profile('other-board-ssh', 'ssh', 'fake-board'),
  { id: 'local', label: 'Local', transport: 'local', options: {} },
];

/** A fake connection ✓ — it records whether it was opened ✓ */
function fakeConnection(files = true): Connection & { opened: number } {
  const connection = {
    id: 'c',
    transport: 'adb' as const,
    capabilities: () => ({ exec: true, pty: false, files, exitCode: true }),
    open: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false }),
    list: async () => [],
    pull: async () => undefined,
    push: async () => undefined,
    openSession: async () => {
      throw new Error('the endpoint does not open a session');
    },
    opened: 0,
  };
  return connection;
}

describe('the file endpoint · the candidates', () => {
  it('**the order is adb → ssh → serial** ✓', () => {
    expect(FILE_ENDPOINT_ORDER).toEqual(['adb', 'ssh', 'serial']);
    expect(
      fileEndpointCandidates(PROFILES, 'ATK-DLRK3588').map((p) => p.transport),
    ).toEqual(['adb', 'ssh', 'serial']);
  });

  it('**only the board that is current** ✓ (the other board is not a candidate ✓)', () => {
    const ids = fileEndpointCandidates(PROFILES, 'ATK-DLRK3588').map((p) => p.id);
    expect(ids).not.toContain('other-board-ssh');
    expect(ids).not.toContain('local');
  });

  it('**no board → no candidate** ✓ (the host says there is no board ✓)', () => {
    expect(fileEndpointCandidates(PROFILES, null)).toEqual([]);
  });
});

describe('the file endpoint · the choice', () => {
  const endpointOf = (
    open: (id: string) => Promise<Connection>,
    deviceKey: string | null = 'ATK-DLRK3588',
  ): FileEndpoint =>
    new FileEndpoint({
      listProfiles: () => PROFILES,
      currentDeviceKey: () => deviceKey,
      createConnection: async (profile) => open(profile.id),
    });

  it('**the first candidate that works is the endpoint** ✓', async () => {
    const opened: string[] = [];
    const endpoint = endpointOf(async (id) => {
      opened.push(id);
      return fakeConnection();
    });
    const handle = await endpoint.ensure();
    expect(handle.profile.id).toBe('board-adb');
    expect(opened).toEqual(['board-adb']);
  });

  it('**the previous one is not there → the next one is probed** ✓', async () => {
    const opened: string[] = [];
    const endpoint = endpointOf(async (id) => {
      opened.push(id);
      if (id === 'board-adb') throw new Error('no board on adb');
      return fakeConnection();
    });
    const handle = await endpoint.ensure();
    expect(handle.profile.id).toBe('board-ssh');
    expect(opened).toEqual(['board-adb', 'board-ssh']);
  });

  it('**a link that cannot carry files is not the endpoint** ✓ (the serial one ✗ — fact S7 ✓)', async () => {
    const endpoint = endpointOf(async (id) =>
      fakeConnection(id !== 'board-serial'),
    );
    // → The adb comes first ✓ → it works ✓ → the serial is never reached ✓
    expect((await endpoint.ensure()).profile.id).toBe('board-adb');

    // → And when the adb is gone ✓ → the ssh is taken ✓ (before the serial ✓)
    const onlySerialLeft = new FileEndpoint({
      listProfiles: () => [profile('board-serial', 'serial')],
      currentDeviceKey: () => 'ATK-DLRK3588',
      createConnection: async () => fakeConnection(false),
    });
    await expect(onlySerialLeft.ensure()).rejects.toThrow(/cannot carry files/);
  });

  it('**none works → the error names every candidate** ✓ (never a guess ✓)', async () => {
    const endpoint = endpointOf(async (id) => {
      throw new Error(`${id} is not there`);
    });
    await expect(endpoint.ensure()).rejects.toThrow(/board-adb.*board-ssh/s);
  });

  it('**the connection that is open is reused** ✓ (the next transfer does not pay the handshake again ✓)', async () => {
    let built = 0;
    const endpoint = endpointOf(async () => {
      built += 1;
      return fakeConnection();
    });
    await endpoint.ensure();
    await endpoint.ensure();
    expect(built).toBe(1);
  });

  it('**the board changed → the endpoint follows** ✓', async () => {
    let key = 'ATK-DLRK3588';
    const endpoint = new FileEndpoint({
      listProfiles: () => PROFILES,
      currentDeviceKey: () => key,
      createConnection: async () => fakeConnection(),
    });
    expect((await endpoint.ensure()).profile.id).toBe('board-adb');
    key = 'fake-board';
    expect((await endpoint.ensure()).profile.id).toBe('other-board-ssh');
  });
});
