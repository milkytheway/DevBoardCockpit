import { describe, it, expect, vi } from 'vitest';

/**
 * The behaviour of the real factory.
 *
 * The C1 of the whole review: the serial port was never opened
 * (`autoOpen:false` and never an `open()`), so the first key press of the
 * operator took the main process down. After the fix **no test guarded it**,
 * because every test uses an injected fake factory and the step "the real
 * factory opens the port" was never covered. Deleting `await port.open()`
 * left the whole suite green.
 *
 * This test locks that step in.
 */
describe('the real serial factory', () => {
  it('opening the port: it calls the open() of serialport', async () => {
    const open = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);

    // The serialport module is mocked
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

  it('when the open fails the error comes out (it is not swallowed)', async () => {
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
