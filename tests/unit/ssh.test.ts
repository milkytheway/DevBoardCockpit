import { describe, it, expect, vi } from 'vitest';
import { sshCapabilities, sshArgs, SshConnection } from '../../src/main/hal/ssh';

describe('sshCapabilities', () => {
  it('SSH 有真 pty、能传文件', () => {
    expect(sshCapabilities()).toEqual({ exec: true, pty: true, files: true, exitCode: true });
  });
});

describe('sshArgs', () => {
  it('拼出 host / port / username', () => {
    const args = sshArgs({
      id: 's', label: 's', transport: 'ssh',
      options: { host: '192.168.136.131', port: 22, username: 'alientek' },
    });
    expect(args).toEqual({ host: '192.168.136.131', port: 22, username: 'alientek' });
  });

  it('缺 host 时报错（事实 H1：连不上要说清是哪个主机）', () => {
    expect(() => sshArgs({ id: 's', label: 's', transport: 'ssh', options: {} }))
      .toThrow(/host/);
  });
});

describe('SshConnection.openSession', () => {
  it('openSession 拿到的是 shell 通道而不是 client（ssh2 的 shell() 在回调里给通道）', async () => {
    // 假 client：connect 触发 ready，shell() 回调给出通道
    const fakeChannel = { write: vi.fn(), setWindow: vi.fn(), close: vi.fn() };
    const listeners: Record<string, () => void> = {};
    const fakeClient = {
      once(evt: string, cb: () => void) { listeners[evt] = cb; return this; },
      off() { return this; },
      on() { return this; },
      connect() {
        // 下一拍触发 ready，模拟异步握手
        setTimeout(() => listeners['ready']?.(), 0);
        return this;
      },
      end() {},
      shell(
        _opts: unknown,
        cb: (err: Error | undefined, ch: unknown) => void,
      ) {
        // **异步**回调：ssh2 的 shell() 要等一次往返才给通道。
        // 假 client 若同步回调，就把「同步拿通道」的 bug 盖住了。
        setTimeout(() => cb(undefined, fakeChannel), 0);
        return this;
      },
    };

    const conn = new SshConnection(
      { id: 's', label: 's', transport: 'ssh', options: { host: 'h', port: 22 } },
      { write: () => {}, close: () => {}, filePath: 'x' } as never,
      { clientFactory: () => fakeClient as never },
    );

    await conn.open();
    const session = await conn.openSession();

    session.write('ls\r');
    session.resize(80, 24);

    expect(fakeChannel.write).toHaveBeenCalledWith('ls\r');
    expect(fakeChannel.setWindow).toHaveBeenCalledWith(24, 80, 0, 0);
  });
});

/**
 * 假的 ssh2 事件通道。
 *
 * 只按**行为**建模：能挂监听、能吐事件。
 * 替身直接返回「契约期待的那个答案」会把协议形状的 bug 盖住（AGENTS §3）。
 */
class FakeEmitter {
  private readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>();

  on(evt: string, cb: (...args: unknown[]) => void): this {
    const list = this.handlers.get(evt) ?? [];
    list.push(cb);
    this.handlers.set(evt, list);
    return this;
  }

  emit(evt: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(evt) ?? []) cb(...args);
  }
}

/** 假的 exec 流：stdout 走自己，stderr 另有一条 */
class FakeExecStream extends FakeEmitter {
  readonly stderr = new FakeEmitter();
}

/** 假的交互通道 */
class FakeChannel extends FakeEmitter {
  readonly write = vi.fn();
  readonly setWindow = vi.fn();
  readonly close = vi.fn();
}

interface FakeClientOptions {
  /** exec 回包的 stdout 分片（按 chunk 切，用来测跨 chunk 解码） */
  stdoutChunks?: Buffer[];
  /** exec 回包的 stderr 分片 */
  stderrChunks?: Buffer[];
  /** sftp readdir 的回包 */
  readdir?: { err?: Error; list?: unknown[] };
  /** exec 的远端**不主动关通道**——用来测超时路径 */
  execNeverCloses?: boolean;
}

interface FakeClientHandle {
  client: unknown;
  /** exec 被调用过的命令（= 跑了远端命令） */
  execCalls: string[];
  /** readdir 被调用过的路径（= 走了 sftp 通道） */
  readdirCalls: string[];
  /** 交互会话的通道 */
  channel: FakeChannel;
  /** sftp 通道有没有被 end 掉 */
  sftpEnded: () => boolean;
  /** 整个 client 被 end 掉了几次——**超时不该拆连接** */
  endCalls: () => number;
}

/**
 * 假的 ssh2 client。
 *
 * **exec / shell / sftp 的回调全是异步的**（setTimeout）——
 * ssh2 的这三个入口都要等一次往返才给结果。
 * 假 client 若同步回调，就把真实时序的 bug 盖住了
 * （见上面 openSession 那条测试里的注释）。
 */
