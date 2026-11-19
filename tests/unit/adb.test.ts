import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { adbCapabilities, adbArgs, AdbConnection } from '../../src/main/hal/adb';
import type { runProcess, SpawnResult } from '../../src/main/util/spawn';

const profile = (opts: Record<string, unknown>) => ({
  id: 'a', label: 'a', transport: 'adb' as const, options: opts,
});

/** 连接日志的替身：adb 的用例只关心命令，不关心日志 */
const log = { write: () => {}, close: () => {}, filePath: 'x' } as never;

/**
 * 假 runner：**按参数分派**，模拟真实 adb 的行为。
 *
 * 为什么不能是「无论什么命令都回同一段 stdout」：
 * `adb devices` 与 `adb shell ls -la` 是两条不同的命令，
 * 真实 adb 对它们的回包完全不同（前者列所有设备与状态，后者回目录内容）。
 * 无视参数的替身会把「到底跑了哪条命令」这类 bug 盖住——
 * 所以这里按命令分派（规矩：替身按行为建模，不按结论建模）。
 *
 * 保持异步：真实 adb 是子进程，回包必然落在后面的事件循环。
 */
function fakeAdb(opts: {
  /** `adb devices` 的 stdout */
  devices?: string;
  /** `adb shell ls -la` 的 stdout */
  ls?: string;
  /** `adb shell ls -la` 的退出码 */
  lsExitCode?: number;
  /** `adb shell ls -la` 的 stderr */
  lsStderr?: string;
} = {}): { runner: typeof runProcess; calls: { command: string; args: string[] }[] } {
  const calls: { command: string; args: string[] }[] = [];
  const runner = async (command: string, args: string[]): Promise<SpawnResult> => {
    calls.push({ command, args });
    // `adb devices`：列**所有**设备（`-s` 也不筛选）
    if (args.includes('devices')) {
      return { exitCode: 0, stdout: opts.devices ?? '', stderr: '', durationMs: 1, timedOut: false };
    }
    // `adb shell <命令>`
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

/** 抓住 open() 的错误：既要错误码，也要消息（`toThrow` 只看得到字符串） */
async function openError(conn: AdbConnection): Promise<{ code: string; message: string; detail?: unknown }> {
  try {
    await conn.open();
  } catch (err) {
    return err as { code: string; message: string; detail?: unknown };
  }
  throw new Error('open() 本该失败，却成功了');
}

describe('adbCapabilities', () => {
  it('不用 PTY（事实 A1），但能传文件、能拿退出码', () => {
    expect(adbCapabilities()).toEqual({ exec: true, pty: false, files: true, exitCode: true });
  });
});

describe('adbArgs', () => {
  it('有序列号时前置 -s <serial>', () => {
    expect(adbArgs(profile({ serial: '0000000000000000' }), ['shell']))
      .toEqual(['-s', '0000000000000000', 'shell']);
  });

  it('没有序列号时不带 -s', () => {
    expect(adbArgs(profile({}), ['shell'])).toEqual(['shell']);
  });
});

describe('AdbConnection.open', () => {
  it('只认 device 状态（事实 A7）', async () => {
    const fake = fakeAdb({ devices: 'List of devices attached\nabc\tdevice\n' });
    const conn = new AdbConnection(profile({ serial: 'abc' }) as never, log, { runner: fake.runner });
    await expect(conn.open()).resolves.toBeUndefined();
  });

  it('设备处于 offline 时报错并带出原始状态（运维黑洞的解药）', async () => {
    const fake = fakeAdb({ devices: 'List of devices attached\nabc\toffline\n' });
    const conn = new AdbConnection(profile({ serial: 'abc' }) as never, log, { runner: fake.runner });
    await expect(conn.open()).rejects.toThrow(/offline/);
  });

  it('profile 钉了 serial 时只认那一块板：别的板子是 device 不算数', async () => {
    // abc 离线、xyz 正常 —— 老的「有没有任意 device」判据会放行，
    // 然后每条命令都在 `adb -s abc` 上失败，失败点离原因十万八千里
    const fake = fakeAdb({ devices: 'List of devices attached\nabc\toffline\nxyz\tdevice\n' });
    const conn = new AdbConnection(profile({ serial: 'abc' }) as never, log, { runner: fake.runner });

    const err = await openError(conn);
    expect(err.code).toBe('CONN_OPEN_FAILED');
    expect(err.message).toContain('abc');
    expect(err.message).toContain('offline');
  });

  it('profile 指定的 serial 在 adb devices 里没有时报错，并说清是哪个序列号', async () => {
    const fake = fakeAdb({ devices: 'List of devices attached\nxyz\tdevice\n' });
    const conn = new AdbConnection(profile({ serial: 'abc' }) as never, log, { runner: fake.runner });

    const err = await openError(conn);
    expect(err.code).toBe('CONN_OPEN_FAILED');
    expect(err.message).toContain('abc');
    expect(err.message).toContain('没有');   // 说清「在 adb devices 里没有」
    // xyz 是 device 也不行：profile 钉的是 abc，它压根不在列表里
    const present = (err.detail as { present?: string[] }).present ?? [];
    expect(present).toEqual(['xyz']);
  });

  it('unauthorized 同样是失败：没授权的板子不能算连上了', async () => {
    const fake = fakeAdb({ devices: 'List of devices attached\nabc\tunauthorized\n' });
    const conn = new AdbConnection(profile({ serial: 'abc' }) as never, log, { runner: fake.runner });

    const err = await openError(conn);
    expect(err.code).toBe('CONN_OPEN_FAILED');
    expect(err.message).toContain('abc');
    expect(err.message).toContain('unauthorized');
  });

  it('no permissions 时把原始状态整段带出来（运维黑洞的解药）', async () => {
    const fake = fakeAdb({
      devices: 'List of devices attached\nabc\tno permissions (user in plugdev group); see [http://x]\n',
    });
    const conn = new AdbConnection(profile({ serial: 'abc' }) as never, log, { runner: fake.runner });

    const err = await openError(conn);
    expect(err.message).toContain('no permissions');
  });

  it('daemon 启动噪声不算设备行，也不进 states', async () => {
    const fake = fakeAdb({
      devices: [
        '* daemon not running; starting now at tcp:5037',
        '* daemon started successfully',
        'List of devices attached',
        'xyz\toffline',
      ].join('\n'),
    });
    // 没钉 serial：走「有没有任意 device」这条老路
    const conn = new AdbConnection(profile({}) as never, log, { runner: fake.runner });

    const err = await openError(conn);
    expect(err.code).toBe('CONN_OPEN_FAILED');
    expect(err.message).not.toContain('daemon');
    expect(err.message).not.toContain('tcp:5037');
    const states = (err.detail as { states?: string[] }).states ?? [];
    expect(states).toEqual(['offline']);
  });

  it('daemon 噪声也不会混进「指定 serial」分支的错误消息', async () => {
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

  it('没钉 serial 时保持老行为：有一块 device 就能开', async () => {
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

  it('走 adb shell ls -la：命令里有 ls -la 和被引号包裹的路径', async () => {
    const fake = fakeAdb({ devices: 'List of devices attached\nabc\tdevice\n', ls: LS_OUT });
    const conn = await opened(fake);

    await conn.list('/root');

    const shell = fake.calls.find((c) => c.args.includes('shell'));
    expect(shell).toBeDefined();
    expect(shell!.args.at(-1)).toContain('ls -la');
    expect(shell!.args.at(-1)).toContain("'/root'");
  });

  it('解析出的条目正确：名字、路径、目录标记、大小、时间', async () => {
    const fake = fakeAdb({ devices: 'List of devices attached\nabc\tdevice\n', ls: LS_OUT });
    const conn = await opened(fake);

    const entries = await conn.list('/root');

    // . 与 .. 不进结果
    expect(entries.map((e) => e.name)).toEqual(['sub', 'a.txt']);
    expect(entries[0].path).toBe('/root/sub');
    expect(entries[0].isDirectory).toBe(true);
    expect(entries[1].path).toBe('/root/a.txt');
    expect(entries[1].isDirectory).toBe(false);
    expect(entries[1].sizeBytes).toBe(123);
    expect(entries[0].modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('目录的 sizeBytes 是 null（读不到的东西不是 0 —— 事实 G2）', async () => {
    const fake = fakeAdb({ devices: 'List of devices attached\nabc\tdevice\n', ls: LS_OUT });
    const conn = await opened(fake);

    const entries = await conn.list('/root');

    const dir = entries.find((e) => e.name === 'sub');
    expect(dir?.isDirectory).toBe(true);
    expect(dir?.sizeBytes).toBeNull();
    expect(dir?.sizeBytes).not.toBe(0);
  });

  it('路径里有空格和单引号时也要包好（路径原样拼进命令会断）', async () => {
    const fake = fakeAdb({ devices: 'List of devices attached\nabc\tdevice\n' });
    const conn = await opened(fake);

    await conn.list("/root/my dir's");

    const shell = fake.calls.find((c) => c.args.includes('shell'));
    expect(shell!.args.at(-1)).toContain("'/root/my dir'\\''s'");
  });

  it('ls 非零退出时抛 FILE_TRANSFER_FAILED，并带上 remotePath 与 stderr', async () => {
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

describe('坏字节（RF-3）', () => {
  it('板端输出含半个 UTF-8 字符时不抛异常、不丢整条命令', async () => {
    const { runProcess } = await import('../../src/main/util/spawn');
    const r = await runProcess(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0xff, 0xfe]))']);
    expect(r.stdout.length).toBeGreaterThan(0);   // 替换符，不是空串
  });
});

describe('ADB 常驻 shell 的流错误', () => {
  it('stdin 的 error 必须有人接 —— 否则 EPIPE 会把主进程带崩', async () => {
    // 往已经关掉的管道写会拿到 EPIPE/ECONNRESET，
    // 而流的 'error' 事件**没有监听器就会变成未捕获异常**——
    // 不是终端窗口挂掉，是**整个 Electron 主进程挂掉**。
    //
    // 触发路径是现实的：`adb devices` 校验通过之后、板子掉线或 serial 不匹配，
    // 构造器里那句写会话环境脚本就打在一条即将死的管道上。
    //
    // 串口那条线有 `port.on('error')`、SSH 那条线有 `client.on('error')`，
    // 唯独 ADB 的 stdin 是裸的（第三轮审计发现）。
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

    // 有监听器 → 只是被记下来，不会变成未捕获异常
    expect(stdin.listenerCount('error')).toBeGreaterThan(0);
    expect(() => stdin.emit('error', new Error('EPIPE'))).not.toThrow();
  });
});

describe('ADB 会话注入的环境脚本', () => {
  it('脚本里不能有 CR —— 落单的 CR 会被远端 shell 当成一条命令', async () => {
    // **真机实测**（2026-11-13，板子的 shell 是 bash 不是 busybox）：
    //
    // ```
    // root@ATK-DLRK3588/bin/bash: line 3: $'\r': command not found
    // ```
    //
    // 根因：脚本本身以 `\n` 结尾，注入时又补了一个 `\r\n`，
    // 那个落单的 CR 就成了一条空命令。
    //
    // 这条断言守的是**写出去的确切字节**——
    // 只断言「脚本内容对」是抓不到这个 bug 的。
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
    // 有 TERM 导出与 ls 的 shell 函数
    expect(script).toContain('export TERM=xterm-256color');
    expect(script).toContain('ls() {');
    // **一个 CR 都不能有**
    expect(script).not.toContain('\r');
    // 行尾是 LF
    expect(script.endsWith('\n')).toBe(true);
  });
});
