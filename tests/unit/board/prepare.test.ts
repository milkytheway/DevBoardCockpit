import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareProfile, needsRepair, placeholderOf } from '../../../src/main/board/prepare';
import type { ConnectionProfile } from '../../../src/main/profiles/schema';
import type { SpawnResult } from '../../../src/main/util/spawn';

/**
 * The preparation of a connection for this machine ✓.
 *
 * | Criterion | Why |
 * |---|---|
 * | a profile whose values are real is not touched | no adb call, no write, no delay ✓ |
 * | the placeholder is repaired and written down | the next start reads the right values ✓ |
 * | the user's own file is never overwritten | it is the person's configuration ✓ |
 * | a placeholder that cannot be repaired names itself in the error | "cannot reach 192.0.2.100" sends the user looking for a network problem that does not exist ✓ |
 */

function result(stdout: string): SpawnResult {
  return { exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false };
}

function runnerOf(answers: { devices?: string; address?: string; model?: string }) {
  return async (_command: string, args: string[]): Promise<SpawnResult> => {
    const key = args.join(' ');
    if (key.includes('devices')) return result(answers.devices ?? '');
    if (key.includes('ip -4 addr show')) return result(answers.address ?? '');
    if (key.includes('device-tree/model')) return result(answers.model ?? '');
    return result('');
  };
}

const SSH_PROFILE: ConnectionProfile = {
  id: 'board-ssh',
  label: 'Board · SSH',
  transport: 'ssh',
  board_pack: 'rk3588-atk',
  device_key: 'atk-01',
  options: { host: '192.0.2.100', port: 22, username: 'root' },
};

describe('the preparation · what has to be repaired', () => {
  it('**the placeholder is named** ✓', () => {
    expect(placeholderOf(SSH_PROFILE)).toMatch(/192\.0\.2\.100/);
    expect(placeholderOf(SSH_PROFILE)).toMatch(/RFC 5737/);
  });

  it('**a profile with real values has nothing to repair** ✓', () => {
    const profile: ConnectionProfile = {
      ...SSH_PROFILE,
      options: { host: '192.168.100.10', port: 22, username: 'root' },
    };
    expect(placeholderOf(profile)).toBeNull();
    expect(needsRepair(profile, [])).toBe(false);
  });

  it('**a pinned serial that is not there any more has to be repaired** ✓', () => {
    const profile: ConnectionProfile = {
      id: 'board-adb',
      label: 'Board · ADB',
      transport: 'adb',
      board_pack: 'rk3588-atk',
      device_key: 'atk-01',
      options: { serial: 'f34dca7784396ab2' },
    };
    expect(needsRepair(profile, [{ serial: 'other', state: 'device', stateText: 'device' }])).toBe(
      true,
    );
    expect(needsRepair(profile, [{ serial: 'f34dca7784396ab2', state: 'device', stateText: 'device' }])).toBe(
      false,
    );
  });
});

describe('the preparation · the repair', () => {
  it('**the repaired profile is written into the user directory** ✓', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-user-profiles-'));
    const prepared = await prepareProfile(SSH_PROFILE, {
      runner: runnerOf({
        devices: 'f34dca7784396ab2\tdevice',
        address: '    inet 192.168.100.10/24 scope global eth0',
        model: 'ATK-DLRK3588 Board',
      }),
      expectedModels: ['ATK-DLRK3588'],
      userProfilesDir: dir,
    });
    expect(prepared.options['host']).toBe('192.168.100.10');
    expect(existsSync(join(dir, 'board-ssh.json'))).toBe(true);
    const written = JSON.parse(readFileSync(join(dir, 'board-ssh.json'), 'utf8')) as ConnectionProfile;
    expect(written.options['host']).toBe('192.168.100.10');
  });

  it('**a placeholder that cannot be repaired says so** ✓ (the message names it ✓)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-user-profiles-'));
    await expect(
      prepareProfile(SSH_PROFILE, {
        runner: runnerOf({ devices: '' }),
        userProfilesDir: dir,
      }),
    ).rejects.toThrow(/192\.0\.2\.100/);
  });

  it('**a profile with real values is left alone** ✓ (nothing is written ✓)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-user-profiles-'));
    const profile: ConnectionProfile = {
      ...SSH_PROFILE,
      options: { host: '192.168.100.10', port: 22, username: 'root' },
    };
    let called = false;
    const prepared = await prepareProfile(profile, {
      runner: async () => {
        called = true;
        return result('');
      },
      userProfilesDir: dir,
    });
    expect(called).toBe(false);
    expect(prepared.options['host']).toBe('192.168.100.10');
    expect(existsSync(join(dir, 'board-ssh.json'))).toBe(false);
  });

  it('**the guest machine never gets the address of the board** ✓ (it is not a board ✓)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-user-profiles-'));
    const guest: ConnectionProfile = {
      id: 'ubuntu-ssh',
      label: 'Guest · SSH',
      transport: 'ssh',
      options: { host: '198.51.100.10', port: 22, username: 'ubuntu' },
    };
    let called = false;
    const prepared = await prepareProfile(guest, {
      runner: async () => {
        called = true;
        return result('f34dca7784396ab2\tdevice');
      },
      userProfilesDir: dir,
    });
    expect(called).toBe(false);
    expect(prepared.options['host']).toBe('198.51.100.10');
    expect(existsSync(join(dir, 'ubuntu-ssh.json'))).toBe(false);
  });
});
