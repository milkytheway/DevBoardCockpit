import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { IPC, type CockpitApi, type IpcChannel, type IpcResult } from '../shared/ipc-contract';
import { appErrorToException } from '../shared/errors';
import type { TagReading } from '../shared/tag-reading';

/**
 * The only exit to the host capabilities.
 *
 * renderer 与卡片都只能经这里触达 main——
 * 没有 `ipcRenderer` 本身，没有 fs，没有 child_process（AGENTS.md §3）。
 *
 * **这里做两件主进程不做的事**：
 *
 * 1. **把结构化结果拆包**：主进程返回 `{ok:true,value}` 或 `{ok:false,error}`，
 *    这里把失败还原成**带错误码的异常**抛出去。
 *    不这么做的话，Electron 会把主进程的错误包成
 *    `Error invoking remote method 'x': [object Object]`——
 *    用户看到的是 `[object Object]`，「串口 COM3 被占用」到不了眼前。
 * 2. **代理 `webUtils.getPathForFile`**：Electron 32 起 `File.path` 已被移除，
 *    而 `webUtils` 只能在渲染进程/preload 里调。
 */
async function invoke<T>(channel: IpcChannel, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>;
  if (!result.ok) throw appErrorToException(result.error);
  return result.value;
}

export const api: CockpitApi = {
  terminalOpen: (profileId) => invoke(IPC.terminalOpen, profileId),
  terminalWrite: (sessionId, data) => ipcRenderer.send(IPC.terminalWrite, sessionId, data),
  terminalResize: (sessionId, cols, rows) => ipcRenderer.send(IPC.terminalResize, sessionId, cols, rows),
  terminalClose: (sessionId) => invoke(IPC.terminalClose, sessionId),
  onTerminalData: (cb) => {
    const handler = (_e: IpcRendererEvent, sessionId: string, chunk: string): void => cb(sessionId, chunk);
    ipcRenderer.on(IPC.terminalData, handler);
    return () => ipcRenderer.off(IPC.terminalData, handler);
  },
  onTerminalExit: (cb) => {
    const handler = (_e: IpcRendererEvent, sessionId: string, exitCode: number | null): void =>
      cb(sessionId, exitCode);
    ipcRenderer.on(IPC.terminalExit, handler);
    return () => ipcRenderer.off(IPC.terminalExit, handler);
  },
  filesList: (connectionId, remotePath) => invoke(IPC.filesList, connectionId, remotePath),
  filesPush: (connectionId, localPath, remotePath) =>
    invoke(IPC.filesPush, connectionId, localPath, remotePath),
  filesPull: (connectionId, remotePath, localPath) =>
    invoke(IPC.filesPull, connectionId, remotePath, localPath),
  connectionsList: () => invoke(IPC.connectionsList),
  devicesSelect: (deviceKey) => invoke(IPC.devicesSelect, deviceKey),
  tagsReadings: () => invoke(IPC.tagsReadings),
  tagsStatus: () => invoke(IPC.tagsStatus),
  cardsList: () => invoke(IPC.cardsList),
  cardsHello: (instanceId) => invoke(IPC.cardsHello, instanceId),
  cardsRequest: (req) => invoke(IPC.cardsRequest, req),
  cardsCsp: (instanceId, detail) => invoke(IPC.cardsCsp, instanceId, detail),
  layoutGet: () => invoke(IPC.layoutGet),
  layoutSet: (state) => invoke(IPC.layoutSet, state),
  setTheme: (theme) => invoke(IPC.themeSet, theme),
  workflowsRecent: () => invoke(IPC.workflowsRecent),
  workflowsCancel: (runId: string) => invoke(IPC.workflowsCancel, runId),
  // **The board setup wizard** ✓ — **host only** ✓ (neither the cards nor an agent get it ✓)
  wizardRun: (input) => invoke(IPC.wizardRun, input),
  permissionsList: () => invoke(IPC.permissionsList),
  permissionsSet: (actor, op, allowed) => invoke(IPC.permissionsSet, actor, op, allowed),
  onCardEvent: (cb) => {
    const handler = (_e: IpcRendererEvent, instanceId: string, payload: unknown): void =>
      cb(instanceId, payload);
    ipcRenderer.on(IPC.cardsEvent, handler);
    return () => ipcRenderer.off(IPC.cardsEvent, handler);
  },
  onCardsChanged: (cb) => {
    const handler = (): void => cb();
    ipcRenderer.on(IPC.cardsChanged, handler);
    return () => ipcRenderer.off(IPC.cardsChanged, handler);
  },
  onTagChanged: (cb) => {
    const handler = (_e: IpcRendererEvent, reading: TagReading): void => cb(reading);
    ipcRenderer.on(IPC.tagsChanged, handler);
    return () => ipcRenderer.off(IPC.tagsChanged, handler);
  },
  getPathForFile: (file) => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld('cockpit', api);
