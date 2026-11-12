import { describe, it, expect, vi } from 'vitest';

/**
 * 真实工厂的行为。
 *
 * 整支评审的 C1：串口端口从未打开（`autoOpen:false` 且从不 `open()`），
 * 用户第一次按键就崩主进程。修完之后**没有测试守着**——
 * 因为所有测试都用注入的假工厂，真实工厂的「开端口」那一步从没被覆盖。
 * 把 `await port.open()` 删掉，整个套件仍然全绿。
 *
 * 这个测试锁住那一步。
 */
describe('真实串口工厂', () => {
  it('打开端口：调用 serialport 的 open()', async () => {
    const open = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);

    // mock serialport 模块
    vi.doMock('serialport', () => ({
      SerialPort: class {
        isOpen = true;
        constructor(public opts: { path: string; baudRate: number }) {}
        async open() { await open(); }
        async close(cb?: () => void) { await close(); cb?.(); }
        write() {}
        on() {}
      },
    }));

    vi.resetModules();
    const mod = await import('../../src/main/hal/serial');
    const factory = mod.realPortFactory;

    const port = await factory({ path: 'COM3', baudRate: 1500000 });
    expect(port).toBeDefined();
    expect(open).toHaveBeenCalledTimes(1);
    await port.close();
    expect(close).toHaveBeenCalledTimes(1);

    vi.doUnmock('serialport');
    vi.resetModules();
  });

  it('打开失败时错误冒出去（不吞）', async () => {
    vi.doMock('serialport', () => ({
      SerialPort: class {
        isOpen = false;
        constructor(public opts: { path: string; baudRate: number }) {}
        async open() { throw Object.assign(new Error('Resource busy'), { code: 'EBUSY' }); }
        async close(cb?: () => void) { cb?.(); }
        write() {}
        on() {}
      },
    }));

    vi.resetModules();
    const mod = await import('../../src/main/hal/serial');

    await expect(mod.realPortFactory({ path: 'COM3', baudRate: 115200 }))
      .rejects.toMatchObject({ code: 'EBUSY' });

    vi.doUnmock('serialport');
    vi.resetModules();
  });
});
