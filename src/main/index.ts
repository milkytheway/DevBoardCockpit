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
import { fakeMode, type FakeMode } from './hal/fake/profile';
import { fakeRouteFor, profilesWithFake } from './hal/fake/wiring';
import type { Connection } from './hal/connection';
import { SessionLog } from './logging/session-log';
import { loadProfiles } from './profiles/loader';
import {
  builtinProfilesDir,
  builtinWorkflowsDir,
  cardRootsDir,
  cardStorageDir,
  userDataDir,
  userProfilesDir,
  userWorkflowsDir,
} from './util/paths';
import { loadSettings, resolveAdbPath } from './util/settings';
import { TerminalManager } from './terminal/manager';
import { TagRuntime, pickCandidates, startWithRetry } from './tags/runtime';
import { createCardWiring } from './cards/wiring';
import { ActionAudit } from './actions/audit';
import { invokeAction } from './actions/executor';
import { ConfirmationStore } from './actions/authorization';
import { GrantStore } from './cards/grants';
import { effectiveWrite, effectiveWorkflows } from './cards/permissions';
import { McpServer } from './mcp/server';
import { buildMcpHost } from './mcp/wiring';
import { startMcpHttp } from './mcp/http';
import { generateToken } from './mcp/security';
import { discoveryFilePath, removeDiscoveryFile, writeDiscoveryFile } from './mcp/discovery';
import { projectRunStatus, workflowReasonOf } from './cards/workflow-view';
import { WorkflowRegistry, workflowApprovalsFile } from './workflows/registry';
import { WorkflowService } from './workflows/service';
import { TargetRegistry } from './workflows/targets';
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

/**
 * ⚠️ **假设备**（调试用）：`COCKPIT_FAKE=1`（假设备优先）或 `COCKPIT_FAKE=only`（只有它）。
 *
 * **它只在调试构建里存在**——生产构建把这个分支整个剪掉，
 * `scripts/check-build.ts` 会验产物里没有它（ADR-D30）。
 */
declare const __COCKPIT_FAKE_BUILD__: boolean;

const FAKE_MODE: FakeMode = __COCKPIT_FAKE_BUILD__ ? fakeMode() : 'off';

/**
 * The fake device's module — **loaded on demand**.
 *
 * → In a production build `FAKE_MODE` is compiled to `'off'`, so this
 * dynamic import is unreachable, rollup drops it, and **the fake device's
 * code is not in the production bundle at all** (the build self-check
 * verifies this).
 */
type FakeModule = typeof import('./hal/fake/connection.js');
let fakeModule: FakeModule | null = null;

async function loadFakeDevice(): Promise<void> {
  // **编译期常量**：生产构建里 `__COCKPIT_FAKE_BUILD__` 是 `false`，
  // 于是这一行之后全是死代码 → rollup 整块剪掉，
  // **动态 import 那个 chunk 根本不会产出**。
  // （`scripts/check-build.ts` 会验这件事——见 ADR-D30。）
  if (!__COCKPIT_FAKE_BUILD__) return;
  if (FAKE_MODE === 'off') return;
  fakeModule = await import('./hal/fake/connection.js');
}

/**
 * 连接 profile 的来源：内置目录 + 用户目录，用户优先。
 *
 * 假设备（开着的时候）**排第一个**——调试时看到的一定是它。
 */
function listProfiles(): ConnectionProfile[] {
  const profiles = loadProfiles({
    builtinDir: builtinProfilesDir(app.getAppPath()),
    userDir: userProfilesDir(),
  });
  // **编译期常量**：生产构建里它是 `false` → 下面这段是死代码 →
  // **假设备的接线规则整个不进包**（连假 profile 的工厂也不在）。
  if (!__COCKPIT_FAKE_BUILD__) return profiles;
  // **假设备没载入成功 → 就不列它**：
  // 列了却拿真本机连接顶替，比不列更坏（标着「合成数据」，其实是自己的机器）。
  return profilesWithFake(profiles, FAKE_MODE, fakeModule !== null);
}

/** 宿主设置。机器专属的 adb 路径在这里读，不进代码（事实清单 §2） */
const settings = loadSettings(join(app.getAppPath(), 'profiles', 'settings.json'));
const adbPath = resolveAdbPath(settings);

