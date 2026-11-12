import { describe, it, expect } from 'vitest';
import { adbCapabilities, adbArgs, AdbConnection } from '../../src/main/hal/adb';

const profile = (opts: Record<string, unknown>) => ({
  id: 'a', label: 'a', transport: 'adb' as const, options: opts,
});

describe('adbCapabilities', () => {
  it('不用 PTY（事实 A1），但能传文件、能拿退出码', () => {
    expect(adbCapabilities()).toEqual({ exec: true, pty: false, files: true, exitCode: true });
  });
});

describe('adbArgs', () => {
  it('有序列号时前置 -s <serial>', () => {
    expect(adbArgs(profile({ serial: 'f34dca7784396ab2' }), ['shell']))
      .toEqual(['-s', 'f34dca7784396ab2', 'shell']);
  });

  it('没有序列号时不带 -s', () => {
    expect(adbArgs(profile({}), ['shell'])).toEqual(['shell']);
  });
});

describe('AdbConnection.open', () => {
  const fakeRunner = (stdout: string) => async () => ({
    exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false,
  });

  it('只认 device 状态（事实 A7）', async () => {
    const conn = new AdbConnection(
      profile({ serial: 'abc' }) as never,
      { write: () => {}, close: () => {}, filePath: 'x' } as never,
      { runner: fakeRunner('List of devices attached\nabc\tdevice\n') as never },
    );
    await expect(conn.open()).resolves.toBeUndefined();
  });

  it('设备处于 offline 时报错并带出原始状态（运维黑洞的解药）', async () => {
    const conn = new AdbConnection(
      profile({ serial: 'abc' }) as never,
      { write: () => {}, close: () => {}, filePath: 'x' } as never,
      { runner: fakeRunner('List of devices attached\nabc\toffline\n') as never },
    );
    await expect(conn.open()).rejects.toThrow(/offline/);
  });
});

describe('坏字节（RF-3）', () => {
  it('板端输出含半个 UTF-8 字符时不抛异常、不丢整条命令', async () => {
    const { runProcess } = await import('../../src/main/util/spawn');
    const r = await runProcess(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0xff, 0xfe]))']);
    expect(r.stdout.length).toBeGreaterThan(0);   // 替换符，不是空串
  });
});
