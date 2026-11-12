import { describe, it, expect, vi } from 'vitest';
import { assertTransferAllowed, parseLsOutput, TransferService } from '../../src/main/files/transfer';
import type { Capabilities, Connection } from '../../src/main/hal/connection';

describe('assertTransferAllowed', () => {
  it('串口不支持文件传输（事实 S7）', () => {
    expect(() => assertTransferAllowed({ exec: true, pty: true, files: false, exitCode: false }))
      .toThrow(/不支持文件传输/);
  });
  it('支持 files 的连接放行', () => {
    expect(() => assertTransferAllowed({ exec: true, pty: true, files: true, exitCode: true })).not.toThrow();
  });
});

describe('TransferService 的分派', () => {
  const caps: Capabilities = { exec: true, pty: true, files: true, exitCode: true };

  it('pull 走连接自己的 pull，不跑远端的 pull 命令', async () => {
    const pull = vi.fn(async () => undefined);
    const exec = vi.fn();
    const conn = {
      id: 'c', transport: 'adb' as const,
      capabilities: () => caps,
      open: async () => {}, close: async () => {},
      exec,
      pull, push: vi.fn(async () => undefined),
      openSession: vi.fn(),
    } as unknown as Connection;

    const svc = new TransferService({ getConnection: () => conn });
    await svc.pull('c', '/root/a.txt', 'C:\\tmp\\a.txt');

    expect(pull).toHaveBeenCalledWith('/root/a.txt', 'C:\\tmp\\a.txt');
    // **不能**跑远端的 pull 命令——板子上没有这个命令
    expect(exec).not.toHaveBeenCalled();
  });

  it('push 同理', async () => {
    const push = vi.fn(async () => undefined);
    const exec = vi.fn();
    const conn = {
      id: 'c', transport: 'adb' as const,
      capabilities: () => caps,
      open: async () => {}, close: async () => {},
      exec, pull: vi.fn(async () => undefined), push,
      openSession: vi.fn(),
    } as unknown as Connection;

    const svc = new TransferService({ getConnection: () => conn });
    await svc.push('c', 'C:\\tmp\\a.txt', '/root/a.txt');

    expect(push).toHaveBeenCalledWith('C:\\tmp\\a.txt', '/root/a.txt');
    expect(exec).not.toHaveBeenCalled();
  });

  it('连接不支持传输时拒绝，并说是哪个连接', async () => {
    const conn = {
      id: 'c', transport: 'serial' as const,
      capabilities: () => ({ exec: true, pty: true, files: false, exitCode: false }),
      open: async () => {}, close: async () => {},
      exec: vi.fn(), pull: vi.fn(), push: vi.fn(), openSession: vi.fn(),
    } as unknown as Connection;

    const svc = new TransferService({ getConnection: () => conn });
    await expect(svc.pull('c', '/a', 'b')).rejects.toThrow(/不支持文件传输/);
  });

  it('连接不存在时报错', async () => {
    const svc = new TransferService({ getConnection: () => undefined });
    await expect(svc.list('nope', '/')).rejects.toMatchObject({ code: 'CONN_CLOSED' });
  });
});

describe('parseLsOutput', () => {
  it('解析出名字、类型、大小，跳过 . 与 ..', () => {
    const out = [
      'total 24',
      'drwxr-xr-x 2 root root  4096 Nov 12 09:30 sub',
      '-rw-r--r-- 1 root root   123 Nov 12 09:31 a.txt',
      'drwxr-xr-x 1 root root  4096 Nov 11 22:00 ..',
    ].join('\n');
    const entries = parseLsOutput(out, '/root');
    expect(entries.map((e) => e.name)).toEqual(['sub', 'a.txt']);
    expect(entries[0].isDirectory).toBe(true);
    expect(entries[1].isDirectory).toBe(false);
    expect(entries[1].sizeBytes).toBe(123);
    expect(entries[1].path).toBe('/root/a.txt');
  });

  it('解析不了的行跳过而不毁掉整次列举', () => {
    const entries = parseLsOutput('garbage line\n-rw-r--r-- 1 root root 7 Nov 12 09:31 b.txt', '/root');
    expect(entries.map((e) => e.name)).toEqual(['b.txt']);
  });

  it('大小是 4.0K 这种人类可读值时也能解析（真机样本里就有）', () => {
    const out = 'drwxr-xr-x 6 root root 4.0K Jan  1 08:00 data';
    const entries = parseLsOutput(out, '/root');
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('data');
    expect(entries[0].isDirectory).toBe(true);
  });
});