/** 连接用 manager 给的日志——**一个会话一份**，输入输出在同一处 */
function createConnectionFor(profile: ConnectionProfile, log: SessionLog): Connection {
  // **编译期常量**：生产构建里整段假设备的路由是死代码（见上）。
  if (!__COCKPIT_FAKE_BUILD__) return createConnection(profile, log, { adbPath });
  const route = fakeRouteFor(profile.id, FAKE_MODE, fakeModule !== null);
  if (route === 'fake' && fakeModule !== null) {
    // ⚠️ 假设备：产出的全是**合成数据**（见 `hal/fake/`）
    console.warn(`[FAKE] 合成数据已启用（COCKPIT_FAKE=${FAKE_MODE}）`);
    return new fakeModule.FakeConnection({ now: () => Date.now(), log, profile });
  }
  if (route === 'refuse') {
    // **明确拒绝**（绝不回落成真连接）：
    // 「假板子」这个 profile 的传输是 `local` —— 回落下去就是开发者自己的 shell。
    throw makeError('CONN_OPEN_FAILED', '假设备没载入成功（不拿真的本机连接顶替）', {
      detail: { profileId: profile.id },
    });
  }
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
/**
 * 控制面（M6 · 契约 §五）。
 *
 * - **授权账**（`cards/grants.ts`）：**人授过**的动作。
 *   有效写权限 = manifest 声明的 ∩ 人授过的（契约 §2.4）——
 *   只看一边就会漏（只看声明 → 用户没点头的动作也能写）。
 * - **确认凭据**（`actions/authorization.ts`）：一次性、5 分钟有效。
 * - **审计**（`actions/audit.ts`）：每个动作一行，行式文本。
 */
const grants = new GrantStore(join(userDataDir(), 'grants.json'));
const confirmations = new ConfirmationStore();
const actionAudit = new ActionAudit(join(userDataDir(), 'logs', 'actions.log'));

/** 这张卡**人授过**的动作（按参数域） */
function grantedFor(cardId: string): { actions: Record<string, Record<string, { min?: number; max?: number }> | undefined> } {
  const actions: Record<string, Record<string, { min?: number; max?: number }> | undefined> = {};
  for (const grant of grants.forCard(cardId)) {
    actions[grant.actionId] = grant.domains ?? {};
  }
  return { actions };
}

/**
 * 流程层（计划 6 ✓ · 计划 7 把它接给卡片 ✓）。
 *
 * → **注册表**扫两个目录：随应用分发的（`profiles/workflows/` ✓）+ 用户自己的 ✓
 *   （用户目录优先 ✓ —— 与卡片目录同规矩 ✓）。
 * → **批准账**在用户数据目录 ✓（`workflows-approved.json` ✓）——
 *   「放一个文件进目录 ≠ 批准它」✓（契约 `05` §7.3 的 T1 ✓）。
 */
const workflowRegistry = new WorkflowRegistry({
  dirs: [builtinWorkflowsDir(app.getAppPath()), userWorkflowsDir()],
  approvalFile: workflowApprovalsFile(userDataDir()),
});
workflowRegistry.scan();

/** 流程的目标登记处（**角色 → 连接** ✓ —— 计划 6 ✓） */
const workflowTargets = new TargetRegistry({
  profileFor: (id) => listProfiles().find((p) => p.id === id),
  createConnection: (profile) =>
    createConnectionFor(
      profile,
      new SessionLog({
        label: `workflow-${profile.id}`,
        transport: profile.transport,
        dataDir: userDataDir(),
      }),
    ),
});

const workflowService = new WorkflowService({
  registry: workflowRegistry,
  confirmations,
  runDeps: {
    targets: workflowTargets,
    profileFor: (id) => listProfiles().find((p) => p.id === id),
    // **流程的每一步也进同一本动作审计** ✓（契约 `05` §7.2 的第三本账 ✓）
    audit: (row) => actionAudit.append(row),
    confirmations,
  },
  /** 卡级授权（**第二层** ✓ —— 第一层是 manifest 声明 ✓，第三层是包已批准 ✓） */
  grantedWorkflows: (cardId) => grants.workflowIds(cardId),
});

/**
 * **MCP server**（契约 `spec/04` §7.1 ✓ · ADR-D2：与 GUI **同进程** ✓）。
 *
 * → **HTTP 回环** ✓（`127.0.0.1` ✓ —— 契约明写不许绑 `0.0.0.0` ✓）
 * → **发现文件** ✓（agent 靠它找到端口与 token ✓ —— 它是唯一的耦合点 ✓）
 * → **退出时删掉它** ✓（不留指向死进程的发现文件 ✓）
 */
const mcpToken = generateToken();
const mcpDiscoveryPath = discoveryFilePath(userDataDir());
let mcpHttp: { close: () => Promise<void>; port: number } | undefined;

async function startMcpServer(): Promise<void> {
  try {
    const mcp = new McpServer({
      workflows: workflowService,
      // **读侧工具的宿主依赖** ✓（`docs/04` §9.2.1 ✓）
      host: buildMcpHost({
        listProfiles: () => listProfiles(),
        runtime,
        terminal,
        cards: cards.registry,
        cardLog: cards.log,
        // **布局是同一份账** ✓ —— 与卡片侧共用 ✓（不另开一套 ✓）
        layoutGet: () => cards.layoutGet(),
        layoutSet: (state) => cards.layoutSet(state),
        // **agent 的动作执行** ✓ —— **同一个执行器** ✓（卡片侧同一个 ✓ —— 七步链只有一处 ✓）
        agentActions: {
          packId: runtime.packId ?? '',
          // **与执行器用的是同一个值** ✓（**同一处取** ✓）——
          // 不一致 → **凭据永远消费不掉** ✗（症状是「人点了也没用」✗）
          packIdOf: () => runtime.packId ?? '',
          contractVersion: 'devboard/v1',
          hasExitCode: runtime.hasExitCode,
          runTransaction: (fn) => runtime.runTransaction(fn),
          readTag: (tag) => runtime.sampleTag(tag),
          confirmations,
          audit: (row) => actionAudit.append(row),
          actions: () => runtime.actionDefs,
        },
      }),
    });
    const started = await startMcpHttp({
      mcp,
      token: mcpToken,
      host: '127.0.0.1',
      // **0 = 让 OS 分配** ✓（避免多开撞端口 ✓ —— 契约 §7.2 ✓）
      port: 0,
    });
    mcpHttp = started;
    writeDiscoveryFile(mcpDiscoveryPath, {
      apiVersion: 'devboard/v1',
      transport: 'http',
      host: '127.0.0.1',
      port: started.port,
      pid: process.pid,
      token: mcpToken,
      cards_dir: cardRootsDir(),
      started_at: new Date().toISOString(),
    });
  } catch (err) {
    // **起不来不许挡住应用** ✓（MCP 是给 agent 用的 ✓ —— 它坏了，GUI 照常用 ✓）
    console.error(`[MCP] server 起不来：${err instanceof Error ? err.message : String(err)}`);
  }
}

function stopMcpServer(): void {
  // **发现文件先删** ✓（不留指向死进程的发现文件 ✓ —— 契约 §7.2 ✓）
  removeDiscoveryFile(mcpDiscoveryPath);
  void mcpHttp?.close();
  mcpHttp = undefined;
}

/** The shell theme; the card protocol injects the matching tokens. */
let shellTheme: 'dark' | 'light' = 'dark';

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
  /** 宿主里已声明的流程 id（规则 14 ✓）——**没接上就是 null（离线）✓** */
  availableWorkflows: () => workflowRegistry.list().map((w) => w.id),
  permsFor: (cardId) => {
    const card = cards.registry.cards().find((c) => c.cardId === cardId);
    const declared = {
      read: card?.manifest.permissions.read ?? [],
      write: card?.manifest.permissions.write ?? [],
      workflows: card?.manifest.permissions.workflows ?? [],
    };
    // **有效写权限 = 声明 ∩ 人授过的**（契约 §2.4）
    // **有效流程权限 = 声明 ∩ 人授过的**（契约 §3.3 —— 流程**不是动作** ✓）
    return {
      read: declared.read,
      write: effectiveWrite(declared, grants.actionIds(cardId)),
      workflows: effectiveWorkflows(declared, grants.workflowIds(cardId)),
    };
  },
  /**
   * 每张卡的**流程侧**（计划 7 ✓）。
   *
   * → **每卡一份** ✓（授权是每卡一份的 ✓）。
   * → **返回给卡片的是缩减投影** ✓（契约 `05` §八·B·B5 ✓ —— V3-M7 在这里关掉 ✓）。
   */
  workflowsFor: (cardId) => ({
    list: () => workflowService.list(),
    run: (id: string, inputs: Record<string, unknown>) => {
      try {
        // **三层授权**（契约 §3.3 ✓）：会话层查了「卡级」✓，
        // 这里 `start` 还会查「**包已批准**」✓（`requireApproved` ✓）。
        const { runId } = workflowService.start(id, inputs, { cardId });
        return { ok: true, runId };
      } catch (err) {
        // **封闭的理由码** ✓（不能把宿主侧的话泄给卡片 —— 里面有路径 ✓）
        return { ok: false, reason: workflowReasonOf(err) };
      }
    },
    status: (runId: string) => {
      try {
        const status = workflowService.status(runId);
        // **归属校验** ✓：这张卡有没有**这个流程**的权限 ✓
        // （契约 §7.7：「同上」= `permissions.workflows` 里有这个 id ✓）
        const allowed = effectiveWorkflows(
          {
            read: [],
            write: [],
            workflows: cards.registry
              .cards()
              .find((c) => c.cardId === cardId)?.manifest.permissions.workflows ?? [],
          },
          grants.workflowIds(cardId),
        );
        if (!allowed.includes(status.workflowId)) {
          return { ok: false, reason: 'denied' };
        }
        return { ok: true, ...projectRunStatus(status) };
      } catch (err) {
        return { ok: false, reason: workflowReasonOf(err) };
      }
    },
  }),
  actionsFor: (cardId) => ({
    invoke: async (actionId: string, params: Record<string, unknown>) => {
      const action = runtime.actionDef(actionId);
      if (action === undefined) {
        return { ok: false, reason: 'not_found', actionId };
      }
      return invokeAction(action, params, {
        packId: runtime.packId ?? '',
        contractVersion: 'devboard/v1',
        hasExitCode: runtime.hasExitCode,
        // **执行与回读在同一个独占事务里**（SPEC-D22）
        runTransaction: (fn) => runtime.runTransaction(fn),
        readTag: (tag) => runtime.sampleTag(tag),
        granted: () => grantedFor(cardId),
        confirmations,
        audit: (row) => actionAudit.append(row),
        actor: `card:${cardId}`,
      });
    },
  }),
  // **存储不在卡片根目录里**——它被 fs.watch 盯着，写一次就触发一次热刷新（回路）
  storageDir: cardStorageDir(),
  // **布局是宿主记的账**（哪张卡在哪个格子里）→ 落在用户数据目录
  layoutFile: join(userDataDir(), 'layout.json'),
  shellDir: join(__dirname, '../renderer'),
  shellCsp: SHELL_CSP,
  theme: () => shellTheme,
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
handle(IPC.themeSet, (theme) => {
  // The renderer remounts the card frames after switching, so the next
  // `cockpit://` response carries the new tokens (contract §6.2).
  shellTheme = theme === 'light' ? 'light' : 'dark';
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

app.whenReady().then(async () => {
  // `cockpit://` 的处理器（卡片 + 外壳）
  protocol.handle('cockpit', (request) => cards.protocol(request));

  // ⚠️ 假设备（调试构建里才有）
  // **载入失败不许挡住应用起来**——假设备是调试用的脚手架，
  // 它坏了也只该让调试的人少一块板子，不该让整个应用开不了。
  await loadFakeDevice().catch((err: unknown) => {
    console.error(`[FAKE] 假设备载入失败：${err instanceof Error ? err.message : String(err)}`);
  });

  createWindow();

  // **MCP server**（不挡着窗口起来 ✓ —— 它是给 agent 用的 ✓）
  void startMcpServer();

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

// **退出时删掉发现文件** ✓（不留指向死进程的发现文件 ✓ —— 契约 §7.2 ✓）
app.on('will-quit', () => {
  stopMcpServer();
});
