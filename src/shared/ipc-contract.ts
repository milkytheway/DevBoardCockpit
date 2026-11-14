/**
 * main 与 renderer 之间的全部 IPC 通道。
 *
 * 通道名集中在这里，main 与 preload 共用同一份定义——
 * 拼错通道名在编译期就会报错，而不是运行时静默失败。
 */

import type { AppErrorPayload } from './errors';
import type { TagReading } from './tag-reading';
import type { RuntimeStatus } from './runtime-status';
import type { LayoutState } from './layout';

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
  /**
   * tag 运行时的**状态**（连上了吗 / 为什么连不上）。
   *
   * **为什么单独一条通道**：`tags:readings` 只给读数——
   * **「为什么一个数都没有」这件事根本到不了面板**，
   * 面板只能笼统地说「还没有读数」。而「板子没插上」和「等一个采样周期」
   * 是两回事，前者等一辈子也不会好。
   */
  tagsStatus: 'tags:status',
  /** 装着的卡片（页面据此渲染卡片区） */
  cardsList: 'cards:list',
  /** 卡片实例连上了（main 开一个会话） */
  cardsHello: 'cards:hello',
  /** 卡片的一个请求 → main（权限判定在 main） */
  cardsRequest: 'cards:request',
  /**
   * 一张卡的 **CSP 违规** → main（进那张卡的运行时日志）。
   *
   * **为什么单独一条通道**：它**不是卡片 API**——
   * 是宿主注入的监听脚本（`__host/csp.js`）在卡片自己的文档里报的。
   * 卡片伪造一条也只能污染**它自己**的日志。
   */
  cardsCsp: 'cards:csp',
  /** main → 卡片（推给某个实例） */
  cardsEvent: 'cards:event',
  /** 装着的卡片变了（热插拔）—— 页面据此重新取清单 */
  cardsChanged: 'cards:changed',
  /** 读布局（哪张卡在哪个格子里） */
  layoutGet: 'layout:get',
  /** 存布局（拖完之后） */
  layoutSet: 'layout:set',
} as const;

/** 一张卡片的一个实例 */
export interface CardInstanceInfo {
  instanceId: string;
  cardId: string;
  /** 卡片的入口地址（`cockpit://card/<实例 id>/<entry>`） */
  url: string;
  connectionId: string | null;
  /** 这张卡是不是有缺失的能力（降级） */
  degraded: boolean;
}

/** 卡片的一个请求 */
export interface CardRequest {
  instanceId: string;
  /** 请求 id（回应时原样带回） */
  id: string;
  /** 全名，如 `tags.get` */
  method: string;
  args: unknown;
}

/** 卡片的一个请求的回应 */
export interface CardResponse {
  id: string;
  ok: boolean;
  value?: unknown;
  reason?: string;
}

/**
 * 一条 CSP 违规的详情。
 *
 * **纯数据**（跨进程边界的约定都在本文件里）。
 * 字段来自 DOM 的 `SecurityPolicyViolationEvent`。
 */
export interface CardCspViolation {
  /** 它想访问什么（内联脚本是 `inline`） */
  blockedURI: string;
  /** 被违反的指令（如 `connect-src`） */
  effectiveDirective: string;
  /** 真正被违反的那条（`effectiveDirective` 的具体形式） */
  violatedDirective: string;
  /** 触发违规的文件（卡片自己的 URL） */
  sourceFile: string;
  /** 行号（0 = 没有） */
  lineNumber: number;
  /** 违规的那段代码（浏览器给的，可能为空） */
  sample: string;
}

/**
 * 校验一条 CSP 违规详情。
 *
 * **为什么要有**：这份数据是**卡片给的**（卡片是 AI 写的任意网页）——
 * 跨进程之前必须收成**封闭形状**，否则 main 侧拿到什么都有。
 *
 * @returns 不合格就是 `null`（**不猜**——契约的「不猜」口径）
 */
export function parseCardCspViolation(raw: unknown): CardCspViolation | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const str = (key: string): string => (typeof v[key] === 'string' ? (v[key] as string) : '');
  const line = typeof v['lineNumber'] === 'number' && Number.isFinite(v['lineNumber'])
    ? Math.trunc(v['lineNumber'])
    : 0;
  return {
    blockedURI: str('blockedURI'),
    effectiveDirective: str('effectiveDirective'),
    violatedDirective: str('violatedDirective'),
    sourceFile: str('sourceFile'),
    lineNumber: line,
    sample: str('sample'),
  };
}

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
   * 取运行时的状态（连上了吗 / 为什么连不上）。
   *
   * **面板靠它说人话**：没有读数时，
   * 「连不上：串口 COM3 被占用」与「等一个采样周期」是两回事。
   */
  tagsStatus(): Promise<RuntimeStatus>;
  /** 装着的卡片 */
  cardsList(): Promise<CardInstanceInfo[]>;
  /** 卡片实例连上了（main 开一个会话） */
  cardsHello(instanceId: string): Promise<void>;
  /** 卡片的一个请求（**权限判定在 main**） */
  cardsRequest(req: CardRequest): Promise<CardResponse>;
  /** 读布局 */
  layoutGet(): Promise<LayoutState>;
  /** 存布局 */
  layoutSet(state: LayoutState): Promise<void>;
  /** 一张卡的 CSP 违规 → main（进那张卡的运行时日志） */
  cardsCsp(instanceId: string, detail: CardCspViolation): Promise<void>;
  /**
   * 听 main 的推送（读数变化等）。
   *
   * @returns 退订函数。
   */
  onCardEvent(cb: (instanceId: string, payload: unknown) => void): () => void;
  /**
   * 听「装着的卡片变了」（热插拔）。
   *
   * @returns 退订函数。
   */
  onCardsChanged(cb: () => void): () => void;
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
