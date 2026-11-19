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
   * **切到某块板** ✓（界面「选板子」✓ —— 板实物与连接是两层 ✓）。
   *
   * → **界面只列板** ✓ → **哪条连接由宿主挑** ✓（**用户点的是板** ✓）。
   * → **v1 是单连接** ✓（`O11` / `O18` ✓）→ **「选板子」= 换一块板** ✓
   * → **不是「同时看多块板」** ✓（那是 M8 ✓ —— **另说** ✓）。
   */
  devicesSelect: 'devices:select',
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
  /**
   * 外壳主题（深/浅）。
   *
   * **为什么必须经过 main**：卡片 iframe 的 token 是协议 handler 在响应
   * `cockpit://` 时注入的；renderer 改 document 属性只能改外壳自己。
   * 主题落在 main，卡片重挂时才会带上新的 `theme.css`。
   */
  themeSet: 'theme:set',
  /**
   * **统一权限区**（设置页的那张表 ✓ · ADR-D47 ✓）。
   *
   * → **列所有操作 + 谁能用** ✓
   */
  permissionsList: 'permissions:list',

  /** **改一条**（`actor` × `op` × `allowed` ✓） */
  permissionsSet: 'permissions:set',

  /**
   * **最近的流程运行**（**含还在跑的** ✓ —— 外壳据此显示「运行中」✓）。
   *
   * → **宿主侧专有** ✓（契约 `05` §八·A **A4** ✓：「**只有宿主能取消**」✓）
   * → 卡片与 agent **都拿不到这一份** ✓（卡片看到的是**缩减投影** ✓）
   */
  workflowsRecent: 'workflows:recent',
  /**
   * **取消**一次流程运行。
   *
   * → **只有宿主能取消** ✓（**卡片与 agent 都没有这个接口** ✓ —— 契约 A4 ✓：
   *   「行不行」不给 agent ✓，「停不停」也不给 ✓ —— 否则 agent 就有了
   *   「**自己决定不干**」的通道 ✓ → 「人点头」那条链多了一个旁路 ✗）
   * → **幂等** ✓（取消一个**已经结束**的运行**状态一个字都不改** ✓ —— 契约 A5 ✓）
   * → **不承诺进程一定死** ✓（契约 A1 ✓ —— 那取决于传输与远端 ✓）
   */
  workflowsCancel: 'workflows:cancel',

  /**
   * **接板向导** —— **跑一次向导** ✓（docs/探索/02-想法一-接板向导.md ✓）。
   *
   * → **人只参与一步** ✓：选串口 + 波特率 ✓ → **其余全自动** ✓。
   * → **宿主专用** ✓ —— **卡片与 agent 都拿不到** ✓（它会写用户的目录 ✓）。
   */
  wizardRun: 'wizard:run',
} as const;

/**
 * 宿主看到的一次流程运行（**宿主是可信的** ✓ —— 它看得到完整的那一份 ✓）。
 *
 * → **这个形状必须声明在契约层** ✓ —— preload **不许 import main 的模块** ✓
 *   （分层 ✓ · AGENTS.md §5 ✓）→ 所以它不能是 `main/workflows/service.ts` 里的类型 ✓
 */
export interface HostWorkflowRun {
  runId: string;
  workflowId: string;
  /** 四档（`running` / `done` / `failed` / `cancelled` ✓ —— 契约 A2 ✓） */
  state: 'running' | 'done' | 'failed' | 'cancelled';
  /** 当前这一步（**没有在飞就是 null** ✓ —— 契约 B1 ✓） */
  current: { stepId: string; kind: string; at: number } | null;
  /** 开始的时刻（毫秒 UTC ✓） */
  startedAt: number;
  /** 产出的槽 */
  outputs: Record<string, string>;
}

/**
 * **向导跑完的结果** ✓ —— **宿主专用** ✓。
 *
 * → kind **分四种** ✓ —— **它们是不同的故障** ✓ → **修法完全不同** ✓：
 *   **ok** ✓ · **port-unopenable** ✓（串口打不开 ✓）· **no-reply** ✓（板子没说话 ✓）·
 *   **connection-dead** ✓（一个数都没出来 ✓ —— **那是连接一次都没通** ✓）。
 * → **「板子没说话」与「连不上」是两件事** ✓ —— **文案上不许混** ✓。
 */
export interface WizardRunResult {
  /** 成没成 ✓ */
  ok: boolean;
  /** **现在是哪种情况** ✓ */
  kind: 'ok' | 'port-unopenable' | 'no-reply' | 'connection-dead';
  /** **一句话** ✓（**说人话** ✓ —— **别把「连接失败」和「板子没说话」混成一句** ✓） */
  message: string;
  /** **下一步查什么** ✓（**空数组 = 没什么要提醒的** ✓） */
  hints: string[];
  /** **多少个元操作可用** ✓（**这板有什么** ✓） */
  greenCount: number;
  /** **多少个不可用** ✓ */
  redCount: number;
  /** **包落在哪** ✓（**成了才有** ✓） */
  installedDir?: string;
  /** **这块板的 id** ✓（**成了才有** ✓） */
  boardId?: string;
}