function makeFakeClient(opts: FakeClientOptions = {}): FakeClientHandle {
  const execCalls: string[] = [];
  const readdirCalls: string[] = [];
  const listeners: Record<string, () => void> = {};
  const channel = new FakeChannel();
  let sftpEnded = false;
  let endCalls = 0;

  const sftp = {
    readdir(path: string, cb: (err: Error | undefined, list: unknown[]) => void) {
      readdirCalls.push(path);
      setTimeout(() => cb(opts.readdir?.err, opts.readdir?.list ?? []), 0);
    },
    end() {
      sftpEnded = true;
    },
  };

  const client = {
    once(evt: string, cb: () => void) {
      listeners[evt] = cb;
      return this;
    },
    off() {
      return this;
    },
    on() {
      return this;
    },
    connect() {
      setTimeout(() => listeners['ready']?.(), 0);
      return this;
    },
    end() {
      endCalls += 1;
    },
    exec(command: string, cb: (err: Error | undefined, stream: unknown) => void) {
      execCalls.push(command);
      setTimeout(() => {
        const stream = new FakeExecStream();
        cb(undefined, stream);
        // 数据与 close 也在**下一拍**：真实的流不会在回调里同步吐数据
        setTimeout(() => {
          for (const chunk of opts.stdoutChunks ?? []) stream.emit('data', chunk);
          for (const chunk of opts.stderrChunks ?? []) stream.stderr.emit('data', chunk);
          if (!opts.execNeverCloses) setTimeout(() => stream.emit('close', 0), 0);
        }, 0);
      }, 0);
      return this;
    },
    shell(_opts: unknown, cb: (err: Error | undefined, ch: unknown) => void) {
      setTimeout(() => cb(undefined, channel), 0);
      return this;
    },
    sftp(cb: (err: Error | undefined, sftp: unknown) => void) {
      setTimeout(() => cb(undefined, sftp), 0);
      return this;
    },
  };

  return {
    client,
    execCalls,
    readdirCalls,
    channel,
    sftpEnded: () => sftpEnded,
    endCalls: () => endCalls,
  };
}

const sshProfile = {
  id: 's',
  label: 's',
  transport: 'ssh' as const,
  options: { host: 'h', port: 22 },
};

const fakeLog = { write: () => {}, close: () => {}, filePath: 'x' } as never;

function makeConn(handle: FakeClientHandle): SshConnection {
  return new SshConnection(sshProfile, fakeLog, {
    clientFactory: () => handle.client as never,
  });
}

describe('SshConnection.list', () => {
  it('list 走 sftp 的 readdir，不跑远端的 ls', async () => {
    const handle = makeFakeClient({
      readdir: {
        list: [
          {
            filename: 'bin',
            longname: 'drwxr-xr-x 2 root root 4096 Nov 12 09:30 bin',
            attrs: { mode: 0o040755, size: 4096, mtime: 1762839000 },
          },
          {
            filename: 'a.txt',
            longname: '-rw-r--r-- 1 root root 12 Nov 12 09:30 a.txt',
            attrs: { mode: 0o100644, size: 12, mtime: 1762839000 },
          },
        ],
      },
    });
    const conn = makeConn(handle);
    await conn.open();

    const entries = await conn.list('/root');

    // 走的是 sftp 通道，不是远端命令
    expect(handle.readdirCalls).toEqual(['/root']);
    expect(handle.execCalls).toEqual([]);
    // sftp 用完要关（pull / push 也是这么做的）
    expect(handle.sftpEnded()).toBe(true);

    expect(entries).toEqual([
      {
        name: 'bin',
        path: '/root/bin',
        isDirectory: true,
        sizeBytes: null,
        modifiedAt: '2025-11-11T05:30:00.000Z',
      },
      {
        name: 'a.txt',
        path: '/root/a.txt',
        isDirectory: false,
        sizeBytes: 12,
        modifiedAt: '2025-11-11T05:30:00.000Z',
      },
    ]);
  });

  it('目录的 sizeBytes 是 null，不是 4096（事实 G2：读不到的东西不是 0）', async () => {
    const handle = makeFakeClient({
      readdir: {
        list: [
          {
            filename: 'bin',
            longname: 'drwxr-xr-x 2 root root 4096 Nov 12 09:30 bin',
            attrs: { mode: 0o040755, size: 4096, mtime: 1762839000 },
          },
        ],
      },
    });
    const conn = makeConn(handle);
    await conn.open();

    const [entry] = await conn.list('/root');

    expect(entry.isDirectory).toBe(true);
    expect(entry.sizeBytes).toBeNull();
    expect(entry.sizeBytes).not.toBe(4096);
  });

  it('拿不到 mode 时退回看 longname 的首字符', async () => {
    const handle = makeFakeClient({
      readdir: {
        list: [
          {
            filename: 'bin',
            longname: 'drwxr-xr-x 2 root root 4096 Nov 12 09:30 bin',
            attrs: { size: 4096, mtime: 1762839000 },
          },
          {
            filename: 'a.txt',
            longname: '-rw-r--r-- 1 root root 12 Nov 12 09:30 a.txt',
            attrs: { size: 12, mtime: 1762839000 },
          },
        ],
      },
    });
    const conn = makeConn(handle);
    await conn.open();

    const entries = await conn.list('/root');

    expect(entries[0].isDirectory).toBe(true);
    expect(entries[0].sizeBytes).toBeNull();
    expect(entries[1].isDirectory).toBe(false);
    expect(entries[1].sizeBytes).toBe(12);
  });

  it('mtime 为 0 时 modifiedAt 是 null，不是 1970 年', async () => {
    const handle = makeFakeClient({
      readdir: {
        list: [
          {
            filename: 'x',
            longname: '-rw-r--r-- 1 root root 0 Jan 1 1970 x',
            attrs: { mode: 0o100644, size: 0, mtime: 0 },
          },
        ],
      },
    });
    const conn = makeConn(handle);
    await conn.open();

    const [entry] = await conn.list('/root');

    expect(entry.modifiedAt).toBeNull();
  });

  it('readdir 出错时报 FILE_TRANSFER_FAILED，并带上 remotePath', async () => {
    const handle = makeFakeClient({
      readdir: { err: new Error('No such file') },
    });
    const conn = makeConn(handle);
    await conn.open();

    await expect(conn.list('/nope')).rejects.toMatchObject({
      code: 'FILE_TRANSFER_FAILED',
      detail: { remotePath: '/nope' },
    });
  });

  it('remotePath 末尾的斜杠不重复拼进条目路径', async () => {
    const handle = makeFakeClient({
      readdir: {
        list: [
          {
            filename: 'a.txt',
            longname: '-rw-r--r-- 1 root root 12 Nov 12 09:30 a.txt',
            attrs: { mode: 0o100644, size: 12, mtime: 1762839000 },
          },
        ],
      },
    });
    const conn = makeConn(handle);
    await conn.open();

    const [entry] = await conn.list('/root/');

    expect(entry.path).toBe('/root/a.txt');
  });
});

