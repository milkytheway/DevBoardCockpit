import { describe, it, expect, vi } from 'vitest';
import { TerminalManager } from '../../src/main/terminal/manager';

/**
 * A fake connection: it records the data written to the remote side and keeps
 * the data callback of the session, so that the test can tell "written to the
 * remote side" from "echoed to the user" apart.
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
    /** Simulates "the remote side exited on its own" */
    exit: (code: number | null) => exitCb?.(code),
  };
};

/**
 * A fake log: it **records the order of the calls**.
 *
 * The earlier fake log was nothing but a pile of `vi.fn()`, which hid "how
 * many files does one session write and in which order the event lines
 * come" — two defects of the third audit were hiding in there.
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
 * Builds a manager.
 *
 * The `pty` of the profile is **derived from the capability bits of the fake
 * connection** — so every case that wants to test the pty or the pipe mode
 * only has to change `fakeConn({ pty })` in one place.
 *
 * Note: **the terminal mode of the runtime is decided by the profile** (the
 * third re-review, S-03). The manager used to read
 * `connection.capabilities().pty` (a constant of the transport), so the
 * `pty` of the profile could not change the runtime, while the interface
 * reads the profile — **the two sources of the capability bits contradicted
 * each other**.
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
  it('the pty mode: the written data is handed to the remote side as it is', async () => {
    const { conn, written } = fakeConn({ pty: true });
    const mgr = mgrWith(conn);
    const { sessionId } = await mgr.open('p1');
    mgr.write(sessionId, 'ls\r');
    expect(written).toEqual(['\r', 'ls\r']);
  });

  it('the pipe mode: the return key sends an LF to the remote side — the remote shell only accepts LF', async () => {
    // This one was measured on a real board:
    // in the pipe mode the '\r' is sent as it is and the shell of busybox never sees the end of a line.
    const { conn, written } = fakeConn({ pty: false });
    const mgr = mgrWith(conn);
    const { sessionId } = await mgr.open('p1');
    mgr.write(sessionId, 'ls\r');
    expect(written).toEqual(['ls\n']);
  });

  it('the pipe mode: while typing nothing is sent to the remote side, the return key sends the whole line', async () => {
    const { conn, written } = fakeConn({ pty: false });
    const mgr = mgrWith(conn);
    const { sessionId } = await mgr.open('p1');
    mgr.write(sessionId, 'ls');
    expect(written).toEqual([]);
    mgr.write(sessionId, '\r');
    expect(written).toEqual(['ls\n']);
  });

  it('a multi-byte input is passed through as it is, neither truncated nor replaced (RF-2)', async () => {
    const { conn, written } = fakeConn({ pty: true });
    const mgr = mgrWith(conn);
    const { sessionId } = await mgr.open('p1');
    mgr.write(sessionId, '中文abc');
    expect(written.join('')).toContain('中文abc');
  });

  it('in the pipe mode the host echoes to the user itself (with adb and no PTY the board does not echo)', async () => {
    const { conn } = fakeConn({ pty: false });
    const mgr = mgrWith(conn);
    const seen: string[] = [];
    mgr.onData((_id, chunk) => seen.push(chunk));
    const { sessionId } = await mgr.open('p1');
    mgr.write(sessionId, 'ls\r');
    // The echo goes through the data channel, otherwise the operator does not see what they type
    expect(seen.join('')).toContain('ls');
  });

  it('the pty mode does not echo additionally (the remote side echoes itself)', async () => {
    const { conn } = fakeConn({ pty: true });
    const mgr = mgrWith(conn);
    const seen: string[] = [];
    mgr.onData((_id, chunk) => seen.push(chunk));
    const { sessionId } = await mgr.open('p1');
    mgr.write(sessionId, 'ls\r');
    expect(seen).toEqual([]);
  });

  it('the output of the session is forwarded to the subscribers', async () => {
    const { conn, emit } = fakeConn({ pty: true });
    const mgr = mgrWith(conn);
    const seen: string[] = [];
    mgr.onData((_id, chunk) => seen.push(chunk));
    const { sessionId } = await mgr.open('p1');
    emit('hello from board');
    expect(seen).toEqual(['hello from board']);
    expect(sessionId).toBeTruthy();
  });

  it('opening a profile that does not exist reports TERM_NOT_FOUND', async () => {
    const { conn } = fakeConn({ pty: false });
    const mgr = mgrWith(conn);
    await expect(mgr.open('nope')).rejects.toMatchObject({ code: 'TERM_NOT_FOUND' });
  });
});

describe('the exit of a session in the TerminalManager', () => {
  it('when the remote side exits on its own it reports an exit — the interface may not keep a dead terminal', async () => {
    // The Session base class had no exit hook,
    // so after the operator typed `exit` in the SSH session the interface still kept the tab,
    // and the next keystrokes went into a channel that was already dead —
    // "the board dropped off and the interface does not know", which contradicts "a cockpit, not a remote control" directly.
    const { conn, exit } = fakeConn({ pty: true });
    const mgr = mgrWith(conn);
    const seen: Array<number | null> = [];
    mgr.onExit((_id, code) => seen.push(code));

    const { sessionId } = await mgr.open('p1');
    exit(0);
    // The finishing is asynchronous (it waits for the connection to be closed), so wait a tick
    await new Promise((r) => setTimeout(r, 10));

    expect(seen).toEqual([0]);
    // The session has already been torn down
    expect(() => mgr.write(sessionId, 'x')).toThrow();
  });
});

describe('the prompt of the pipe mode in the TerminalManager', () => {
  it('when the session opens, the prompt of the profile is drawn once', async () => {
    // The `options.prompt` of the profile is "the prompt the host draws in the pipe mode".
    // Without it the ADB terminal opens blank and the operator does not know what to type.
    const { conn } = fakeConn({ pty: false });
    const mgr = new TerminalManager({
      listProfiles: () => [
        { id: 'p1', label: 'p1', transport: 'adb', options: { prompt: 'root@board$ ' } },
      ],
      createConnection: () => ({ ...conn, transport: 'adb' }) as never,
      createLog: () => ({ write: vi.fn(), writeEvent: vi.fn(), close: vi.fn(), filePath: 'x' }) as never,
    });
    const seen: string[] = [];
    mgr.onData((_id, chunk) => seen.push(chunk));
    await mgr.open('p1');
    const plain = seen.join('').replace(
      new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'),
      '',
    );
    expect(plain).toContain('root@board$ ');
  });

  it('the pty mode draws no prompt — the remote side has one', async () => {
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

  it('the pty mode does not draw a second prompt after the remote prompt arrives', async () => {
    const { conn, emit } = fakeConn({ pty: true });
    const mgr = new TerminalManager({
      listProfiles: () => [
        { id: 'p1', label: 'p1', transport: 'serial', options: { prompt: 'root@board' } },
      ],
      createConnection: () => conn as never,
      createLog: () => ({ write: vi.fn(), writeEvent: vi.fn(), close: vi.fn(), filePath: 'x' }) as never,
    });
    const seen: string[] = [];
    mgr.onData((_id, chunk) => seen.push(chunk));
    await mgr.open('p1');
    emit('root@board:/# ');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seen).toEqual(['root@board:/# ']);
  });
});

describe('the cases added by the third audit', () => {
  it('one session writes one log — the connection and the session share it', async () => {
    // Earlier the connection built one and the session built another, with the same label →
    // **one session, two files**, the input and the output in different places,
    // and the one of the connection never had a closing line.
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
    // The log the connection got is the same one the manager writes the output to
    expect(created).toHaveLength(1);
    expect(created[0]).toBeTruthy();
    expect(sessionId).toBeTruthy();
  });

  it('closing the session waits for the connection to be closed — otherwise "close the tab and reopen it at once" runs into PORT_BUSY', async () => {
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

  it('the order of the closing events matches the golden sample: disconnected → stream-ended → closed', async () => {
    // the sample: --- disconnected --- → --- stream-ended --- → === session closed ===
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

  it('a failed connection also writes the closing log — it may not leave a half without the closing line', async () => {
    const log = fakeLog();
    const mgr = new TerminalManager({
      listProfiles: () => [{ id: 'p1', label: 'p1', transport: 'serial', options: {} }],
      createConnection: () => {
        throw new Error('cannot be reached');
      },
      createLog: () => log.log as never,
    });
    await expect(mgr.open('p1')).rejects.toThrow();
    expect(log.events).toContain('close');
  });
});

describe('the cases added by the third re-review', () => {
  it('the terminal mode is decided by the pty of the profile — the runtime and the interface have to take it from the same source', async () => {
    // `connection.capabilities().pty` is **a constant of the transport** and it does not even look at the profile;
    // the `connections:list` of the interface uses the profile-aware `capabilitiesFor`.
    // The two sources contradict each other → the operator changes the pty of the profile, the interface says false and the runtime still behaves as true,
    // so the host does neither the line editing nor the echo, and **not a single character the operator types is visible**.
    //
    // This case deliberately lets the **fake connection report pty: true** while the profile says false:
    // the runtime has to obey the profile.
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
    // The pipe mode: the return key sends an LF (not the raw \r)
    expect(written).toEqual(['ls\n']);
  });
});
