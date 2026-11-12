import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { IPC } from '../shared/ipc-contract';
import { capabilitiesFor, createConnection } from './hal/registry';
import type { Connection } from './hal/connection';
import { SessionLog } from './logging/session-log';
import { loadProfiles } from './profiles/loader';
import { builtinProfilesDir, userProfilesDir } from './util/paths';
import { loadSettings, resolveAdbPath } from './util/settings';
import { TerminalManager } from './terminal/manager';
import { TransferService } from './files/transfer';
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

function createConnectionFor(profile: ConnectionProfile): Connection {
  const log = new SessionLog({ label: profile.id, dataDir: userProfilesDir().replace(/profiles[/\\]targets$/, '') });
  return createConnection(profile, log, { adbPath });
}

/** 已建立的连接，按连接 profile 的 id 索引 */
const connections = new Map<string, Connection>();

const transfer = new TransferService({
  getConnection: (id) => connections.get(id),
});

const terminal = new TerminalManager({
  listProfiles,
  createConnection: createConnectionFor,
  createLog: (label) => new SessionLog({ label, dataDir: userProfilesDir().replace(/profiles[/\\]targets$/, '') }),
  // 连接建好后登记一份，文件互传模块靠它按 id 找连接
  onConnectionOpen: (connectionId, connection) => connections.set(connectionId, connection),
});

// 主进程 → renderer 的推送
function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args);
  }
}

terminal.onData((sessionId, chunk) => broadcast(IPC.terminalData, sessionId, chunk));
terminal.onExit((sessionId, exitCode) => broadcast(IPC.terminalExit, sessionId, exitCode));

ipcMain.handle(IPC.terminalOpen, async (_e, profileId: string) => terminal.open(profileId));

// 这三个是无返回值通道（ipcMain.on）：抛出的异常**没人接**，
// 会变成未捕获异常把主进程带崩。所以在这里兜住并记日志。
ipcMain.on(IPC.terminalWrite, (_e, sessionId: string, data: string) =>
  guard('terminalWrite', () => terminal.write(sessionId, data)),
);
ipcMain.on(IPC.terminalResize, (_e, sessionId: string, cols: number, rows: number) =>
  guard('terminalResize', () => terminal.resize(sessionId, cols, rows)),
);
ipcMain.on(IPC.terminalClose, (_e, sessionId: string) =>
  guard('terminalClose', () => terminal.close(sessionId)),
);

/** 包住可能抛出的调用。异常只记日志，不许崩主进程。 */
function guard(what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error(`[${what}] ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── 文件互传 ────────────────────────────────────────────────────────
ipcMain.handle(IPC.connectionsList, async () =>
  listProfiles().map((p) => ({
    id: p.id,
    label: p.label,
    transport: p.transport,
    boardPack: p.board_pack ?? null,
    capabilities: capabilitiesFor(p),
  })),
);
ipcMain.handle(IPC.filesList, async (_e, connectionId: string, remotePath: string) =>
  transfer.list(connectionId, remotePath),
);
ipcMain.handle(IPC.filesPush, async (_e, connectionId: string, localPath: string, remotePath: string) =>
  transfer.push(connectionId, localPath, remotePath),
);
ipcMain.handle(IPC.filesPull, async (_e, connectionId: string, remotePath: string, localPath: string) =>
  transfer.pull(connectionId, remotePath, localPath),
);

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return win;
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
