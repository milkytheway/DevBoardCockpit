import { describe, it, expect, vi } from 'vitest';
import { serialCapabilities, SerialConnection, type SerialPortFactory } from '../../src/main/hal/serial';

const profile = {
  id: 's', label: 's', transport: 'serial' as const,
  options: { port: 'COM3', baudrate: 1500000 },
};
const log = { write: vi.fn(), close: vi.fn(), filePath: 'x' };

/**
 * 假串口：**像真板子一样回显**它收到的每一行，然后模拟执行。
 *
 * 这是本轮最重要的一个测试基建改动：原来的假串口是「按契约编好的答案」，
 * 把 marker 协议的形状 bug 盖住了。现在它按真实行为建模：
 *   收到 `uptime; echo __DBC..__`
 *   → 回显这一行（marker 第一次出现）
 *   → 输出命令的结果
 *   → 执行 echo（marker 第二次出现）
 */
const fakeBoard = (output = 'hi'): { factory: SerialPortFactory; sent: string[] } => {
  const sent: string[] = [];
  let cb: ((chunk: string) => void) | undefined;
  const factory: SerialPortFactory = async () => ({
    write(data: string) {
      sent.push(data);
      const line = data.replace(/\r\n$/, '');
      const m = /;\s*echo\s+(__DBC\d+_\d+__)\s*$/.exec(line);
      // 回显（第一次出现 marker）
      cb?.(`${line}\r\n`);
      if (!m) return;
      // 命令输出
      cb?.(`${output}\r\n`);
      // echo 的输出（第二次出现 marker）
      cb?.(`${m[1]}\r\n`);
    },
    onData(handler) { cb = handler; },
    onError() { /* no-op */ },
    async close() { /* no-op */ },
  });
  return { factory, sent };
};

describe('serialCapabilities', () => {
  it('串口是控制台：能传文件吗？不能；能拿退出码吗？不能（事实 S5/S7）', () => {
    expect(serialCapabilities()).toEqual({ exec: true, pty: true, files: false, exitCode: false });
  });
});

describe('SerialConnection.exec', () => {
  it('认领 marker 之间的输出并返回退出码 0（串口无退出码，有文本即 0）', async () => {
    const { factory } = fakeBoard(' 12:00:00 up 3 days');
    const conn = new SerialConnection(profile, log as never, factory);
    await conn.open();
    const res = await conn.exec('uptime');
    // 输出是命令的结果，**不是命令文本本身**
    expect(res.stdout.trim()).toBe('12:00:00 up 3 days');
    expect(res.exitCode).toBe(0);
  });

  it('发出的命令与 marker 在同一行（板子回显一次、echo 一次 = marker 出现两次）', async () => {
    const { factory, sent } = fakeBoard();
    const conn = new SerialConnection(profile, log as never, factory);
    await conn.open();
    await conn.exec('uptime');
    expect(sent).toHaveLength(1);
    expect(sent[0].trimEnd()).toMatch(/^uptime; echo __DBC\d+_\d+__$/);
  });

  it('输出里不含 marker（RF-1）', async () => {
    const { factory } = fakeBoard('hello');
    const conn = new SerialConnection(profile, log as never, factory);
    await conn.open();
    const res = await conn.exec('uptime');
    expect(res.stdout).not.toContain('__DBC');
  });

  it('端口被占用时报 PORT_BUSY 并指出是哪个端口（RF-5）', async () => {
    const factory: SerialPortFactory = async () => {
      throw Object.assign(new Error('Resource busy'), { code: 'EBUSY' });
    };
    const conn = new SerialConnection(profile, log as never, factory);
    await expect(conn.open()).rejects.toThrow(/COM3/);
    await expect(conn.open()).rejects.toMatchObject({ code: 'PORT_BUSY' });
  });

  it('同一连接上并发两次 exec 被拒（契约 §1.2.1 往返互斥）', async () => {
    // 假板子不回话 → 第一个 exec 会一直等到超时，占着这条线
    const factory: SerialPortFactory = async () => ({
      write() { /* 什么都不回 */ },
      onData() { /* no-op */ },
      onError() { /* no-op */ },
      async close() { /* no-op */ },
    });
    const conn = new SerialConnection(profile, log as never, factory);
    await conn.open();

    const first = conn.exec('uptime', { timeoutMs: 200 });
    // 第二个命令不能插进来——两个 marker 的回包会在同一份 transcript 里交错，
    // 互相认领对方的输出
    await expect(conn.exec('uname', { timeoutMs: 200 })).rejects.toMatchObject({
      code: 'CONN_TIMEOUT',
    });
    await first;
  });

  it('中文写出去是 UTF-8 字节，不被截断（RF-2）', async () => {
    const { factory, sent } = fakeBoard();
    const conn = new SerialConnection(profile, log as never, factory);
    await conn.open();
    await conn.exec('echo 中文');
    // 写出去的是「命令行 + marker」的 UTF-8 字节
    const bytes = Buffer.from(sent[0], 'utf8');
    expect(bytes.toString('utf8')).toContain('中文');
    // 且不是被截断的半个字符（U+FFFD）
    expect(bytes.toString('utf8')).not.toContain('\uFFFD');
  });

  it('超时时返回 124 且 timedOut 为 true（事实 S5）', async () => {
    // 假板子不回话 → 只能靠超时
    const factory: SerialPortFactory = async () => ({
      write() { /* 什么都不回 */ },
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
