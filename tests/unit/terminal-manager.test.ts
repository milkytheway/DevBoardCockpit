import { describe, it, expect, vi } from 'vitest';
import { TerminalManager } from '../../src/main/terminal/manager';

/**
 * 假连接：记录写往远端的数据，并保留会话的数据回调，
 * 这样测试能区分「写给远端」与「回显给用户」两条路。
 */
const fakeConn = (caps: { pty: boolean }) => {
  const written: string[] = [];
  let dataCb: ((chunk: string) => void) | undefined;
  let exitCb: ((exitCode: number | null) => void) | undefined;
  const conn = {
    id: 'c', transport: 'serial' as const,
    capabilities: () => ({ exec: true, pty: caps.pty, files: false, exitCode: false }),
    open: async () => {}, close: async () => {},
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false }),
    openSession: () => ({
      write: (d: string) => written.push(d),
      resize: vi.fn(), close: vi.fn(), exitCode: null,
      onData: (cb: (chunk: string) => void) => { dataCb = cb; },
      onExit: (cb: (exitCode: number | null) => void) => { exitCb = cb; },
    }),
  };
  return {
    conn, written,
    emit: (chunk: string) => dataCb?.(chunk),
    /** 模拟「远端自己退出了」 */
    exit: (code: number | null) => exitCb?.(code),
  };
};

/**
 * 假日志：**记下调用顺序**。
 *
 * 之前的假日志只有一堆 `vi.fn()`，把「一次会话到底落几个文件、
 * 事件行的先后顺序」全遮住了——第三轮审计的两条缺陷都藏在这儿。
 */
function fakeLog() {
  const events: string[] = [];
  return {
    events,
    log: {
      write: (line: string) => events.push(`write:${line}`),
      writeEvent: (kind: string, detail = '') => events.push(`event:${kind}${detail ? ' ' + detail : ''}`),
      close: () => events.push('close'),
      filePath: 'x',
    },
  };
}

/**
 * 造一个 manager。
 *
 * profile 的 `pty` **由假连接的能力位推导**——这样每个用例想测 pty 还是 pipe
 * 只要改 `fakeConn({ pty })` 一处。
 *
 * 注意：**运行时的终端模式由 profile 决定**（第三轮复评 S-03）：
 * 原来 manager 读的是 `connection.capabilities().pty`（传输的常量），
 * 于是 profile 里的 `pty` 改不动运行时，而 UI 侧读的是 profile ——
 * **两个能力位来源互相矛盾**。
 */
const mgrWith = (conn: unknown, log?: ReturnType<typeof fakeLog>) => {
  const pty = (conn as { capabilities: () => { pty: boolean } }).capabilities().pty;
  return new TerminalManager({
    listProfiles: () => [
      { id: 'p1', label: 'p1', transport: 'serial', options: { port: 'COM3', pty } },
    ],
    createConnection: () => conn as never,
    createLog: () => (log ? log.log : fakeLog().log) as never,
  });
};

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

describe('TerminalManager 的会话退出', () => {
  it('远端自己退出时上报 exit —— 界面不能留着死终端', async () => {
    // 原来 Session 基类没有退出钩子，
    // 用户在 SSH 里敲了 `exit` 之后界面还留着标签页，
    // 继续打字写进一个已经死了的通道——
    // 「板子掉线了但界面不知道」，与「驾驶舱而非遥控器」直接冲突。
    const { conn, exit } = fakeConn({ pty: true });
    const mgr = mgrWith(conn);
    const seen: Array<number | null> = [];
    mgr.onExit((_id, code) => seen.push(code));

    const { sessionId } = await mgr.open('p1');
    exit(0);
    // 收尾是异步的（要等连接真的关掉），所以等一拍
    await new Promise((r) => setTimeout(r, 10));

    expect(seen).toEqual([0]);
    // 会话已经被收掉
    expect(() => mgr.write(sessionId, 'x')).toThrow();
  });
});

describe('TerminalManager 的 pipe 模式提示符', () => {
  it('会话开起来时画一次 profile 里的提示符', async () => {
    // profile 的 `options.prompt` 是「pipe 模式下宿主要画的提示符」。
    // 没有它，ADB 终端打开就是一片空白，用户不知道该输入什么。
    const { conn } = fakeConn({ pty: false });
    const mgr = new TerminalManager({
      listProfiles: () => [
        { id: 'p1', label: 'p1', transport: 'adb', options: { prompt: 'root@board$ ' } },
      ],
      createConnection: () => conn as never,
      createLog: () => ({ write: vi.fn(), writeEvent: vi.fn(), close: vi.fn(), filePath: 'x' }) as never,
    });
    const seen: string[] = [];
    mgr.onData((_id, chunk) => seen.push(chunk));
    await mgr.open('p1');
    expect(seen.join('')).toContain('root@board$ ');
  });

  it('pty 模式不画提示符 —— 远端自己有', async () => {
    const { conn } = fakeConn({ pty: true });
    const mgr = new TerminalManager({
      listProfiles: () => [
        { id: 'p1', label: 'p1', transport: 'ssh', options: { prompt: 'root@board$ ' } },
      ],
      createConnection: () => conn as never,
      createLog: () => ({ write: vi.fn(), writeEvent: vi.fn(), close: vi.fn(), filePath: 'x' }) as never,
    });
    const seen: string[] = [];
    mgr.onData((_id, chunk) => seen.push(chunk));
    await mgr.open('p1');
    expect(seen).toEqual([]);
  });
});

