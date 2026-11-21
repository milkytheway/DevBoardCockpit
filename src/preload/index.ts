import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { IPC, type CockpitApi, type IpcChannel, type IpcResult } from '../shared/ipc-contract';
import { appErrorToException } from '../shared/errors';
import type { TagReading } from '../shared/tag-reading';

/**
 * The only exit to the host capabilities.
 *
 * The renderer and the cards can only reach the main process through here —
 * no `ipcRenderer` itself, no fs, no child_process (AGENTS.md §3).
 *
 * **Two things happen here that the main process does not do**:
 *
 * 1. **Unpacking the structured result**: the main process returns
 *    `{ok:true,value}` or `{ok:false,error}`; here the failure is turned back
 *    into an **exception that carries the error code** and thrown.
 *    Without this, Electron wraps a main-process error into
 *    `Error invoking remote method 'x': [object Object]` —
 *    the user sees `[object Object]`, and "the serial port COM3 is busy" never
 *    reaches the screen.
 * 2. **Proxying `webUtils.getPathForFile`**: since Electron 32 `File.path` is
 *    gone, and `webUtils` can only be called in the renderer / preload.
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
  // → **The host picks the link** ✓ (ADB → SSH → serial ✓) → the file page
  //   does not need an open terminal ✓.
  filesEndpoint: () => invoke(IPC.filesEndpoint),
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
  boardDetect: () => invoke(IPC.boardDetect),
  boardApply: (values) => invoke(IPC.boardApply, values),
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
