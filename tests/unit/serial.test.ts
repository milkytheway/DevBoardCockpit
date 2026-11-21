import { describe, it, expect, vi } from 'vitest';
import { serialCapabilities, SerialConnection, type SerialPortFactory } from '../../src/main/hal/serial';

const profile = {
  id: 's', label: 's', transport: 'serial' as const,
  options: { port: 'COM3', baudrate: 1500000 },
};
const log = { write: vi.fn(), close: vi.fn(), filePath: 'x' };

/**
 * A fake serial port: it **echoes every line it receives**, the way a real
 * board does, and then simulates the execution.
 *
 * This is the most important change of the test scaffolding in this round:
 * the earlier fake serial port was "an answer written to the contract" and it
 * hid the bugs in the shape of the marker protocol. It is now modelled by the
 * real behaviour:
 *   it receives `uptime; echo __DBC..__`
 *   → it echoes that line (the marker appears the first time)
 *   → it writes the result of the command
 *   → it executes the echo (the marker appears the second time)
 */
const fakeBoard = (output = 'hi'): { factory: SerialPortFactory; sent: string[] } => {
  const sent: string[] = [];
  let cb: ((chunk: string) => void) | undefined;
  const factory: SerialPortFactory = async () => ({
    write(data: string) {
      sent.push(data);
      const line = data.replace(/\r\n$/, '');
      const m = /;\s*echo\s+(__DBC\d+_\d+__)\s*$/.exec(line);
      // The echo (the marker appears the first time)
      cb?.(`${line}\r\n`);
      if (!m) return;
      // The output of the command
      cb?.(`${output}\r\n`);
      // The output of the echo (the marker appears the second time)
      cb?.(`${m[1]}\r\n`);
    },
    onData(handler) { cb = handler; },
    onError() { /* no-op */ },
    async close() { /* no-op */ },
  });
  return { factory, sent };
};

describe('serialCapabilities', () => {
  it('the serial port is a console: can it transfer files? No; can it give an exit code? No (facts S5/S7)', () => {
    expect(serialCapabilities()).toEqual({ exec: true, pty: true, files: false, exitCode: false });
  });
});

