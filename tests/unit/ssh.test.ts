import { describe, it, expect, vi } from 'vitest';
import { sshCapabilities, sshArgs, sshOpenError, SshConnection } from '../../src/main/hal/ssh';

describe('sshCapabilities', () => {
  it('SSH has a real pty and can transfer files', () => {
    expect(sshCapabilities()).toEqual({ exec: true, pty: true, files: true, exitCode: true });
  });
});

describe('which set of capability bits Connection.capabilities() reports', () => {
  it('it is profile-aware, not a constant of the transport', () => {
    // **This used to report the constants of the transport** (ssh → pty is always
// true),
    // while the `connections:list` of the UI reports the profile-aware
// `capabilitiesFor(profile)` —
    // **the two sources contradicted each other**: with the pty of the profile set
// to false,
    // the UI reported false while the connection object reported true.
    // `terminal/manager.ts` had found the contradiction long ago (it bypasses the
// connection object and calls
    // `capabilitiesFor` directly), but the contradiction itself was never removed —
// now the connection object calls the same function.
    const conn = new SshConnection(
      { id: 's', label: 's', transport: 'ssh', options: { host: 'h', port: 22, pty: false } },
      fakeLog,
    );
    expect(conn.capabilities().pty).toBe(false);
  });

  it('when the profile says nothing about the pty, the default of the transport applies', () => {
    const conn = new SshConnection(
      { id: 's', label: 's', transport: 'ssh', options: { host: 'h', port: 22 } },
      fakeLog,
    );
    expect(conn.capabilities()).toEqual({ exec: true, pty: true, files: true, exitCode: true });
  });
});

describe('sshArgs', () => {
  it('it assembles host / port / username', () => {
    const args = sshArgs({
      id: 's', label: 's', transport: 'ssh',
      options: { host: '192.168.100.10', port: 22, username: 'alientek' },
    });
    expect(args).toEqual({
      host: '192.168.100.10',
      port: 22,
      // **Without it the handshake waits 20 seconds** ✓ (the default of ssh2 ✓)
      // → the interface says nothing for 20 seconds ✓ → it looks like the
      //   application is hanging ✓ (found on 2026-11-21 ✓).
      readyTimeout: 8000,
      username: 'alientek',
    });
  });

  it('a missing host is an error (fact H1: when the connection fails, it has to name the host)', () => {
    expect(() => sshArgs({ id: 's', label: 's', transport: 'ssh', options: {} }))
      .toThrow(/host/);
  });
});

