import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  IPC,
  parseCardCspViolation,
  type CardRequest,
  type IpcChannel,
  type IpcResult,
} from '../shared/ipc-contract';
import type { LayoutState } from '../shared/layout';
import { makeError, toAppErrorPayload } from '../shared/errors';
import { PRELOAD_FILE } from '../shared/build-layout';
import { capabilitiesFor, createConnection } from './hal/registry';
import type { Connection } from './hal/connection';
import { SessionLog } from './logging/session-log';
import { loadProfiles } from './profiles/loader';
import { builtinProfilesDir, cardRootsDir, cardStorageDir, userDataDir, userProfilesDir } from './util/paths';
import { loadSettings, resolveAdbPath } from './util/settings';
import { TerminalManager } from './terminal/manager';
import { TagRuntime, pickCandidates, startWithRetry } from './tags/runtime';
import { createCardWiring } from './cards/wiring';
import { cspViolationMessage } from './cards/csp-violation';
import { SHELL_CSP } from './shell-csp';
import type { CardRoot } from './cards/roots';
import { watchCardRoots } from './cards/watcher';
import { TransferService } from './files/transfer';
import { uniqueDownloadPath } from './files/download-target';
import type { ConnectionProfile } from './profiles/schema';

/**
 * Electron main 入口。
 *
 * **唯一持有设备 I/O 的地方**（`docs/04-架构设计.md` §2.1）。
 * renderer 只画界面；卡片 iframe 只经 preload 的白名单 API 触达这里。
 */

/** 连接 profile 的来源：内置目录 + 用户目录，用户优先 */
function listProfiles(): ConnectionProfile[] {
  return loadProfiles({
    builtinDir: builtinProfilesDir(app.getAppPath()),
    userDir: userProfilesDir(),
  });
}

/** 宿主设置。机器专属的 adb 路径在这里读，不进代码（事实清单 §2） */
const settings = loadSettings(join(app.getAppPath(), 'profiles', 'settings.json'));
const adbPath = resolveAdbPath(settings);

/** 连接用 manager 给的日志——**一个会话一份**，输入输出在同一处 */
function createConnectionFor(profile: ConnectionProfile, log: SessionLog): Connection {
  return createConnection(profile, log, { adbPath });
}

/**
 * 已建立的连接，**按 sessionId 建索引**。
 *
 * 原来按 profileId 建索引，于是同一个 profile 开两个标签时，
 * Map 里只剩最后一个——关掉其中一个，另一个标签还活着，
 * 但它的文件浏览器按 id 找连接已经找不到了（报「连接不存在」）。
 *
 * 一个标签一个连接（`TerminalManager.open` 每次都新建连接），
 * 所以索引就该按会话来。
 */
const connections = new Map<string, Connection>();

const transfer = new TransferService({
  getConnection: (id) => connections.get(id),
});

const terminal = new TerminalManager({
  listProfiles,
  createConnection: createConnectionFor,
  createLog: (label, transport) => new SessionLog({ label, transport, dataDir: userDataDir() }),
  // 连接建好后登记一份，文件互传模块靠它按 id 找连接
  onConnectionOpen: (sessionId, connection) => connections.set(sessionId, connection),
  onConnectionClose: (sessionId) => connections.delete(sessionId),
});

// 主进程 → renderer 的推送
function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args);
  }
}

terminal.onData((sessionId, chunk) => broadcast(IPC.terminalData, sessionId, chunk));
terminal.onExit((sessionId, exitCode) => broadcast(IPC.terminalExit, sessionId, exitCode));

/**
 * tag 运行时 —— 让板子的读数**自己在动**。
 *
 * 它**自己建一条连接**（与终端标签的连接分开）：
 * 面板必须在**没有终端标签**的时候也有数——
 * 「看板子的读数」是这个产品的主线，终端是附带的。
 *
 * 代价明说：**串口是独占的**，运行时与终端标签各要一条连接，
 * 同一个 COM3 上只能有一个。第二个会失败，而失败是**看得见的**。
 */
const runtime = new TagRuntime({
  packsDir: join(app.getAppPath(), 'profiles', 'boards'),
  createConnection: createConnectionFor,
  createLog: (label, transport) => new SessionLog({ label, transport, dataDir: userDataDir() }),
});

// 读数只经 TagStore 出（ADR-D22）：renderer 拿不到别处的副本
handle(IPC.tagsReadings, () => runtime.readings());
handle(IPC.tagsStatus, () => runtime.status);
runtime.subscribe((reading) => broadcast(IPC.tagsChanged, reading));