describe('SerialConnection.exec', () => {
  it('it claims the output between the markers and returns the exit code 0 (a serial port has no exit code, text means 0)', async () => {
    const { factory } = fakeBoard(' 12:00:00 up 3 days');
    const conn = new SerialConnection(profile, log as never, factory);
    await conn.open();
    const res = await conn.exec('uptime');
    // The output is the result of the command, **not the command text itself**
    expect(res.stdout.trim()).toBe('12:00:00 up 3 days');
    expect(res.exitCode).toBe(0);
  });

  it('the command that is sent and the marker are on the same line (the board echoes once and the echo answers once = the marker appears twice)', async () => {
    const { factory, sent } = fakeBoard();
    const conn = new SerialConnection(profile, log as never, factory);
    await conn.open();
    await conn.exec('uptime');
    expect(sent).toHaveLength(1);
    expect(sent[0].trimEnd()).toMatch(/^uptime; echo __DBC\d+_\d+__$/);
  });

  it('the output holds no marker (RF-1)', async () => {
    const { factory } = fakeBoard('hello');
    const conn = new SerialConnection(profile, log as never, factory);
    await conn.open();
    const res = await conn.exec('uptime');
    expect(res.stdout).not.toContain('__DBC');
  });

  it('an output beyond 64 KB is still claimed back — the old "absolute index plus clipping" would fail there for good', async () => {
    // This case corresponds to the measurement on a real board:
    // The marker used to be claimed by the **absolute index** of the transcript, and the transcript is clipped,
    // so after a large output **the exec channel of that connection died for good**
    // (every command hung for 30 seconds and returned an empty output).
    //
    // The way it works now is "every exec has its own buffer", there is no index at all.
    const big = 'x'.repeat(100 * 1024);
    const { factory } = fakeBoard(big);
    const conn = new SerialConnection(profile, log as never, factory);
    await conn.open();
    const res = await conn.exec('cat bigfile', { timeoutMs: 5000 });
    expect(res.timedOut).toBe(false);
    expect(res.stdout.length).toBe(big.length);
  });

  it('while an interactive session is open, exec is refused — one line cannot carry two round trips at a time (fact S1)', async () => {
    // The lock used to stop only exec against exec: while a session was open,
    // every exec **appended the command after the input the operator had not finished**
    // (the shell on the board received `ls -l /tmpuptime; echo marker`).
    const { factory } = fakeBoard('hi');
    const conn = new SerialConnection(profile, log as never, factory);
    await conn.open();

    const session = await conn.openSession();
    await expect(conn.exec('uptime')).rejects.toMatchObject({ code: 'CONN_BUSY' });

    // Once the session is closed the line is free again
    session.close();
    await expect(conn.exec('uptime')).resolves.toMatchObject({ exitCode: 0 });
  });

  it('when the port is busy it reports PORT_BUSY and names the port (RF-5)', async () => {
    const factory: SerialPortFactory = async () => {
      throw Object.assign(new Error('Resource busy'), { code: 'EBUSY' });
    };
    const conn = new SerialConnection(profile, log as never, factory);
    await expect(conn.open()).rejects.toThrow(/COM3/);
    await expect(conn.open()).rejects.toMatchObject({ code: 'PORT_BUSY' });
  });

  it('two concurrent exec calls on one connection are refused (the round trips are mutually exclusive, contract §1.2.1)', async () => {
    // The fake board does not answer → the first exec waits until the timeout and holds the line
    const factory: SerialPortFactory = async () => ({
      write() { /* nothing comes back */ },
      onData() { /* no-op */ },
      onError() { /* no-op */ },
      async close() { /* no-op */ },
    });
    const conn = new SerialConnection(profile, log as never, factory);
    await conn.open();

    const first = conn.exec('uptime', { timeoutMs: 200 });
    // The second command may not come in — the answers of two markers would interleave in the same transcript
    // and claim the output of each other
    await expect(conn.exec('uname', { timeoutMs: 200 })).rejects.toMatchObject({
      // "refused" and "really timed out" are different codes: the interface has to tell them apart
      code: 'CONN_BUSY',
    });
    await first;
  });

  it('a Chinese character written out is UTF-8 bytes and is not truncated (RF-2)', async () => {
    const { factory, sent } = fakeBoard();
    const conn = new SerialConnection(profile, log as never, factory);
    await conn.open();
    await conn.exec('echo 中文');
    // What is written out is the UTF-8 bytes of the command line plus the marker
    const bytes = Buffer.from(sent[0], 'utf8');
    expect(bytes.toString('utf8')).toContain('中文');
    // and not half a truncated character (U+FFFD)
    expect(bytes.toString('utf8')).not.toContain('\uFFFD');
  });

  it('**the terminal says so when the port does not answer** ✓ (an empty terminal with no explanation is the "I cannot type" report ✓)', async () => {
    // A port that stays silent: it is not the console of the board ✓
    const factory: SerialPortFactory = async () => ({
      write() { /* nothing comes back */ },
      onData() { /* no-op */ },
      onError() { /* no-op */ },
      async close() { /* no-op */ },
    });
    const conn = new SerialConnection(profile, log as never, factory);
    await conn.open();
    await conn.openSession();
    const notices = conn.drainNotices?.() ?? [];
    expect(notices.join('')).toMatch(/COM3/);
    // The reason is named: the console may be on another port ✓
    expect(notices.join('')).toMatch(/another serial port/);
    // The notices are drained once ✓ (they are not repeated forever ✓)
    expect(conn.drainNotices?.() ?? []).toHaveLength(0);
  });

  it('**a port that answers says nothing** ✓ (the board is there ✓ → no noise ✓)', async () => {
    const { factory } = fakeBoard();
    const conn = new SerialConnection(profile, log as never, factory);
    await conn.open();
    await conn.openSession();
    expect(conn.drainNotices?.() ?? []).toHaveLength(0);
  });

  it('on a timeout it returns 124 and timedOut is true (fact S5)', async () => {
    // The fake board does not answer → only the timeout can help
    const factory: SerialPortFactory = async () => ({
      write() { /* nothing comes back */ },
      onData() { /* no-op */ },
      onError() { /* no-op */ },
      async close() { /* no-op */ },
    });
    const conn = new SerialConnection(profile, log as never, factory);
    await conn.open();
    const res = await conn.exec('uptime', { timeoutMs: 150 });
    expect(res.exitCode).toBe(124);
    expect(res.timedOut).toBe(true);
  });
});
