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
      shell(cb: (err: Error | undefined, ch: unknown) => void) {
        cb(undefined, fakeChannel);
        return this;
      },
    };

    const conn = new SshConnection(
      { id: 's', label: 's', transport: 'ssh', options: { host: 'h', port: 22 } },
      { write: () => {}, close: () => {}, filePath: 'x' } as never,
      { clientFactory: () => fakeClient as never },
    );

    await conn.open();
    const session = conn.openSession();

    session.write('ls\r');
    session.resize(80, 24);

    expect(fakeChannel.write).toHaveBeenCalledWith('ls\r');
    expect(fakeChannel.setWindow).toHaveBeenCalledWith(24, 80, 0, 0);
  });
});