/**
 * `cockpit://` 必须**在 ready 之前**登记为 privileged scheme。
 *
 * `standard: true` 让它有**真源**（`cockpit://card/<id>/…` 的 origin 是
 * `cockpit://card`）——CSP 的 `'self'` 才有意义（契约 §6.1 的断网承诺靠它）。
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'cockpit',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

/* ── 卡片（契约 §六）─────────────────────────────────────────────────
   两个根：**用户目录优先**（用户能改内置卡——「卡片即文件」的前提）。
   目录变了就重新发现（热插拔）；manifest 不合法的卡**保留上一版**。
   ─────────────────────────────────────────────────────────────────── */

const cardRoots: CardRoot[] = [
  { dir: join(app.getAppPath(), 'cards'), kind: 'builtin' },
  { dir: cardRootsDir(), kind: 'user' },
];

/**
 * 外壳自己的 CSP。
 *
 * **为什么生产的外壳不走 `file://`**：`file://` 上的 `'self'` **匹配不到任何东西**
 * （本地 scheme 的 origin 是 opaque 的）——外壳想用 CSP 就得有个**真源**，
 * 所以生产的外壳从 `cockpit://app/` 伺服 ✓。
 *
 * 开发时走 Vite（`http://localhost:5173`），那里有真源，用另一份宽松的
 * （`script-src 'self' 'unsafe-inline'` 是给 Vite 的 inline preamble 留的口子）。
 */
const cards = createCardWiring({
  roots: cardRoots,
  runtime: {
    readings: () => runtime.readings(),
    subscribe: (cb) => runtime.subscribe(cb),
  },
  broadcast: (channel, ...args) => broadcast(channel, ...args),
  currentConnectionId: () => runtime.status.profileId ?? null,
  connectionInfo: (connectionId) => {
    const profile = listProfiles().find((p) => p.id === connectionId);
    if (profile === undefined) return null;
    return { label: profile.label, transport: profile.transport };
  },
  permsFor: (cardId) => {
    const card = cards.registry.cards().find((c) => c.cardId === cardId);
    return {
      read: card?.manifest.permissions.read ?? [],
      write: card?.manifest.permissions.write ?? [],
    };
  },
  // **存储不在卡片根目录里**——它被 fs.watch 盯着，写一次就触发一次热刷新（回路）
  storageDir: cardStorageDir(),
  // **布局是宿主记的账**（哪张卡在哪个格子里）→ 落在用户数据目录
  layoutFile: join(userDataDir(), 'layout.json'),
  shellDir: join(__dirname, '../renderer'),
  shellCsp: SHELL_CSP,
});

cards.refresh();
watchCardRoots(cardRoots, () => {
  cards.refresh();
  broadcast(IPC.cardsChanged);
});

handle(IPC.cardsList, () => cards.list());
handle(IPC.cardsHello, (instanceId) => {
  const id = String(instanceId);
  const cardId = cards.registry.cardOfInstance(id);
  if (cardId === null) {
    throw makeError('PACK_INVALID', `没有登记过的卡片实例：${id}`);
  }
  // v1 只有一条连接上下文（契约 §7.8：由宿主注入）
  cards.sessions.open(id, cardId, runtime.status.profileId ?? null);
  return undefined;
});
handle(IPC.cardsRequest, (req) => cards.handleRequest(req as CardRequest));

handle(IPC.layoutGet, () => cards.layoutGet());
handle(IPC.layoutSet, (state) => {
  cards.layoutSet(state as LayoutState);
  return undefined;
});

/**
 * 一张卡的 **CSP 违规** → 它的运行时日志。
 *
 * 契约 §6.1 的承诺：「浏览器的 CSP 违规会记在卡片运行时日志里，
 * agent 因此能看到『这张卡试图联网』」。
 *
 * **为什么不用 `console-message`**（实测，Electron 34.5.8）：
 * 那个事件的 `sourceId` 对 `connect-src` / `script-src` 违规是**空串** →
 * 归属不到卡 → **恰恰是「试图联网」那一类抓不到**。
 * → 改用卡片文档里的 `securitypolicyviolation` 事件
 * （宿主注入的 `__host/csp.js` 监听）→ 归属天然精确。
 */
handle(IPC.cardsCsp, (instanceId, detail) => {
  const id = String(instanceId);
  const violation = parseCardCspViolation(detail);
  if (violation === null) return undefined;
  cards.captureCspViolation({
    message: cspViolationMessage(violation),
    sourceUrl: `cockpit://card/${id}/`,
  });
  return undefined;
});

/**
 * 挑一个能采的连接 profile 起运行时。
 *
 * **挨个试**：板子可能在 adb 上、也可能在串口上——
 * 第一个连不上的（adb 没插板子、串口被占着）**不是**失败，
 * 试下一个就行。都不行 → 按退避档位再试一轮
 * （**板子后插上，面板不该永远是空的**）。
 */
async function startTagRuntime(): Promise<void> {
  const candidates = pickCandidates(listProfiles());
  if (candidates.length === 0) {
    // 没有带板型包的连接：面板会显示「没有带板型包的连接」
    return;
  }
  await startWithRetry(runtime, candidates);
}

