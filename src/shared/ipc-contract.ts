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
  filesList: 'files:list',
  filesPush: 'files:push',
  filesPull: 'files:pull',
  connectionsList: 'connections:list',
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
  filesList(connectionId: string, remotePath: string): Promise<FileEntry[]>;
  filesPush(connectionId: string, localPath: string, remotePath: string): Promise<void>;
  filesPull(connectionId: string, remotePath: string, localPath: string): Promise<void>;
  connectionsList(): Promise<ConnectionInfo[]>;
}

/** 一个可用的连接：profile 的摘要 + 它的能力位 */
export interface ConnectionInfo {
  id: string;
  label: string;
  transport: 'serial' | 'adb' | 'ssh' | 'local';
  boardPack: string | null;
  capabilities: Capabilities;
}

/**
 * 能力位。**UI 依能力降级**，不依传输名。
 *
 * 定义放在 shared 而不是 main/hal——renderer 要用它来决定
 * 「文件浏览器入口要不要禁用」，但 renderer 不能 import main（分层规则：
 * renderer → preload → main）。
 */
export interface Capabilities {
  /** 能跑一条命令拿结果 */
  exec: boolean;
  /** 能开交互式终端（真 pty，有回显与 ANSI） */
  pty: boolean;
  /** 能做文件传输 */
  files: boolean;
  /** exec 能否拿到退出码。串口为 false（事实 S5） */
  exitCode: boolean;
}

/** 远端目录里的一个条目 */
export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  sizeBytes: number | null;
  modifiedAt: string | null;
}
