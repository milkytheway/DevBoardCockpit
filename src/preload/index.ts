import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type CockpitApi } from '../shared/ipc-contract';

/**
 * 宿主能力的唯一出口。
 *
 * renderer 与卡片都只能经这里触达 main——
 * 没有 `ipcRenderer` 本身，没有 fs，没有 child_process（AGENTS.md §3）。
 */
const api: CockpitApi = {
  terminalOpen: (profileId) => ipcRenderer.invoke(IPC.terminalOpen, profileId),
  terminalWrite: (sessionId, data) => ipcRenderer.send(IPC.terminalWrite, sessionId, data),
  terminalResize: (sessionId, cols, rows) => ipcRenderer.send(IPC.terminalResize, sessionId, cols, rows),
  terminalClose: (sessionId) => ipcRenderer.send(IPC.terminalClose, sessionId),
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
  filesList: (connectionId, remotePath) => ipcRenderer.invoke(IPC.filesList, connectionId, remotePath),
  filesPush: (connectionId, localPath, remotePath) =>
    ipcRenderer.invoke(IPC.filesPush, connectionId, localPath, remotePath),
  filesPull: (connectionId, remotePath, localPath) =>
    ipcRenderer.invoke(IPC.filesPull, connectionId, remotePath, localPath),
  connectionsList: () => ipcRenderer.invoke(IPC.connectionsList),
};

contextBridge.exposeInMainWorld('cockpit', api);
