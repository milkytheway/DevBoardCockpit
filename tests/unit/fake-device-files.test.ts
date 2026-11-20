import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionLog } from '../../src/main/logging/session-log';
import { FakeConnection } from '../../src/main/hal/fake/connection';

/**
 * The **file system of the fake device** (for the debugging).
 *
 * Why the fake device needs a file system:
 *
 * What the write side (M6) has to prove is "**the action runs → the readback
 * → the interface renders the value of the readback**". And three of the five
 * forms of the readback land on **files and commands**: `file_equals` (it
 * reads a file and compares the value), `command_ok` (it looks at the exit
 * code), `verify` (it runs a second command).
 *
 * → The fake device **may not only emit the text of `/proc`**: it has to be
 *   able to **write a file, read it back and be grepped**. Otherwise the
 *   criterion "the action closes the loop" **cannot run on the fake device**
 *   at all (it would need a real board → it cannot be automated).
 *
 * Why this fs is "fake" but **honest**:
 *
 * - **It really transfers**: the file that is pushed really lands in the
 *   virtual fs and the file that is pulled really lands on the disk of the
 *   host → "reporting success and transferring nothing" no longer happens;
 * - **It does not pretend**: pulling a file that does not exist **reports an
 *   error** instead of **reporting success**;
 * - **It is shared**: the two connections of the same fake profile see **the
 *   same fs** → the file the runtime wrote is visible in the file browser of
 *   the terminal (a board has one disk).
 */

let dir: string;
let log: SessionLog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cockpit-fake-fs-'));
  log = new SessionLog({ label: 'fake', transport: 'local', dataDir: dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fake(): FakeConnection {
  return new FakeConnection({ now: () => 1_700_000_000_000, log });
}

describe('the fake device · the file system', () => {
  it('a file written by echo can be read back by cat', async () => {
    const conn = fake();
    const write = await conn.exec('echo 128 > /sys/class/backlight/backlight/brightness');
    expect(write.exitCode).toBe(0);
    const read = await conn.exec("cat -- '/sys/class/backlight/backlight/brightness'");
    expect(read.exitCode).toBe(0);
    expect(read.stdout.trim()).toBe('128');
  });

  it('reading a file that does not exist → **an error**, not an empty string', async () => {
    const conn = fake();
    const read = await conn.exec("cat -- '/nope/nothing'");
    expect(read.exitCode).toBe(1);
    expect(read.stdout).toBe('');
    expect(read.stderr).not.toBe('');
  });

  it('test -s: only a non-empty file is 0', async () => {
    const conn = fake();
    await conn.exec('echo hi > /tmp/x');
    expect((await conn.exec("test -s '/tmp/x'")).exitCode).toBe(0);
    expect((await conn.exec("test -s '/tmp/absent'")).exitCode).toBe(1);
  });

  it('grep -qF: found is 0, not found is 1', async () => {
    const conn = fake();
    await conn.exec("echo 'ssh-rsa AAAA' > /root/.ssh/authorized_keys");
    expect((await conn.exec("grep -qF 'ssh-rsa AAAA' '/root/.ssh/authorized_keys'")).exitCode).toBe(0);
    expect((await conn.exec("grep -qF 'ssh-ed25519' '/root/.ssh/authorized_keys'")).exitCode).toBe(1);
  });

  it('push: the file of the host really enters the virtual fs', async () => {
    const conn = fake();
    const local = join(dir, 'artifact.ko');
    writeFileSync(local, 'ELF-ish');
    await conn.push(local, '/usr/lib/modules/6.1.141/extra/');
    const read = await conn.exec("cat -- '/usr/lib/modules/6.1.141/extra/artifact.ko'");
    expect(read.stdout).toBe('ELF-ish');
  });

  it('pull: the file of the virtual fs really lands on the disk of the host', async () => {
    const conn = fake();
    await conn.exec('echo payload > /tmp/report.txt');
    const local = join(dir, 'report.txt');
    await conn.pull('/tmp/report.txt', local);
    expect(existsSync(local)).toBe(true);
    expect(readFileSync(local, 'utf8').trim()).toBe('payload');
  });

  it('pulling a file that does not exist → **an error** (it does not report success)', async () => {
    const conn = fake();
    const local = join(dir, 'nope.txt');
    await expect(conn.pull('/tmp/absent', local)).rejects.toThrow();
    expect(existsSync(local)).toBe(false);
  });

  it('the two connections of the same fake board see **the same fs**', async () => {
    const a = fake();
    const b = fake();
    await a.exec('echo shared > /tmp/shared.txt');
    const read = await b.exec("cat -- '/tmp/shared.txt'");
    expect(read.stdout.trim()).toBe('shared');
  });

  it('list: it lists what is in the virtual fs', async () => {
    const conn = fake();
    await conn.exec('echo x > /tmp/listed.txt');
    const entries = await conn.list('/tmp');
    expect(entries.map((e) => e.name)).toContain('listed.txt');
  });
});
