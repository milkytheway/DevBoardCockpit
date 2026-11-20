import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { adbCapabilities, adbArgs, AdbConnection } from '../../src/main/hal/adb';
import type { runProcess, SpawnResult } from '../../src/main/util/spawn';

const profile = (opts: Record<string, unknown>) => ({
  id: 'a', label: 'a', transport: 'adb' as const, options: opts,
});

/** The stand-in for the connection log: the adb cases care about the commands, not about the log */
const log = { write: () => {}, close: () => {}, filePath: 'x' } as never;

/**
 * A fake runner: it **dispatches on the arguments** and imitates the behaviour
 * of a real adb.
 *
 * Why it may not be "the same stdout for every command":
 * `adb devices` and `adb shell ls -la` are two different commands, and a real
 * adb answers them completely differently (the first lists every device with
 * its state, the second returns the content of a directory). A stand-in that
 * ignores the arguments would hide the bugs of "which command actually ran",
 * so the dispatch is on the command (the rule: a stand-in is modelled by
 * behaviour, not by conclusion).
 *
 * It stays asynchronous: a real adb is a child process, its answer necessarily
 * lands in a later turn of the event loop.
 */
function fakeAdb(opts: {
  /** The stdout of `adb devices` */
  devices?: string;
  /** The stdout of `adb shell ls -la` */
  ls?: string;
  /** The exit code of `adb shell ls -la` */
  lsExitCode?: number;
  /** The stderr of `adb shell ls -la` */
  lsStderr?: string;
} = {}): { runner: typeof runProcess; calls: { command: string; args: string[] }[] } {
  const calls: { command: string; args: string[] }[] = [];
  const runner = async (command: string, args: string[]): Promise<SpawnResult> => {
    calls.push({ command, args });
    // `adb devices`: it lists **every** device (`-s` does not filter either)
    if (args.includes('devices')) {
      return { exitCode: 0, stdout: opts.devices ?? '', stderr: '', durationMs: 1, timedOut: false };
    }
    // `adb shell <command>`
    if (args.includes('shell')) {
      const line = args[args.length - 1] ?? '';
      if (line.startsWith('ls -la')) {
        return {
          exitCode: opts.lsExitCode ?? 0,
          stdout: opts.ls ?? '',
          stderr: opts.lsStderr ?? '',
          durationMs: 1,
          timedOut: false,
        };
      }
    }
    return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
  };
  return { runner, calls };
}

/** Catches the error of open(): it needs the code and the message (`toThrow` only sees the string) */
async function openError(conn: AdbConnection): Promise<{ code: string; message: string; detail?: unknown }> {
  try {
    await conn.open();
  } catch (err) {
    return err as { code: string; message: string; detail?: unknown };
  }
  throw new Error('open() should have failed, but it succeeded');
}

describe('adbCapabilities', () => {
  it('it uses no PTY (fact A1), but it can transfer files and it can get the exit code', () => {
    expect(adbCapabilities()).toEqual({ exec: true, pty: false, files: true, exitCode: true });
  });
});

describe('adbArgs', () => {
  it('with a serial number it prefixes -s <serial>', () => {
    expect(adbArgs(profile({ serial: '0000000000000000' }), ['shell']))
      .toEqual(['-s', '0000000000000000', 'shell']);
  });

  it('without a serial number it carries no -s', () => {
    expect(adbArgs(profile({}), ['shell'])).toEqual(['shell']);
  });
});

