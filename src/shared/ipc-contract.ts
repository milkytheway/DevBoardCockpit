/**
 * main 与 renderer 之间的全部 IPC 通道。
 *
 * 通道名集中在这里，main 与 preload 共用同一份定义——
 * 拼错通道名在编译期就会报错，而不是运行时静默失败。
 */

import type { AppErrorPayload } from './errors';
import type { TagReading } from './tag-reading';

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
  /**
   * tag 读数的**当前快照**。
   *
   * **为什么要有「取快照」而不只是「听推送」**：
   * 晚订阅的窗口会漏掉之前的推送——**它打开时看到的应该是现在的数**，
   * 而不是一片空白（契约 §2.1：读数有五态、有 seq，本来就是「当前状态」）。
   */
  tagsReadings: 'tags:readings',
  /** tag 读数**变化**的推送 */
  tagsChanged: 'tags:changed',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/**
 * 每个 invoke 通道的返回值。
 *
 * **为什么包一层 `ok`**：主进程抛错时，Electron 会把错误包成
 * `Error invoking remote method 'x': <原错误>`。
 * 原错误如果是普通对象，`String(error)` 就是 `[object Object]`——
 * 用户看到的是 `[object Object]`，而「串口 COM3 被占用」这句话到不了眼前。
 *
 * 所以主进程**不抛**，而是返回 `{ok:false, error:{code,message,…}}`；
 * preload 再还原成带错误码的异常抛给 renderer。
 * 错误码因此能活着过 IPC 边界，renderer 可以按 `code` 分支。
 */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: AppErrorPayload };

/**
 * 卡片与 renderer 能碰到的宿主能力。
 *
 * 新增方法时**同时**在上面的 `IPC` 里登记通道名。
 */
export interface CockpitApi {
  terminalOpen(profileId: string): Promise<{ sessionId: string }>;
  terminalWrite(sessionId: string, data: string): void;
  terminalResize(sessionId: string, cols: number, rows: number): void;
  terminalClose(sessionId: string): Promise<void>;
  onTerminalData(cb: (sessionId: string, chunk: string) => void): () => void;
  onTerminalExit(cb: (sessionId: string, exitCode: number | null) => void): () => void;
  filesList(connectionId: string, remotePath: string): Promise<FileEntry[]>;
  filesPush(connectionId: string, localPath: string, remotePath: string): Promise<{ remotePath: string }>;
  filesPull(connectionId: string, remotePath: string, localPath: string): Promise<{ localPath: string }>;
  connectionsList(): Promise<ConnectionInfo[]>;
  /**
   * 当前全部 tag 读数的快照。
   *
   * **读数只经 TagStore 出**（ADR-D22）——renderer 拿不到别处的副本。
   */
  tagsReadings(): Promise<TagReading[]>;
  /**
   * 听读数的变化。
   *
   * @returns 退订函数。
   */
  onTagChanged(cb: (reading: TagReading) => void): () => void;
  /**
   * 取一个 File 的**宿主绝对路径**。
   *
   * Electron 32 起 `File.path` 已被移除，受支持的做法是
   * `webUtils.getPathForFile(file)`——它只能在渲染进程/preload 里调，
   * 所以由 preload 代理。
   *
   * 传 `file.name`（只有 basename）是不行的：那会让宿主在
   * **自己的 CWD** 里找同名文件——要么失败，要么**传走另一个文件**
   * （数据安全问题）。
   */
  getPathForFile(file: File): string;
}

/** 一个可用的连接：profile 的摘要 + 它的能力位 */
export interface ConnectionInfo {
  id: string;
  label: string;
  transport: TransportKind;
  boardPack: string | null;
  capabilities: ConnectionCapabilities;
}

/** 传输种类。定义在 shared —— main 与 renderer 都要用，不许各抄一份 */
export type TransportKind = 'serial' | 'adb' | 'ssh' | 'local';

/**
 * **连接级能力位**。**UI 依能力降级**，不依传输名。
 *
 * 定义放在 shared 而不是 main/hal——renderer 要用它来决定
 * 「文件浏览器入口要不要禁用」，但 renderer 不能 import main。
 *
 * ── 为什么叫「连接级」而不是「能力」 ──
 *
 * 契约层（`docs/spec/02` §10.3）另有一套**板级能力**词表
 * （`shell` / `exec` / `stream` / `files`）。**那不是同一个轴**：
 * 板级说「这块板能做什么」，连接级说「**这条连接**能做什么」。
 * 串口传不了文件（事实 S7）但**板子**当然有文件通道——
 * 同一个词，两个意思。
 *
 * 所以这里**必须**叫 `ConnectionCapabilities`：**名字撞车会让两套词混成一套**
 * （`docs/05` ADR-D24）。板级↔连接级的对照表见 `docs/spec/02` §10.3.2。
 */
export interface ConnectionCapabilities {
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