describe('SSH 输出解码（约束 G15 / 风险 RF-3）', () => {
  it('exec 的 stdout 跨 chunk 拆开的中文字符不被拆坏', async () => {
    // '中' = E4 B8 AD：前两字节落在第一个 chunk，第三字节落在第二个 chunk。
    // 逐 chunk 独立解码会得到两个 U+FFFD，合法内容被静默损坏。
    const bytes = Buffer.from('中文', 'utf8');
    const handle = makeFakeClient({
      stdoutChunks: [bytes.subarray(0, 2), bytes.subarray(2)],
      stderrChunks: [Buffer.from('错误', 'utf8').subarray(0, 2), Buffer.from('错误', 'utf8').subarray(2)],
    });
    const conn = makeConn(handle);
    await conn.open();

    const result = await conn.exec('echo 中文');

    expect(result.stdout).toBe('中文');
    expect(result.stdout).not.toContain('�');
    expect(result.stderr).toBe('错误');
    expect(result.stderr).not.toContain('�');
  });

  it('会话通道跨 chunk 拆开的中文字符不被拆坏', async () => {
    const handle = makeFakeClient();
    const conn = makeConn(handle);
    await conn.open();
    const session = await conn.openSession();

    const chunks: string[] = [];
    session.onData((chunk) => chunks.push(chunk));

    const bytes = Buffer.from('中', 'utf8');
    handle.channel.emit('data', bytes.subarray(0, 2));
    handle.channel.emit('data', bytes.subarray(2));

    const text = chunks.join('');
    expect(text).toBe('中');
    expect(text).not.toContain('�');
    expect([...text]).toHaveLength(1);
  });
});

describe('SshConnection.exec 的超时路径', () => {
  it('超时只关那一条通道，不拆整条连接', async () => {
    // 原来超时调的是 `this.client.end()`——那会把该 client 上**所有通道**
    // 一起关掉：用户正用着的交互终端当场断掉，
    // 而连接已经死了却仍被当成「已打开」。
    const handle = makeFakeClient({ execNeverCloses: true });
    const conn = makeConn(handle);
    await conn.open();

    const result = await conn.exec('sleep 100', { timeoutMs: 50 });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    // 连接不该被拆
    expect(handle.endCalls()).toBe(0);
  });

  it('远端不关通道时，Promise 也要自己结算（不能永久挂起）', async () => {
    const handle = makeFakeClient({ execNeverCloses: true });
    const conn = makeConn(handle);
    await conn.open();

    // 若没有独立的超时结算路径，这个 Promise 永不 settle，
    // 调用方永久挂起——这里用超时兜底保证测试不会挂死。
    const result = await Promise.race([
      conn.exec('sleep 100', { timeoutMs: 50 }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('挂住了')), 2000)),
    ]);
    expect(result.timedOut).toBe(true);
  });
});
