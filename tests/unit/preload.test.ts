import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The whitelist API of the preload.
 *
 * **What is guarded here is R-03**: an error object degrades across the
 * boundary of the IPC.
 *
 * The `ipcRenderer.invoke` of Electron wraps an error thrown in the main
 * process into `Error invoking remote method 'x': <the original error>`. If
 * the original error is a plain object, `String(error)` is
 * `[object Object]` — the operator sees `[object Object]` and "the serial
 * port COM3 is busy" never reaches their eyes.
 *
 * Therefore the main process **does not throw**, it returns
 * `{ok:false, error:{code,message,…}}`, and the preload restores it into
 * **an exception that carries the error code** and throws that.
 */
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  send: vi.fn(),
  exposed: {} as Record<string, unknown>,
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, api: unknown) => {
      mocks.exposed = api as Record<string, unknown>;
    },
  },
  ipcRenderer: {
    invoke: mocks.invoke,
    send: mocks.send,
    on: vi.fn(),
    off: vi.fn(),
  },
  // Since Electron 32 `File.path` was removed, the supported way to get it is this
  webUtils: {
    getPathForFile: (file: File) => `C:\\Users\\me\\${file.name}`,
  },
}));

import { api } from '../../src/preload/index';
import { AppError } from '../../src/shared/errors';

describe('the error handling of the preload', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.send.mockReset();
  });

  it('when the main process reports a failure, what is thrown is an exception that carries the error code, and the message is not changed by a character', async () => {
    mocks.invoke.mockResolvedValue({
      ok: false,
      error: { code: 'PORT_BUSY', message: 'the serial port COM3 is busy', retryable: false },
    });

    await expect(api.terminalOpen('board-serial')).rejects.toThrow('the serial port COM3 is busy');
    await expect(api.terminalOpen('board-serial')).rejects.toMatchObject({
      code: 'PORT_BUSY',
    });
  });

  it('what is thrown is an instance of Error — it does not degrade to [object Object] across the IPC', async () => {
    mocks.invoke.mockResolvedValue({
      ok: false,
      error: { code: 'PORT_BUSY', message: 'the serial port COM3 is busy', retryable: false },
    });

    const err = await api.terminalOpen('board-serial').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toContain('the serial port COM3 is busy');
    expect(String(err)).not.toContain('[object Object]');
  });

  it('on success the value is handed over as it is', async () => {
    mocks.invoke.mockResolvedValue({ ok: true, value: { sessionId: 's1' } });
    await expect(api.terminalOpen('p')).resolves.toEqual({ sessionId: 's1' });
  });

  it('a failed file transfer carries the error code and the message as well', async () => {
    mocks.invoke.mockResolvedValue({
      ok: false,
      error: { code: 'FILE_TRANSFER_FAILED', message: 'the download failed: /root/a.txt', retryable: true },
    });

    const err = await api.filesPull('c', '/root/a.txt', '').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('FILE_TRANSFER_FAILED');
    expect((err as AppError).retryable).toBe(true);
  });

  it('getPathForFile gives the absolute path of the host', () => {
    // This project is compiled on the node side, where `File` resolves to the buffer.File of Node,
    // while the signature of the preload uses the DOM File — so one is built here according to the signature.
    type HostFile = Parameters<typeof api.getPathForFile>[0];
    const file = { name: 'build.log' } as unknown as HostFile;
    expect(api.getPathForFile(file)).toBe('C:\\Users\\me\\build.log');
  });

  it('the whitelist is hung on window.cockpit', () => {
    expect(Object.keys(mocks.exposed)).toContain('terminalOpen');
    expect(Object.keys(mocks.exposed)).toContain('getPathForFile');
  });
});
