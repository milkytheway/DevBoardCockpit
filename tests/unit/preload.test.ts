import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * preload 的白名单 API。
 *
 * **这里守的是 R-03**：错误对象跨 IPC 边界退化。
 *
 * Electron 的 `ipcRenderer.invoke` 在主进程抛错时会把错误包成
 * `Error invoking remote method 'x': <原错误>`。
 * 原错误若是普通对象，`String(error)` 就是 `[object Object]`——
 * 用户看到的是 `[object Object]`，而「串口 COM3 被占用」到不了眼前。
 *
 * 所以主进程**不抛**，返回 `{ok:false, error:{code,message,…}}`；
 * preload 在这里还原成**带错误码的异常**再抛出去。
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
  // Electron 32 起 `File.path` 已被移除，受支持的取法是这个
  webUtils: {
    getPathForFile: (file: File) => `C:\\Users\\me\\${file.name}`,
  },
}));

import { api } from '../../src/preload/index';
import { AppError } from '../../src/shared/errors';

describe('preload 的错误处理', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.send.mockReset();
  });

  it('主进程报失败时，抛出去的是带错误码的异常，消息一字不改', async () => {
    mocks.invoke.mockResolvedValue({
      ok: false,
      error: { code: 'PORT_BUSY', message: '串口 COM3 被占用', retryable: false },
    });

    await expect(api.terminalOpen('board-serial')).rejects.toThrow('串口 COM3 被占用');
    await expect(api.terminalOpen('board-serial')).rejects.toMatchObject({
      code: 'PORT_BUSY',
    });
  });

  it('抛出去的东西是 Error 实例 —— 跨 IPC 不会退化成 [object Object]', async () => {
    mocks.invoke.mockResolvedValue({
      ok: false,
      error: { code: 'PORT_BUSY', message: '串口 COM3 被占用', retryable: false },
    });

    const err = await api.terminalOpen('board-serial').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toContain('串口 COM3 被占用');
    expect(String(err)).not.toContain('[object Object]');
  });

  it('成功时把值原样交出去', async () => {
    mocks.invoke.mockResolvedValue({ ok: true, value: { sessionId: 's1' } });
    await expect(api.terminalOpen('p')).resolves.toEqual({ sessionId: 's1' });
  });

  it('文件互传的失败同样带着错误码与消息', async () => {
    mocks.invoke.mockResolvedValue({
      ok: false,
      error: { code: 'FILE_TRANSFER_FAILED', message: '下载失败：/root/a.txt', retryable: true },
    });

    const err = await api.filesPull('c', '/root/a.txt', '').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('FILE_TRANSFER_FAILED');
    expect((err as AppError).retryable).toBe(true);
  });

  it('getPathForFile 拿到的是宿主的绝对路径', () => {
    // 这个项目在 node 侧编译，`File` 解析成 Node 的 buffer.File，
    // 而 preload 的签名用的是 DOM 的 File——所以这里按签名造一个。
    type HostFile = Parameters<typeof api.getPathForFile>[0];
    const file = { name: 'build.log' } as unknown as HostFile;
    expect(api.getPathForFile(file)).toBe('C:\\Users\\me\\build.log');
  });

  it('白名单被挂到 window.cockpit 上', () => {
    expect(Object.keys(mocks.exposed)).toContain('terminalOpen');
    expect(Object.keys(mocks.exposed)).toContain('getPathForFile');
  });
});
