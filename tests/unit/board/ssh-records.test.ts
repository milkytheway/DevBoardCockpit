import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseKnownHosts,
  parseSshConfig,
  readSshRecords,
} from '../../../src/main/board/ssh-records';

/**
 * **The SSH records of this machine** ✓ — the person's own records ✓.
 *
 * | Criterion | Why |
 * |---|---|
 * | the addresses of `known_hosts` are read | the guest's address is the person's own record ✓ |
 * | the aliases of `config` are not addresses | the person may call the guest "board" ✓ — the address is the `HostName` ✓ |
 * | the hashed entries carry no address | there is nothing to read out of them ✓ |
 * | only the private keys are candidates | `known_hosts` and `*.pub` are not credentials ✓ |
 */
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'home-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('the SSH records · the known hosts', () => {
  it('**the addresses are read** ✓', () => {
    const text = ['192.168.136.131 ssh-ed25519 AAAA', 'board.local ssh-rsa AAAA'].join('\n');
    expect(parseKnownHosts(text)).toEqual(['192.168.136.131', 'board.local']);
  });

  it('**several names on one line are several addresses** ✓', () => {
    expect(parseKnownHosts('a.local,b.local ssh-ed25519 AAAA')).toEqual(['a.local', 'b.local']);
  });

  it('**the hashed entries carry no address** ✓ (there is nothing to read out of them ✓)', () => {
    expect(parseKnownHosts('|1|abcdefghijklmnop=|xyz ssh-ed25519 AAAA')).toEqual([]);
  });

  it('**the comments and the empty lines are skipped** ✓', () => {
    expect(parseKnownHosts('# a comment\n\n192.168.1.1 ssh-ed25519 AAAA')).toEqual(['192.168.1.1']);
  });
});

describe('the SSH records · the ssh config', () => {
  it('**only the HostName is an address** ✓ (the Host is an alias ✓)', () => {
    const text = ['Host board', '  HostName 192.168.136.131', '  User alientek'].join('\n');
    expect(parseSshConfig(text)).toEqual(['192.168.136.131']);
  });

  it('**a config without a HostName has no address** ✓', () => {
    expect(parseSshConfig('Host board\n  User alientek')).toEqual([]);
  });
});

describe('the SSH records · the directory', () => {
  it('**the addresses of both files are read** ✓', () => {
    mkdirSync(join(home, '.ssh'));
    writeFileSync(join(home, '.ssh', 'known_hosts'), '192.168.136.131 ssh-ed25519 AAAA\n');
    writeFileSync(join(home, '.ssh', 'config'), 'Host guest\n  HostName guest.local\n');
    const records = readSshRecords(home);
    expect(records.addresses).toEqual(['192.168.136.131', 'guest.local']);
  });

  it('**the private keys are the candidates** ✓', () => {
    const sshDir = join(home, '.ssh');
    mkdirSync(sshDir);
    writeFileSync(join(sshDir, 'id_ed25519_codex_board'), 'KEY');
    writeFileSync(join(sshDir, 'id_ed25519_codex_board.pub'), 'PUB');
    writeFileSync(join(sshDir, 'known_hosts'), '');
    writeFileSync(join(sshDir, 'config'), '');
    const records = readSshRecords(home);
    expect(records.keys).toEqual([join(sshDir, 'id_ed25519_codex_board')]);
  });

  it('**a home without an .ssh directory has no records** ✓ (and it is not an error ✓)', () => {
    expect(readSshRecords(home)).toEqual({ addresses: [], keys: [] });
  });
});