/** 谁能执行一个操作（**卡片** / **agent** ✓） */
export type PermissionActor = 'card' | 'agent';

/** 设置页权限区的一行 */
export interface PermissionRow {
  /** 操作的键（`action:backlight.set` ✓） */
  op: string;
  /** 显示名 */
  label: string;
  /** 这一类（`action` / `workflow` / `host` ✓） */
  kind: 'action' | 'workflow' | 'host';
  /** 这一类里的说明（**人话** ✓） */
  hint?: string;
  /** 危险级别：`destructive` 不进整类授权（必须逐条打开） */
  danger?: 'reversible' | 'destructive';
  /** **卡片**能不能用 */
  card: boolean;
  /** **agent** 能不能用 */
  agent: boolean;
}

/** 一张卡片的一个实例 */
export interface CardInstanceInfo {
  instanceId: string;
  cardId: string;
  /** 卡片的入口地址（`cockpit://card/<实例 id>/<entry>`） */
  url: string;
  connectionId: string | null;
  /** 这张卡是不是有缺失的能力（降级） */
  degraded: boolean;
  /**
   * 卡片**自报的默认尺寸**（manifest 的 `layout.w/h`）。
   *
   * 为什么要它：页面把卡「摆进主区」时得知道它该多大——
   * manifest 是作者的意愿，**只有宿主读得到它** → 宿主在这里带出来。
   */
  layout?: { w: number; h: number; min_w?: number; min_h?: number };
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
   * **切到某块板** ✓（界面「选板子」✓）。
   *
   * → **连不上就报错** ✓（**不静默地换一块板** ✗ —— 那就是「静默地做另一件事」✗）。
   * → **交出去的是板的身份** ✓（`device_key` ✓）—— **不是连接 id** ✓。
   */
  devicesSelect(deviceKey: string): Promise<void>;
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
  /**
   * **统一权限区**（设置页 ✓ · ADR-D47 ✓）。
   *
   * → **一行一个操作** ✓ + **两种执行者** ✓（**卡片** ✓ / **agent** ✓）
   * → **卡片写板子默认禁止** ✓（**C2** ✓）→ **要写板子的人在设置里打开** ✓。
   */
  permissionsList(): Promise<PermissionRow[]>;
  /** 改一条（**幂等** ✓） */
  permissionsSet(actor: PermissionActor, op: string, allowed: boolean): Promise<void>;
  /**
   * **最近的流程运行**（**含还在跑的** ✓）。
   *
   * → **宿主侧专有** ✓（契约 `05` §八·A **A4** ✓）→ 卡片与 agent 拿不到 ✓。
   */
  workflowsRecent(): Promise<HostWorkflowRun[]>;
  /**
   * **取消**一次流程运行（契约 `05` §八·A ✓）。
   *
   * → **幂等** ✓（取消一个已结束的运行**状态一个字都不改** ✓ —— A5 ✓）。
   * → **不承诺进程一定死** ✓（A1 ✓）—— 传输说了算 ✓。
   */
  workflowsCancel(runId: string): Promise<{ runId: string }>;

  /**
   * **接板向导**（docs/探索/02-想法一-接板向导.md ✓）。
   *
   * ── 人只参与一步 ✓ ──
   *
   * → port = **串口号** ✓（**手动选** ✓ —— **不自动枚举** ✓ · 用户已定 ✓）
   * → baudrate = **波特率** ✓（**不试** ✓ —— 用户已定 ✓）
   * → boardName = **这块板叫什么** ✓（**给包起名** ✓）
   *
   * → **只给宿主** ✓ —— **卡片与 agent 都拿不到** ✓。
   */
  wizardRun(input: {
    port: string;
    baudrate: number;
    boardName: string;
    /** **走哪条通道** ✓ —— 缺省 = 串口 ✓ */
    transport?: 'serial' | 'adb';
  }): Promise<WizardRunResult>;
  /** 把外壳主题告诉 main：卡片重新加载时会拿到对应的 token */
  setTheme(theme: 'dark' | 'light'): Promise<void>;
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
  /**
   * **这块板的标识** ✓（板实物与连接是两层 ✓ —— 契约 `spec/02` §10.2 ✓）。
   *
   * → **同一块板的多条连接给同一个值** ✓ → 界面据此**按板子分组** ✓。
   */
  deviceKey: string;
  /**
   * **它是当前运行时那条连接吗** ✓。
   *
   * → **与「有没有活连接」是两条判据** ✓（**不混** ✓）——
   * 开着终端会话也算有活连接 ✓ 但**不是运行时那条** ✓。
   */
  current: boolean;
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