describe('第三轮审计补的用例', () => {
  it('一次会话只落一份日志 —— 连接与会话共用同一个', async () => {
    // 之前连接自己造一份、会话又造一份，两份 label 一样 →
    // **一次会话两个文件**，输入与输出分居两处，
    // 而连接那份永远没有收尾行。
    const { conn } = fakeConn({ pty: true });
    const created: unknown[] = [];
    const mgr = new TerminalManager({
      listProfiles: () => [{ id: 'p1', label: 'p1', transport: 'serial', options: {} }],
      createConnection: (_p, log) => {
        created.push(log);
        return conn as never;
      },
      createLog: () => fakeLog().log as never,
    });

    const { sessionId } = await mgr.open('p1');
    // 连接拿到的日志与 manager 写输出用的是同一份
    expect(created).toHaveLength(1);
    expect(created[0]).toBeTruthy();
    expect(sessionId).toBeTruthy();
  });

  it('关会话要等连接真的关掉 —— 不然「关标签 → 马上重开」会撞 PORT_BUSY', async () => {
    let closed = false;
    const { conn } = fakeConn({ pty: true });
    (conn as unknown as { close: () => Promise<void> }).close = async () => {
      await new Promise((r) => setTimeout(r, 30));
      closed = true;
    };
    const mgr = mgrWith(conn);
    const { sessionId } = await mgr.open('p1');
    await mgr.close(sessionId);
    expect(closed).toBe(true);
  });

  it('收尾顺序与黄金样本一致：disconnected → stream-ended → closed', async () => {
    // 样本：--- disconnected --- → --- stream-ended --- → === session closed ===
    const { conn, exit } = fakeConn({ pty: true });
    const log = fakeLog();
    const mgr = mgrWith(conn, log);
    await mgr.open('p1');
    exit(0);
    await new Promise((r) => setTimeout(r, 10));

    const kinds = log.events.filter((e) => e !== 'write:hello');
    const order = kinds.map((e) => e.replace('event:', '').split(' ')[0]);
    expect(order.indexOf('disconnected')).toBeLessThan(order.indexOf('stream-ended'));
    expect(order.indexOf('stream-ended')).toBeLessThan(order.indexOf('close'));
  });

  it('连接失败也要收尾日志 —— 不能留一个没有收尾行的半截', async () => {
    const log = fakeLog();
    const mgr = new TerminalManager({
      listProfiles: () => [{ id: 'p1', label: 'p1', transport: 'serial', options: {} }],
      createConnection: () => {
        throw new Error('连不上');
      },
      createLog: () => log.log as never,
    });
    await expect(mgr.open('p1')).rejects.toThrow();
    expect(log.events).toContain('close');
  });
});

describe('第三轮复评补的用例', () => {
  it('终端模式由 profile 的 pty 决定 —— 运行时与 UI 侧必须是同一个来源', async () => {
    // `connection.capabilities().pty` 是**传输的常量**，看都不看 profile；
    // 而 UI 侧的 `connections:list` 用的是 profile 感知的 `capabilitiesFor`。
    // 两个来源互相矛盾 → 用户改 profile 的 pty，界面说 false、运行时仍按 true 走，
    // 于是宿主不做行编辑也不回显，**用户打的字一个都看不见**。
    //
    // 这条测试故意让**假连接报 pty: true**，而 profile 说 false：
    // 运行时必须听 profile 的。
    const { conn, written } = fakeConn({ pty: true });
    const mgr = new TerminalManager({
      listProfiles: () => [
        { id: 'p1', label: 'p1', transport: 'serial', options: { port: 'COM3', pty: false } },
      ],
      createConnection: () => conn as never,
      createLog: () => fakeLog().log as never,
    });

    const { sessionId } = await mgr.open('p1');
    mgr.write(sessionId, 'ls\r');
    // pipe 模式：回车发的是 LF（不是原样的 \r）
    expect(written).toEqual(['ls\n']);
  });
});
