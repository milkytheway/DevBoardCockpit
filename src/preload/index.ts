import { contextBridge } from 'electron';

/**
 * 卡片与 renderer 能碰到的宿主能力。
 *
 * v1 只有占位——Task 8 加终端通道，Task 9 加文件通道。
 * 新增方法时**同时**在 `src/shared/ipc-contract.ts` 登记通道名。
 */
const api = {};

contextBridge.exposeInMainWorld('cockpit', api);
