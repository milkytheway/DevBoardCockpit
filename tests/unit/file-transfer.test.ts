import { describe, it, expect, vi } from 'vitest';
import { assertTransferAllowed, TransferService } from '../../src/main/files/transfer';
import type { ConnectionCapabilities, Connection } from '../../src/main/hal/connection';

describe('assertTransferAllowed', () => {
  it('串口不支持文件传输（事实 S7）', () => {
    expect(() => assertTransferAllowed({ exec: true, pty: true, files: false, exitCode: false }))
      .toThrow(/does not support file transfer/);
  });
  it('支持 files 的连接放行', () => {
    expect(() => assertTransferAllowed({ exec: true, pty: true, files: true, exitCode: true })).not.toThrow();
  });
});

describe('TransferService 的分派', () => {
  const caps: ConnectionCapabilities = { exec: true, pty: true, files: true, exitCode: true };

  /** 造一个假连接。`list` / `pull` / `push` 都是连接自己的方法 */
  function fakeConnection(overrides: Partial<Connection> = {}): Connection {
    return {
      id: 'c', transport: 'adb' as const,
      capabilities: () => caps,
      open: async () => {}, close: async () => {},
      exec: vi.fn(),
      list: vi.fn(async () => []),
      pull: vi.fn(async () => undefined),
      push: vi.fn(async () => undefined),
      openSession: vi.fn(),
      ...overrides,
    } as unknown as Connection;
  }

  it('pull 走连接自己的 pull，不跑远端的 pull 命令', async () => {
    const pull = vi.fn(async () => undefined);
    const exec = vi.fn();
    const conn = fakeConnection({ pull, exec });

    const svc = new TransferService({ getConnection: () => conn });
    await svc.pull('c', '/root/a.txt', 'C:\\tmp\\a.txt');

    expect(pull).toHaveBeenCalledWith('/root/a.txt', 'C:\\tmp\\a.txt');
    // **不能**跑远端的 pull 命令——板子上没有这个命令
    expect(exec).not.toHaveBeenCalled();
  });

  it('push 同理', async () => {
    const push = vi.fn(async () => undefined);
    const exec = vi.fn();
    const conn = fakeConnection({ push, exec });

    const svc = new TransferService({ getConnection: () => conn });
    await svc.push('c', 'C:\\tmp\\a.txt', '/root/a.txt');

    expect(push).toHaveBeenCalledWith('C:\\tmp\\a.txt', '/root/a.txt');
    expect(exec).not.toHaveBeenCalled();
  });

  it('list 走连接自己的 list，不跑远端的 ls —— 本机在 Windows 上根本没有 ls', async () => {
    const list = vi.fn(async () => [
      { name: 'a.txt', path: '/root/a.txt', isDirectory: false, sizeBytes: 3, modifiedAt: null },
    ]);
    const exec = vi.fn();
    const conn = fakeConnection({ list, exec });

    const svc = new TransferService({ getConnection: () => conn });
    const entries = await svc.list('c', '/root');

    expect(list).toHaveBeenCalledWith('/root');
    expect(entries).toHaveLength(1);
    expect(exec).not.toHaveBeenCalled();
  });

  it('pull 没有本地落盘路径时直接拒 —— 空路径会让 adb pull / copyFile 必挂', async () => {
    const pull = vi.fn(async () => undefined);
    const conn = fakeConnection({ pull });

    const svc = new TransferService({ getConnection: () => conn });
    await expect(svc.pull('c', '/root/a.txt', '')).rejects.toThrow(/local destination path/);
    expect(pull).not.toHaveBeenCalled();
  });

  it('push 没有本地源路径时直接拒', async () => {
    const push = vi.fn(async () => undefined);
    const conn = fakeConnection({ push });

    const svc = new TransferService({ getConnection: () => conn });
    await expect(svc.push('c', '', '/root/a.txt')).rejects.toThrow(/local source path/);
    expect(push).not.toHaveBeenCalled();
  });

  it('连接不支持传输时拒绝，并说是哪个连接', async () => {
    const conn = fakeConnection({
      transport: 'serial' as const,
      capabilities: () => ({ exec: true, pty: true, files: false, exitCode: false }),
    });

    const svc = new TransferService({ getConnection: () => conn });
    await expect(svc.pull('c', '/a', 'b')).rejects.toThrow(/does not support file transfer/);
  });

  it('连接不存在时报错', async () => {
    const svc = new TransferService({ getConnection: () => undefined });
    await expect(svc.list('nope', '/')).rejects.toMatchObject({ code: 'CONN_CLOSED' });
  });
});