describe('AdbConnection.open', () => {
  it('only the state device counts (fact A7)', async () => {
    const fake = fakeAdb({ devices: 'List of devices attached\nabc\tdevice\n' });
    const conn = new AdbConnection(profile({ serial: 'abc' }) as never, log, { runner: fake.runner });
    await expect(conn.open()).resolves.toBeUndefined();
  });

  it('when the device is offline it reports an error and carries the original state (the cure for the operations black hole)', async () => {
    const fake = fakeAdb({ devices: 'List of devices attached\nabc\toffline\n' });
    const conn = new AdbConnection(profile({ serial: 'abc' }) as never, log, { runner: fake.runner });
    await expect(conn.open()).rejects.toThrow(/offline/);
  });

  it('when the profile pins a serial only that board counts: another board in the device state does not', async () => {
    // abc is offline, xyz is fine — the old criterion of "any device at all" would
// let it pass,
    // and then every command fails on `adb -s abc`, with the point of failure a
// long way from the cause
    const fake = fakeAdb({ devices: 'List of devices attached\nabc\toffline\nxyz\tdevice\n' });
    const conn = new AdbConnection(profile({ serial: 'abc' }) as never, log, { runner: fake.runner });

    const err = await openError(conn);
    expect(err.code).toBe('CONN_OPEN_FAILED');
    expect(err.message).toContain('abc');
    expect(err.message).toContain('offline');
  });

  it('when the serial of the profile is not in adb devices it reports an error and names the serial', async () => {
    const fake = fakeAdb({ devices: 'List of devices attached\nxyz\tdevice\n' });
    const conn = new AdbConnection(profile({ serial: 'abc' }) as never, log, { runner: fake.runner });

    const err = await openError(conn);
    expect(err.code).toBe('CONN_OPEN_FAILED');
    expect(err.message).toContain('abc');
    expect(err.message).toContain('not in the adb devices list');   // says that it is not in the adb devices list
    // xyz being a device does not help either: the profile pins abc, which is not
// in the list at all
    const present = (err.detail as { present?: string[] }).present ?? [];
    expect(present).toEqual(['xyz']);
  });

  it('unauthorized is a failure as well: a board that was not authorised cannot count as connected', async () => {
    const fake = fakeAdb({ devices: 'List of devices attached\nabc\tunauthorized\n' });
    const conn = new AdbConnection(profile({ serial: 'abc' }) as never, log, { runner: fake.runner });

    const err = await openError(conn);
    expect(err.code).toBe('CONN_OPEN_FAILED');
    expect(err.message).toContain('abc');
    expect(err.message).toContain('unauthorized');
  });

  it('with no permissions it carries the original state as it is (the cure for the operations black hole)', async () => {
    const fake = fakeAdb({
      devices: 'List of devices attached\nabc\tno permissions (user in plugdev group); see [http://x]\n',
    });
    const conn = new AdbConnection(profile({ serial: 'abc' }) as never, log, { runner: fake.runner });

    const err = await openError(conn);
    expect(err.message).toContain('no permissions');
  });

  it('the noise of the starting daemon is not a device line and does not enter the states', async () => {
    const fake = fakeAdb({
      devices: [
        '* daemon not running; starting now at tcp:5037',
        '* daemon started successfully',
        'List of devices attached',
        'xyz\toffline',
      ].join('\n'),
    });
    // No pinned serial: it takes the old route of "any device at all"
    const conn = new AdbConnection(profile({}) as never, log, { runner: fake.runner });

    const err = await openError(conn);
    expect(err.code).toBe('CONN_OPEN_FAILED');
    expect(err.message).not.toContain('daemon');
    expect(err.message).not.toContain('tcp:5037');
    const states = (err.detail as { states?: string[] }).states ?? [];
    expect(states).toEqual(['offline']);
  });

  it('the noise of the daemon does not leak into the error message of the "given serial" branch either', async () => {
    const fake = fakeAdb({
      devices: [
        '* daemon not running; starting now at tcp:5037',
        'List of devices attached',
        'abc\toffline',
      ].join('\n'),
    });
    const conn = new AdbConnection(profile({ serial: 'abc' }) as never, log, { runner: fake.runner });

    const err = await openError(conn);
    expect(err.message).not.toContain('daemon');
    expect(err.message).toContain('abc');
    expect(err.message).toContain('offline');
  });

  it('without a pinned serial the old behaviour is kept: one board in the device state is enough to open', async () => {
    const fake = fakeAdb({ devices: 'List of devices attached\nxyz\tdevice\nabc\toffline\n' });
    const conn = new AdbConnection(profile({}) as never, log, { runner: fake.runner });
    await expect(conn.open()).resolves.toBeUndefined();
  });
});

