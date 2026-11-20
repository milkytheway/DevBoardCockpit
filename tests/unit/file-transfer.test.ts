import { describe, it, expect, vi } from 'vitest';
import { assertTransferAllowed, TransferService } from '../../src/main/files/transfer';
import type { ConnectionCapabilities, Connection } from '../../src/main/hal/connection';

describe('assertTransferAllowed', () => {
  it('the serial port does not support the file transfer (fact S7)', () => {
    expect(() => assertTransferAllowed({ exec: true, pty: true, files: false, exitCode: false }))
      .toThrow(/does not support file transfer/);
  });
  it('a connection that supports files is let through', () => {
    expect(() => assertTransferAllowed({ exec: true, pty: true, files: true, exitCode: true })).not.toThrow();
  });
});

describe('the dispatch of the TransferService', () => {
  const caps: ConnectionCapabilities = { exec: true, pty: true, files: true, exitCode: true };

  /** Builds a fake connection. `list` / `pull` / `push` are the methods of the connection itself */
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

  it('pull uses the pull of the connection, it does not run a pull command on the remote side', async () => {
    const pull = vi.fn(async () => undefined);
    const exec = vi.fn();
    const conn = fakeConnection({ pull, exec });

    const svc = new TransferService({ getConnection: () => conn });
    await svc.pull('c', '/root/a.txt', 'C:\\tmp\\a.txt');

    expect(pull).toHaveBeenCalledWith('/root/a.txt', 'C:\\tmp\\a.txt');
    // It **may not** run a pull command on the remote side — there is no such command on the board
    expect(exec).not.toHaveBeenCalled();
  });

  it('push behaves the same way', async () => {
    const push = vi.fn(async () => undefined);
    const exec = vi.fn();
    const conn = fakeConnection({ push, exec });

    const svc = new TransferService({ getConnection: () => conn });
    await svc.push('c', 'C:\\tmp\\a.txt', '/root/a.txt');

    expect(push).toHaveBeenCalledWith('C:\\tmp\\a.txt', '/root/a.txt');
    expect(exec).not.toHaveBeenCalled();
  });

  it('list uses the list of the connection, it does not run ls on the remote side — the host machine has no ls on Windows at all', async () => {
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

  it('pull without a local path to write to is refused right away — an empty path makes adb pull / copyFile fail for sure', async () => {
    const pull = vi.fn(async () => undefined);
    const conn = fakeConnection({ pull });

    const svc = new TransferService({ getConnection: () => conn });
    await expect(svc.pull('c', '/root/a.txt', '')).rejects.toThrow(/local destination path/);
    expect(pull).not.toHaveBeenCalled();
  });

  it('push without a local source path is refused right away', async () => {
    const push = vi.fn(async () => undefined);
    const conn = fakeConnection({ push });

    const svc = new TransferService({ getConnection: () => conn });
    await expect(svc.push('c', '', '/root/a.txt')).rejects.toThrow(/local source path/);
    expect(push).not.toHaveBeenCalled();
  });

  it('when the connection does not support the transfer it is refused, and it says which connection it is', async () => {
    const conn = fakeConnection({
      transport: 'serial' as const,
      capabilities: () => ({ exec: true, pty: true, files: false, exitCode: false }),
    });

    const svc = new TransferService({ getConnection: () => conn });
    await expect(svc.pull('c', '/a', 'b')).rejects.toThrow(/does not support file transfer/);
  });

  it('when the connection does not exist it reports an error', async () => {
    const svc = new TransferService({ getConnection: () => undefined });
    await expect(svc.list('nope', '/')).rejects.toMatchObject({ code: 'CONN_CLOSED' });
  });
});
