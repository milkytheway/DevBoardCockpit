/**
 * main 与 renderer 之间的全部 IPC 通道。
 *
 * 通道名集中在这里，main 与 preload 共用同一份定义——
 * 拼错通道名在编译期就会报错，而不是运行时静默失败。
 */

export const IPC = {
  terminalOpen: 'terminal:open',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalClose: 'terminal:close',
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/**
 * 卡片与 renderer 能碰到的宿主能力。
 *
 * 新增方法时**同时**在上面的 `IPC` 里登记通道名。
 */
export interface CockpitApi {
  terminalOpen(profileId: string): Promise<{ sessionId: string }>;
  terminalWrite(sessionId: string, data: string): void;
  terminalResize(sessionId: string, cols: number, rows: number): void;
  terminalClose(sessionId: string): void;
  onTerminalData(cb: (sessionId: string, chunk: string) => void): () => void;
  onTerminalExit(cb: (sessionId: string, exitCode: number | null) => void): () => void;
}
