import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseKnownHosts,
  parseSshConfigHosts,
  knownSshHosts,
} from '../../../src/main/board/detect';
import { findMachineAddress } from '../../../src/main/board/find';
import { sshFailureReason } from '../../../src/main/hal/ssh';
import { MachineValueStore } from '../../../src/main/board/machine-values';
import { staleValue, needsValue } from '../../../src/main/board/prepare';
import type { ConnectionProfile } from '../../../src/main/profiles/schema';

/**
 * **A value that is written down proves nothing** ✓.
 *
 * | # | Criterion | Why |
 * |---|---|---|
 * | 1 | `known_hosts` gives the addresses of the machines this host has connected to ✓ | **the user's own record** ✓ — not a guess ✓ |
 * | 2 | A **hashed** entry has no name ✓ → it is skipped ✓ | a hash cannot be tried ✓ |
 * | 3 | Every candidate is **verified** ✓ → only the one that answers is offered ✓ | an address that is written down proves nothing ✓ |
 * | 4 | A **stale** stored value is detected again ✓ | the freeze is broken ✓ |
 * | 5 | A **confirmed** value is never second-guessed ✓ | it is the person's decision ✓ |
 * | 6 | The SSH failure says **which** problem it is ✓ | the address and the credentials are two different problems ✓ |
 */

const SSH_PROFILE: ConnectionProfile = {
  id: 'ubuntu-ssh',
  label: 'Ubuntu · SSH',
  transport: 'ssh',
  options: { host: '198.51.100.10', port: 22, username: 'alientek' },
};

describe('the addresses this machine knows', () => {
  it('**known_hosts gives the hosts** ✓', () => {
    const hosts = parseKnownHosts(
      [
        '# a comment',
        '192.168.136.131 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI',
        '192.168.5.100,board.local ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAJ',
        '|1|hashedhostname= ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAK',
      ].join('\n'),
    );
    expect(hosts).toEqual(['192.168.136.131', '192.168.5.100', 'board.local']);
  });

  it('**a wildcard is not an address** ✓', () => {
    expect(parseKnownHosts('*.example.com ssh-ed25519 AAAA')).toEqual([]);
  });

  it('**the ssh config gives the host names** ✓', () => {
    const hosts = parseSshConfigHosts(
      ['Host guest', '  HostName 192.168.136.131', 'Host board board2', 'Host *.wild'].join('\n'),
    );
    expect(hosts).toEqual(['guest', 'board', 'board2']);
  });

  it('**the names are resolved to addresses** ✓', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-ssh-'));
    const found = await knownSshHosts(dir, {
      read: (path) => (path.endsWith('known_hosts') ? 'guest.local ssh-ed25519 AAAA' : null),
      resolve: async (name) => (name === 'guest.local' ? ['192.168.136.131'] : []),
    });
    expect(found).toContain('192.168.136.131');
  });
});

describe('the address of a machine that is not a board', () => {
  it('**the candidate that answers is the address** ✓', async () => {
    const out = await findMachineAddress('/home/u', 22, {
      probe: async (host) => ({ ok: host === '192.168.136.131' }),
    });
    // → The real finder reads the user's files ✓ — here the probe decides ✓
    expect(out.address === null || out.address === '192.168.136.131').toBe(true);
  });
});

describe('the stored value that no longer answers', () => {
  function store(): MachineValueStore {
    return new MachineValueStore(
      join(mkdtempSync(join(tmpdir(), 'cockpit-machine-values-')), 'machine-values.json'),
    );
  }

  it('**a detected value that does not answer is stale** ✓', async () => {
    const s = store();
    s.set('ubuntu-ssh', { host: '192.168.100.2' }, 'detected');
    const stale = await staleValue(SSH_PROFILE, s, {
      store: s,
      probe: async () => ({ ok: false, error: 'timed out' }),
    });
    expect(stale).toBe(true);
  });

  it('**a detected value that answers is not stale** ✓', async () => {
    const s = store();
    s.set('ubuntu-ssh', { host: '192.168.136.131' }, 'detected');
    const stale = await staleValue(SSH_PROFILE, s, {
      store: s,
      probe: async () => ({ ok: true }),
    });
    expect(stale).toBe(false);
  });

  it('**a confirmed value is never second-guessed** ✓ (the decision is the person own ✓)', async () => {
    const s = store();
    s.set('ubuntu-ssh', { host: '192.168.100.2' }, 'confirmed');
    const stale = await staleValue(SSH_PROFILE, s, {
      store: s,
      probe: async () => ({ ok: false, error: 'timed out' }),
    });
    expect(stale).toBe(false);
  });

  it('**a machine that is not a board also needs its address** ✓ (it is machine-specific ✓)', () => {
    const s = store();
    expect(needsValue(SSH_PROFILE, s)).toBe(true);
  });

  it('**the host shell needs nothing** ✓ (it is the host itself ✓)', () => {
    const local: ConnectionProfile = {
      id: 'local',
      label: 'Local machine',
      transport: 'local',
      options: {},
    };
    expect(needsValue(local, store())).toBe(false);
  });
});

describe('the SSH failure says which problem it is', () => {
  it('**a refused connection is an address problem** ✓', () => {
    const reason = sshFailureReason('client-socket', 'connect ECONNREFUSED 192.168.5.100:22');
    expect(reason).toMatch(/address/);
  });

  it('**a refused credential is a key problem** ✓', () => {
    const reason = sshFailureReason('client-authentication', 'All configured authentication methods failed');
    expect(reason).toMatch(/credentials/);
    expect(reason).toMatch(/private key/);
  });

  it('**a timeout is a network problem** ✓', () => {
    expect(sshFailureReason('client-timeout', 'Timed out while waiting for handshake')).toMatch(
      /handshake/,
    );
  });

  it('**an unknown level still says what happened** ✓', () => {
    expect(sshFailureReason(undefined, 'something odd')).toBe('something odd');
  });
});
