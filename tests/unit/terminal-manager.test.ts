import { describe, it, expect, vi } from 'vitest';
import { TerminalManager } from '../../src/main/terminal/manager';

/**
 * 假连接：记录写往远端的数据，并保留会话的数据回调，
 * 这样测试能区分「写给远端」与「回显给用户」两条路。
 */
const fakeConn = (caps: { pty: boolean }) => {
  const written: string[] = [];
  let dataCb: ((chunk: string) => void) | undefined;
  const conn = {
    id: 'c', transport: 'serial' as const,
    capabilities: () => ({ exec: true, pty: caps.pty, files: false, exitCode: false }),
    open: async () => {}, close: async () => {},
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false }),
    openSession: () => ({
      write: (d: string) => written.push(d),
      resize: vi.fn(), close: vi.fn(), exitCode: null,
      onData: (cb: (chunk: string) => void) => { dataCb = cb; },
    }),
  };
  return {
    conn, written,
    emit: (chunk: string) => dataCb?.(chunk),
  };
};

const mgrWith = (conn: unknown) => new TerminalManager({
  listProfiles: () => [{ id: 'p1', label: 'p1', transport: 'serial', options: {} }],
  createConnection: () => conn as never,
  createLog: () => ({ write: vi.fn(), close: vi.fn(), filePath: 'x' }) as never,
});

describe('TerminalManager', () => {
  it('pty 模式：写入的数据原样转交给远端', async () => {
    const { conn, written } = fakeConn({ pty: true });
    const mgr = mgrWith(conn);
    const { sessionId } = await mgr.open('p1');
    mgr.write(sessionId, 'ls\r');
    expect(written).toEqual(['ls\r']);
  });

  it('pipe 模式：回车发给远端的是 LF —— 远端 shell 只认 LF', async () => {
    // 这条是真机实测出来的（`docs/11-计划1评审报告.md` R-01）：
    // pipe 模式下 `'\r'` 原样发过去，busybox 的 shell 永远等不到行尾。
    const { conn, written } = fakeConn({ pty: false });
    const mgr = mgrWith(conn);
    const { sessionId } = await mgr.open('p1');
    mgr.write(sessionId, 'ls\r');
    expect(written).toEqual(['ls\n']);
  });

  it('pipe 模式：打字过程中不发给远端，回车才把整行发过去', async () => {
    const { conn, written } = fakeConn({ pty: false });
    const mgr = mgrWith(conn);
    const { sessionId } = await mgr.open('p1');
    mgr.write(sessionId, 'ls');
    expect(written).toEqual([]);
    mgr.write(sessionId, '\r');
    expect(written).toEqual(['ls\n']);
  });

  it('多字节输入原样透传，不截断不替换（RF-2）', async () => {
    const { conn, written } = fakeConn({ pty: true });
    const mgr = mgrWith(conn);
    const { sessionId } = await mgr.open('p1');
    mgr.write(sessionId, '中文abc');
    expect(written.join('')).toContain('中文abc');
  });

  it('pipe 模式下宿主自己回显给用户（adb 无 PTY 时板子不回显）', async () => {
    const { conn } = fakeConn({ pty: false });
    const mgr = mgrWith(conn);
    const seen: string[] = [];
    mgr.onData((_id, chunk) => seen.push(chunk));
    const { sessionId } = await mgr.open('p1');
    mgr.write(sessionId, 'ls\r');
    // 回显走数据通道，用户才看得到自己打的字
    expect(seen.join('')).toContain('ls');
  });

  it('pty 模式不额外回显（远端自己回显）', async () => {
    const { conn } = fakeConn({ pty: true });
    const mgr = mgrWith(conn);
    const seen: string[] = [];
    mgr.onData((_id, chunk) => seen.push(chunk));
    const { sessionId } = await mgr.open('p1');
    mgr.write(sessionId, 'ls\r');
    expect(seen).toEqual([]);
  });

  it('会话的输出转发给订阅者', async () => {
    const { conn, emit } = fakeConn({ pty: true });
    const mgr = mgrWith(conn);
    const seen: string[] = [];
    mgr.onData((_id, chunk) => seen.push(chunk));
    const { sessionId } = await mgr.open('p1');
    emit('hello from board');
    expect(seen).toEqual(['hello from board']);
    expect(sessionId).toBeTruthy();
  });

  it('打开不存在的 profile 报 TERM_NOT_FOUND', async () => {
    const { conn } = fakeConn({ pty: false });
    const mgr = mgrWith(conn);
    await expect(mgr.open('nope')).rejects.toMatchObject({ code: 'TERM_NOT_FOUND' });
  });
});
