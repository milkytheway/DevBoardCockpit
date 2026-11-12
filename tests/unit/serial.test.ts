import { describe, it, expect, vi } from 'vitest';
import { serialCapabilities, SerialConnection, type SerialPortFactory } from '../../src/main/hal/serial';

const profile = {
  id: 's', label: 's', transport: 'serial' as const,
  options: { port: 'COM3', baudrate: 1500000 },
};
const log = { write: vi.fn(), close: vi.fn(), filePath: 'x' };

describe('serialCapabilities', () => {
  it('串口不能传文件、没有退出码、没有 pty（事实 S5/S7）', () => {
    expect(serialCapabilities()).toEqual({ exec: true, pty: false, files: false, exitCode: false });
  });
});

describe('SerialConnection.exec', () => {
  it('认领 marker 之间的输出并返回退出码 0（串口无退出码，有文本即 0）', async () => {
    // 假串口：像真板子一样**回显**收到的 marker，再回一段输出。
    // 事实 S2：板子会回显命令，所以 marker 在 transcript 里出现两次
    // （回显行一次、输出之后一次）——取两次之间的内容。
    const factory: SerialPortFactory = () => {
      let cb: ((chunk: string) => void) | undefined;
      return {
        write: (data: string) => {
          const marker = /^(__DBC\d+_\d+__)/.exec(data)?.[1] ?? '';
          cb?.(`${marker}\r\nhi\r\n${marker}\r\n`);
        },
        onData: (handler) => {
          cb = handler;
        },
        close: () => {},
      };
    };
    const conn = new SerialConnection(profile, log as never, factory);
    await conn.open();
    const res = await conn.exec('uptime');
    expect(res.stdout.trim()).toBe('hi');   // 不含 marker
    expect(res.exitCode).toBe(0);           // 有文本回包 = 0
  });

  it('端口被占用时报 PORT_BUSY 并指出是哪个端口（RF-5）', async () => {
    const factory: SerialPortFactory = () => {
      throw Object.assign(new Error('Resource busy'), { code: 'EBUSY' });
    };
    const conn = new SerialConnection(profile, log as never, factory);
    await expect(conn.open()).rejects.toThrow(/COM3/);
    await expect(conn.open()).rejects.toMatchObject({ code: 'PORT_BUSY' });
  });
});
