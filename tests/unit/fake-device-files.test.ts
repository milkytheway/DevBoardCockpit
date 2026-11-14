import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionLog } from '../../src/main/logging/session-log';
import { FakeConnection } from '../../src/main/hal/fake/connection';

/**
 * 假设备的**文件系统**（调试用）。
 *
 * ── 为什么假设备要有一块文件系统 ──
 *
 * 写侧（M6）要证明的是「**动作执行 → 回读 → 界面按回读值渲染**」。
 * 而回读的五种形式里有三种落在**文件与命令**上：
 * `file_equals`（读文件比值）、`command_ok`（看退出码）、`verify`（跑二次命令）。
 *
 * → 假设备**不能只会吐 `/proc` 文本**：它得能**写文件、能读回、能被 grep**。
 * 否则「动作闭环」这条判据在假设备上**根本跑不了**（只能靠真板 → 不可自动化）。
 *
 * ── 为什么这块 fs 是「假的」但**诚实** ──
 *
 * - **真传**：推上去的文件真的落在虚拟 fs 里，拉下来的文件真的落在宿主磁盘上
 *   → 「报告成功却不传文件」这种骗人的事不再发生；
 * - **不假装有**：拉一个不存在的文件**报错**，不是**报告成功**；
 * - **共享**：同一个假 profile 的两条连接看到**同一块 fs**
 *   → 运行时写进去的文件，终端的文件浏览器看得见（一块板子只有一块盘）。
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

describe('假设备 · 文件系统', () => {
  it('echo 写进去的文件，cat 得回来', async () => {
    const conn = fake();
    const write = await conn.exec('echo 128 > /sys/class/backlight/backlight/brightness');
    expect(write.exitCode).toBe(0);
    const read = await conn.exec("cat -- '/sys/class/backlight/backlight/brightness'");
    expect(read.exitCode).toBe(0);
    expect(read.stdout.trim()).toBe('128');
  });

  it('读不存在的文件 → **报错**，不是空串', async () => {
    const conn = fake();
    const read = await conn.exec("cat -- '/nope/nothing'");
    expect(read.exitCode).toBe(1);
    expect(read.stdout).toBe('');
    expect(read.stderr).not.toBe('');
  });

  it('test -s：非空才是 0', async () => {
    const conn = fake();
    await conn.exec('echo hi > /tmp/x');
    expect((await conn.exec("test -s '/tmp/x'")).exitCode).toBe(0);
    expect((await conn.exec("test -s '/tmp/absent'")).exitCode).toBe(1);
  });

  it('grep -qF：找到是 0，没找到是 1', async () => {
    const conn = fake();
    await conn.exec("echo 'ssh-rsa AAAA' > /root/.ssh/authorized_keys");
    expect((await conn.exec("grep -qF 'ssh-rsa AAAA' '/root/.ssh/authorized_keys'")).exitCode).toBe(0);
    expect((await conn.exec("grep -qF 'ssh-ed25519' '/root/.ssh/authorized_keys'")).exitCode).toBe(1);
  });

  it('push：宿主上的文件真的进了虚拟 fs', async () => {
    const conn = fake();
    const local = join(dir, 'artifact.ko');
    writeFileSync(local, 'ELF-ish');
    await conn.push(local, '/usr/lib/modules/6.1.141/extra/');
    const read = await conn.exec("cat -- '/usr/lib/modules/6.1.141/extra/artifact.ko'");
    expect(read.stdout).toBe('ELF-ish');
  });

  it('pull：虚拟 fs 里的文件真的落在宿主磁盘上', async () => {
    const conn = fake();
    await conn.exec('echo payload > /tmp/report.txt');
    const local = join(dir, 'report.txt');
    await conn.pull('/tmp/report.txt', local);
    expect(existsSync(local)).toBe(true);
    expect(readFileSync(local, 'utf8').trim()).toBe('payload');
  });

  it('pull 不存在的文件 → **报错**（不报告成功）', async () => {
    const conn = fake();
    const local = join(dir, 'nope.txt');
    await expect(conn.pull('/tmp/absent', local)).rejects.toThrow();
    expect(existsSync(local)).toBe(false);
  });

  it('同一块假板子的两条连接看到**同一块 fs**', async () => {
    const a = fake();
    const b = fake();
    await a.exec('echo shared > /tmp/shared.txt');
    const read = await b.exec("cat -- '/tmp/shared.txt'");
    expect(read.stdout.trim()).toBe('shared');
  });

  it('list：列的是虚拟 fs 里的东西', async () => {
    const conn = fake();
    await conn.exec('echo x > /tmp/listed.txt');
    const entries = await conn.list('/tmp');
    expect(entries.map((e) => e.name)).toContain('listed.txt');
  });
});