describe('SshConnection.openSession', () => {
  it('openSession returns the shell channel, not the client (the shell() of ssh2 gives the channel in its callback)', async () => {
    // A fake client: connect triggers ready, shell() gives the channel in its callback
    const fakeChannel = { write: vi.fn(), setWindow: vi.fn(), close: vi.fn() };
    const listeners: Record<string, () => void> = {};
    const fakeClient = {
      once(evt: string, cb: () => void) { listeners[evt] = cb; return this; },
      off() { return this; },
      on() { return this; },
      connect() {
        // The next tick triggers ready, it simulates the asynchronous handshake
        setTimeout(() => listeners['ready']?.(), 0);
        return this;
      },
      end() {},
      shell(
        _opts: unknown,
        cb: (err: Error | undefined, ch: unknown) => void,
      ) {
        // An **asynchronous** callback: the shell() of ssh2 needs one round trip before
// it gives the channel.
        // A fake client that called back synchronously would hide the bug of "taking
// the channel synchronously".
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
 * A fake ssh2 event channel.
 *
 * It is modelled by **behaviour** only: it can carry listeners and it can
 * emit events. A stand-in that returns "the answer the contract expects"
 * would hide the bugs in the shape of the protocol (AGENTS §3).
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

/** A fake exec stream: stdout has its own, stderr has another one */
class FakeExecStream extends FakeEmitter {
  readonly stderr = new FakeEmitter();
}

/** A fake interactive channel */
class FakeChannel extends FakeEmitter {
  readonly write = vi.fn();
  readonly setWindow = vi.fn();
  readonly close = vi.fn();
}

interface FakeClientOptions {
  /** The fragments of stdout of an exec answer (cut by chunk, to test the decoding across chunks) */
  stdoutChunks?: Buffer[];
  /** The fragments of stderr of an exec answer */
  stderrChunks?: Buffer[];
  /** The answer of an sftp readdir */
  readdir?: { err?: Error; list?: unknown[] };
  /** The remote side of exec does **not** close the channel — it is used to test the timeout path */
  execNeverCloses?: boolean;
}

interface FakeClientHandle {
  client: unknown;
  /** The commands exec was called with (= a remote command was run) */
  execCalls: string[];
  /** The paths readdir was called with (= the sftp channel was used) */
  readdirCalls: string[];
  /** The channel of the interactive session */
  channel: FakeChannel;
  /** Whether the sftp channel was ended */
  sftpEnded: () => boolean;
  /** How often the whole client was ended — **a timeout may not tear down the connection** */
  endCalls: () => number;
}

/**
 * A fake ssh2 client.
 *
 * **The callbacks of exec / shell / sftp are all asynchronous** (setTimeout):
 * all three entry points of ssh2 need one round trip before they give a
 * result. A fake client that called back synchronously would hide the bugs of
 * the real timing (see the comment in the openSession test above).
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
        // The data and the close also arrive on the **next tick**: a real stream does
// not produce data synchronously inside a callback
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
  it('list uses the readdir of sftp and does not run ls on the remote side', async () => {
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

    // It uses the sftp channel, not a remote command
    expect(handle.readdirCalls).toEqual(['/root']);
    expect(handle.execCalls).toEqual([]);
    // The sftp channel has to be closed after use (pull / push do the same)
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

  it('the sizeBytes of a directory is null, not 4096 (fact G2: a thing that cannot be read is not 0)', async () => {
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

  it('when the mode is not available it falls back to the first character of the longname', async () => {
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

  it('when the mtime is 0, modifiedAt is null, not the year 1970', async () => {
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

  it('when readdir fails it reports FILE_TRANSFER_FAILED and carries the remotePath', async () => {
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

  it('a trailing slash of the remotePath is not joined twice into the path of the entry', async () => {
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

describe('the decoding of the SSH output (constraint G15 / risk RF-3)', () => {
  it('a multi-byte character of the stdout of exec, split across chunks, is not corrupted', async () => {
    null
// into the second.
    // Decoding every chunk on its own yields two U+FFFD, and valid content is
// silently corrupted.
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

  it('a multi-byte character of the session channel, split across chunks, is not corrupted', async () => {
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

describe('the timeout path of SshConnection.exec', () => {
  it('a timeout closes only that one channel, it does not tear down the whole connection', async () => {
    // The timeout used to call `this.client.end()` — that would close **every
// channel** of that client
    // at once: the interactive terminal the operator is using would break
// immediately,
    // while the connection is already dead but still treated as "open".
    const handle = makeFakeClient({ execNeverCloses: true });
    const conn = makeConn(handle);
    await conn.open();

    const result = await conn.exec('sleep 100', { timeoutMs: 50 });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    // The connection may not be torn down
    expect(handle.endCalls()).toBe(0);
  });

  it('when the remote side does not close the channel, the promise still settles on its own (it may not hang forever)', async () => {
    const handle = makeFakeClient({ execNeverCloses: true });
    const conn = makeConn(handle);
    await conn.open();

    // Without a separate path that settles it on timeout, this promise never
// settles,
    // and the caller hangs forever — a timeout is used here as a floor so that the
// test cannot hang.
    const result = await Promise.race([
      conn.exec('sleep 100', { timeoutMs: 50 }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('it hung')), 2000)),
    ]);
    expect(result.timedOut).toBe(true);
  });
});

/**
 * **The failure has to say which problem it is** ✓.
 *
 * → "cannot reach the SSH host" for *every* failure ✓ sends the user looking
 *   for a network problem that does not exist ✓ (measured on 2026-11-21 ✓:
 *   the board answered ✓ and refused the credential ✓ — and the message said
 *   "cannot reach" ✓).
 * → The three failures are three different problems ✓.
 */
describe('the failure of an ssh connection', () => {
  const opts = { host: '192.168.5.100', port: 22, username: 'root' };

  it('**the host did not answer → it says "cannot reach"** ✓', () => {
    const err = sshOpenError(
      Object.assign(new Error('connect ECONNREFUSED'), { level: 'client-socket' }),
      opts,
      'key',
    );
    expect(err.message).toMatch(/cannot reach the SSH host 192\.168\.5\.100:22/);
  });

  it('**the host answered and refused the credential → it says so** ✓', () => {
    const err = sshOpenError(
      Object.assign(new Error('All configured authentication methods failed'), {
        level: 'client-authentication',
      }),
      opts,
      'key',
    );
    expect(err.message).toMatch(/answered but refused the credential/);
    expect(err.message).not.toMatch(/cannot reach/);
  });

  it('**there was no credential at all → it says that** ✓', () => {
    const err = sshOpenError(
      Object.assign(new Error('All configured authentication methods failed'), {
        level: 'client-authentication',
      }),
      opts,
      'none',
    );
    expect(err.message).toMatch(/no credential/);
  });
});