/**
 * 注册一个 invoke 通道。
 *
 * **主进程不抛错，而是返回 `{ok, error}`**：
 * Electron 会把主进程抛出的错误包成
 * `Error invoking remote method 'x': <原错误>`。
 * 原错误若是普通对象，`String(error)` 就是 `[object Object]`——
 * 用户在界面上看到的是 `[object Object]`，
 * 而「串口 COM3 被占用」这句话**永远到不了眼前**。
 *
 * 所以错误在这里被拍平成 `{code, message, retryable, detail}`，
 * 由 preload 还原成带错误码的异常抛给 renderer。
 */
function handle<T>(channel: IpcChannel, fn: (...args: unknown[]) => T | Promise<T>): void {
  ipcMain.handle(channel, async (_e, ...args: unknown[]): Promise<IpcResult<T>> => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: toAppErrorPayload(err) };
    }
  });
}

handle(IPC.terminalOpen, (profileId) => terminal.open(String(profileId)));

/**
 * 这两个是无返回值通道（ipcMain.on）：抛出的异常**没人接**，
 * 会变成未捕获异常把主进程带崩。所以在这里兜住并记日志。
 *
 * 按键是 fire-and-forget 的——每个键都等一次往返会让终端没法用。
 */
ipcMain.on(IPC.terminalWrite, (_e, sessionId: string, data: string) =>
  guard('terminalWrite', () => terminal.write(sessionId, data)),
);
ipcMain.on(IPC.terminalResize, (_e, sessionId: string, cols: number, rows: number) =>
  guard('terminalResize', () => terminal.resize(sessionId, cols, rows)),
);

// 关会话走 invoke：关不掉（串口还占着）要让用户知道，不能只进控制台
handle(IPC.terminalClose, (sessionId) => terminal.close(String(sessionId)));

/** 包住可能抛出的调用。异常只记日志，不许崩主进程。 */
function guard(what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error(`[${what}] ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── 文件互传 ────────────────────────────────────────────────────────
handle(IPC.connectionsList, () =>
  listProfiles().map((p) => ({
    id: p.id,
    label: p.label,
    transport: p.transport,
    boardPack: p.board_pack ?? null,
    capabilities: capabilitiesFor(p),
  })),
);

handle(IPC.filesList, (connectionId, remotePath) =>
  transfer.list(String(connectionId), String(remotePath)),
);

handle(IPC.filesPush, (connectionId, localPath, remotePath) => {
  const remote = String(remotePath);
  return transfer.push(String(connectionId), String(localPath), remote).then(() => ({
    remotePath: remote,
  }));
});

handle(IPC.filesPull, (connectionId, remotePath, localPath) => {
  // **本地落盘位置由宿主定**。
  // renderer 只知道远端路径，不知道宿主上该放哪；
  // 早先 renderer 传空串、宿主注释写着「用默认落盘位置」，
  // 而那个「默认落盘位置」根本不存在——于是下载按钮必挂。
  const target = localPath
    ? String(localPath)
    : uniqueDownloadPath(app.getPath('downloads'), String(remotePath), existsSync);
  return transfer.pull(String(connectionId), String(remotePath), target).then(() => ({
    localPath: target,
  }));
});

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      // preload 的文件名不是随手写的：与 electron-vite 的产出同名（`src/shared/build-layout.ts` 是唯一出处），
      // `npm run build` 末尾的自检脚本会验这个文件真的存在。
      preload: join(__dirname, '../preload', PRELOAD_FILE),
      contextIsolation: true,
      nodeIntegration: false,
      // 渲染进程要装不可信的卡片（契约 §6.1 的 CSP 断网），
      // 沙箱是最后一道防线——**不许为了用 ESM preload 关掉它**。
      // ESM preload 需要 `sandbox: false`，所以 preload 一律构建成 CommonJS。
      sandbox: true,
    },
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    // **生产的外壳也走 `cockpit://app/`** —— `file://` 上的 `'self'` 匹配不到任何东西
    void win.loadURL('cockpit://app/index.html');
  }

  // 拖一个文件进窗口，Electron 默认会**导航到那个文件**——
  // 整个窗口被替换成文件内容，应用看起来「崩了」。
  // 拦住它，拖放交给 renderer 的文件浏览器处理。
  win.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL();
    if (url !== current) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  return win;
}

app.whenReady().then(() => {
  // `cockpit://` 的处理器（卡片 + 外壳）
  protocol.handle('cockpit', (request) => cards.protocol(request));

  createWindow();

  // 读数的运行时：**不挡着窗口起来**——
  // 连不上是常事（板子没插、端口被占），面板会显示为什么。
  void startTagRuntime();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