describe('AdbConnection.list', () => {
  const LS_OUT = [
    'total 24',
    'drwxr-xr-x 2 root root  4096 Nov 12 09:30 sub',
    '-rw-r--r-- 1 root root   123 Nov 12 09:31 a.txt',
    'drwxr-xr-x 1 root root  4096 Nov 11 22:00 ..',
    'drwxr-xr-x 1 root root  4096 Nov 11 22:00 .',
  ].join('\n');

  const opened = async (fake: ReturnType<typeof fakeAdb>): Promise<AdbConnection> => {
    const conn = new AdbConnection(profile({ serial: 'abc' }) as never, log, { runner: fake.runner });
    await conn.open();
    return conn;
  };

  it('it runs adb shell ls -la: the command holds ls -la and the quoted path', async () => {
    const fake = fakeAdb({ devices: 'List of devices attached\nabc\tdevice\n', ls: LS_OUT });
    const conn = await opened(fake);

    await conn.list('/root');

    const shell = fake.calls.find((c) => c.args.includes('shell'));
    expect(shell).toBeDefined();
    expect(shell!.args.at(-1)).toContain('ls -la');
    expect(shell!.args.at(-1)).toContain("'/root'");
  });

  it('the parsed entries are right: the name, the path, the directory marker, the size, the time', async () => {
    const fake = fakeAdb({ devices: 'List of devices attached\nabc\tdevice\n', ls: LS_OUT });
    const conn = await opened(fake);

    const entries = await conn.list('/root');

    // . and .. do not enter the result
    expect(entries.map((e) => e.name)).toEqual(['sub', 'a.txt']);
    expect(entries[0].path).toBe('/root/sub');
    expect(entries[0].isDirectory).toBe(true);
    expect(entries[1].path).toBe('/root/a.txt');
    expect(entries[1].isDirectory).toBe(false);
    expect(entries[1].sizeBytes).toBe(123);
    expect(entries[0].modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('the sizeBytes of a directory is null (a thing that cannot be read is not 0 — fact G2)', async () => {
    const fake = fakeAdb({ devices: 'List of devices attached\nabc\tdevice\n', ls: LS_OUT });
    const conn = await opened(fake);

    const entries = await conn.list('/root');

    const dir = entries.find((e) => e.name === 'sub');
    expect(dir?.isDirectory).toBe(true);
    expect(dir?.sizeBytes).toBeNull();
    expect(dir?.sizeBytes).not.toBe(0);
  });

  it('a path with spaces and single quotes is quoted as well (a path spliced in as it is would break the command)', async () => {
    const fake = fakeAdb({ devices: 'List of devices attached\nabc\tdevice\n' });
    const conn = await opened(fake);

    await conn.list("/root/my dir's");

    const shell = fake.calls.find((c) => c.args.includes('shell'));
    expect(shell!.args.at(-1)).toContain("'/root/my dir'\\''s'");
  });

  it('when ls exits with a non-zero code it throws FILE_TRANSFER_FAILED and carries the remotePath and the stderr', async () => {
    const fake = fakeAdb({
      devices: 'List of devices attached\nabc\tdevice\n',
      lsExitCode: 1,
      lsStderr: 'ls: /root: No such file or directory',
    });
    const conn = await opened(fake);

    const err = await conn.list('/root').then(() => undefined, (e: unknown) => e as {
      code: string; message: string; detail?: { remotePath?: string; stderr?: string };
    });

    expect(err?.code).toBe('FILE_TRANSFER_FAILED');
    expect(err?.message).toContain('/root');
    expect(err?.detail?.remotePath).toBe('/root');
    expect(err?.detail?.stderr).toContain('No such file');
  });
});

describe('broken bytes (RF-3)', () => {
  it('when the output of the board contains half a UTF-8 character it throws no exception and loses not the whole command', async () => {
    const { runProcess } = await import('../../src/main/util/spawn');
    const r = await runProcess(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0xff, 0xfe]))']);
    expect(r.stdout.length).toBeGreaterThan(0);   // The replacement character, not an empty string
  });
});

describe('the stream errors of the long-lived ADB shell', () => {
  it('the error of stdin has to be caught — otherwise an EPIPE takes the main process down', async () => {
    // Writing to a pipe that is already closed yields EPIPE/ECONNRESET,
    // and the 'error' event of a stream **without a listener becomes an uncaught
// exception** —
    // not the terminal window going down, **the whole Electron main process goes
// down**.
    //
    // The path is realistic: after the check of `adb devices` passed, the board
// drops off or the serial does not match,
    // and the line in the constructor that writes the session environment script
// lands on a pipe that is about to die.
    //
    // The serial line has `port.on('error')`, the SSH line has `client.on('error')`,
    // only the stdin of ADB is bare (found in the third audit).
    const stdin = new EventEmitter() as EventEmitter & {
      write: (d: string) => void;
      end: () => void;
    };
    stdin.write = () => undefined;
    stdin.end = () => undefined;

    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: typeof stdin;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = stdin;
    child.kill = () => undefined;

    const conn = new AdbConnection(
      { id: 'a', label: 'a', transport: 'adb', options: { serial: 'xyz' } },
      { write: () => {}, close: () => {}, filePath: 'x' } as never,
      {
        runner: (async () => ({
          exitCode: 0,
          stdout: 'List of devices attached\nxyz\tdevice\n',
          stderr: '',
          durationMs: 0,
          timedOut: false,
        })) as never,
        spawn: (() => child) as never,
      },
    );
    await conn.open();
    await conn.openSession();

    // With a listener → it is only recorded, it does not become an uncaught
// exception
    expect(stdin.listenerCount('error')).toBeGreaterThan(0);
    expect(() => stdin.emit('error', new Error('EPIPE'))).not.toThrow();
  });
});

describe('the environment script an ADB session injects', () => {
  it('the script may not contain a CR — a lonely CR is taken for a command by the remote shell', async () => {
    // **Measured on the board** (2026-11-13, the shell of the board is bash, not
// busybox):
    //
    // ```
    // root@ATK-DLRK3588/bin/bash: line 3: $'\r': command not found
    // ```
    //
    // The cause: the script itself ends with `\n`, and the injection added a
// `\r\n` on top,
    // so that lonely CR became an empty command.
    //
    // This assertion guards the **exact bytes that were written** —
    // asserting only that the content of the script is right would not catch this
// bug.
    const stdinWrites: string[] = [];
    const stdin = new EventEmitter() as EventEmitter & {
      write: (d: string) => void;
      end: () => void;
    };
    stdin.write = (d: string) => { stdinWrites.push(d); };
    stdin.end = () => undefined;

    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: typeof stdin;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = stdin;
    child.kill = () => undefined;

    const conn = new AdbConnection(
      { id: 'a', label: 'a', transport: 'adb', options: { serial: 'xyz' } },
      { write: () => {}, close: () => {}, filePath: 'x' } as never,
      {
        runner: (async () => ({
          exitCode: 0,
          stdout: 'List of devices attached\nxyz\tdevice\n',
          stderr: '',
          durationMs: 0,
          timedOut: false,
        })) as never,
        spawn: (() => child) as never,
      },
    );
    await conn.open();
    await conn.openSession();

    expect(stdinWrites.length).toBeGreaterThan(0);
    const script = stdinWrites[0];
    // It exports TERM and defines a shell function for ls
    expect(script).toContain('export TERM=xterm-256color');
    expect(script).toContain('ls() {');
    // **Not a single CR may be there**
    expect(script).not.toContain('\r');
    // The line endings are LF
    expect(script.endsWith('\n')).toBe(true);
  });
});
