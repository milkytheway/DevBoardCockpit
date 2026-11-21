import { app, BrowserWindow, ipcMain, Menu, protocol } from 'electron';
import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  IPC,
  parseCardCspViolation,
  type CardRequest,
  type IpcChannel,
  type IpcResult,
  type PermissionActor,
} from '../shared/ipc-contract';
import type { LayoutState } from '../shared/layout';
import type { HostWorkflowRun } from '../shared/ipc-contract';
import { makeError, toAppErrorPayload } from '../shared/errors';
import { PRELOAD_FILE } from '../shared/build-layout';
import { capabilitiesFor, createConnection } from './hal/registry';
import { fakeMode, fakeProfileIds, type FakeMode } from './hal/fake/profile';
import { fakeRouteFor, profilesWithFake } from './hal/fake/wiring';
import type { Connection } from './hal/connection';
import { SessionLog } from './logging/session-log';
import { loadProfiles } from './profiles/loader';
import { selectDevice } from './profiles/device-select';
import {
  HOST_OPERATIONS,
  PermissionStore,
  type PermissionOperation,
} from './permissions/policy';
import {
  builtinCardsDir,
  builtinProfilesDir,
  builtinWorkflowsDir,
  cardRootsDir,
  cardStorageDir,
  userBoardsDir,
  userDataDir,
  userProfilesDir,
  userWorkflowsDir,
} from './util/paths';
import { loadSettings, resolveAdbPath } from './util/settings';
import { TerminalManager } from './terminal/manager';
import { TagRuntime, pickCandidates, startWithRetry } from './tags/runtime';
import { listPacksIn, matchPack } from './tags/binding';
import { applyValues, prepareProfile } from './board/prepare';
import { hostPortProbe, listHostPorts } from './board/ports';
import { readSshRecords } from './board/ssh-records';
import { tcpAddressProbe } from './board/detect';
import { sshAuthenticates } from './hal/ssh';
import {
  listAdbDevices,
  probeSerialPorts,
  readBoardIPv4,
  readBoardModel,
} from './board/detect';
import { persistProfile } from './board/persist';
import { parseBoardValues } from '../shared/board-setup';
import { createCardWiring } from './cards/wiring';
import { runWizardForHost } from './wizard/wiring';
import { ActionAudit } from './actions/audit';
import { invokeAction } from './actions/executor';
import { McpServer } from './mcp/server';
import { buildMcpHost } from './mcp/wiring';
import { startMcpHttp } from './mcp/http';
import { generateToken } from './mcp/security';
import { discoveryFilePath, removeDiscoveryFile, writeDiscoveryFile } from './mcp/discovery';
import { projectRunStatus, workflowReasonOf } from './cards/workflow-view';
import { WorkflowRegistry } from './workflows/registry';
import { WorkflowService, type WorkflowRunStatus } from './workflows/service';
import { TargetRegistry } from './workflows/targets';
import { cspViolationMessage } from './cards/csp-violation';
import { SHELL_CSP } from './shell-csp';
import { listCardDirs, type CardRoot } from './cards/roots';
import { watchCardRoots } from './cards/watcher';
import { TransferService } from './files/transfer';
import { uniqueDownloadPath } from './files/download-target';
import type { ConnectionProfile } from './profiles/schema';
import { deviceKeyOf } from './profiles/schema';
import { SEEDS } from '../shared/theme/seed';

/** Height of the native window-controls overlay (kept in sync with visual.css). */
const TITLEBAR_HEIGHT = 40;

/**
 * Colours for the native window controls (min / max / close) drawn over the
 * page. The canvas colour comes from the same seed the renderer uses, so the
 * overlay stays invisible against the shell in both themes.
 */
function titleBarOverlay(theme: 'dark' | 'light'): {
  color: string;
  symbolColor: string;
  height: number;
} {
  const seed = SEEDS[theme];
  return {
    color: seed['bg-0'],
    symbolColor: seed['text-0'],
    height: TITLEBAR_HEIGHT,
  };
}

/**
 * Electron main entry point.
 *
 * The one place that holds device I/O (see `README.md` in the repository
 * root). The renderer only draws the interface; card iframes reach this
 * code only through the preload's whitelist API.
 */

/**
 * The fake device (synthetic data ✓): it **ships with the application** ✓
 * (the user decided it on 2026-11-21 ✓).
 *
 * → `COCKPIT_FAKE=off` turns it off ✓ · `COCKPIT_FAKE=only` leaves only
 *   the fake one ✓.
 * → **The real boards come first** ✓ — the default selection is the real
 *   board ✓ (`hal/fake/wiring.ts` ✓).
 * → Every screen it appears on says that it is synthetic ✓.
 */
declare const __COCKPIT_FAKE_BUILD__: boolean;

const FAKE_MODE: FakeMode = __COCKPIT_FAKE_BUILD__ ? fakeMode() : 'off';

/**
 * The fake device's module — **loaded on demand** ✓.
 *
 * → It is a dynamic import ✓ → the chunk is only fetched when the fake board
 *   is actually used ✓.
 */
type FakeModule = typeof import('./hal/fake/connection.js');
let fakeModule: FakeModule | null = null;

async function loadFakeDevice(): Promise<void> {
  // The fake device is **not** pruned any more ✓ (the user decided it on
  // 2026-11-21 ✓) → the module is loaded when the fake board is used ✓.
  if (!__COCKPIT_FAKE_BUILD__) return;
  if (FAKE_MODE === 'off') return;
  fakeModule = await import('./hal/fake/connection.js');
}

/**
 * Where connection profiles come from: the builtin directory plus the user
 * directory, with the user's taking precedence.
 *
 * The fake device (when it is on) is listed first — while debugging it is
 * always the one you see.
 */
function listProfiles(): ConnectionProfile[] {
  const profiles = loadProfiles({
    builtinDir: builtinProfilesDir(app.getAppPath()),
    userDir: userProfilesDir(),
  });
  // Compile-time constant: in a production build it is `false` → the block
  // below is dead code → none of the fake device's wiring rules make it into
  // the bundle (not even the factory for the fake profile).
  if (!__COCKPIT_FAKE_BUILD__) return profiles;
  // If the fake device failed to load, it is not listed: listing it and then
  // substituting a real local connection is worse than not listing it at all
  // (it would be labelled 'synthetic data' while actually being your own
  // machine).
  return profilesWithFake(profiles, FAKE_MODE, fakeModule !== null);
}

/** Host settings. Machine-specific adb paths are read here, not baked into the code (device fact list §2) */
const settings = loadSettings(join(app.getAppPath(), 'profiles', 'settings.json'));
const adbPath = resolveAdbPath(settings);

/**
 * The models a board of this pack has to report ✓.
 *
 * → The board pack's own match rules ✓ (`match.models` ✓) → **the pack is
 *   the authority on what its board calls itself** ✓ → the detection uses
 *   them to tell "this is our board" from "this is some other device that
 *   happens to be plugged in" ✓.
 */
function expectedModelsFor(boardPackId: string | null | undefined): string[] {
  if (typeof boardPackId !== 'string' || boardPackId.length === 0) return [];
  const packs = listPacksIn([join(app.getAppPath(), 'profiles', 'boards'), userBoardsDir()]);
  const pack = packs.find((candidate) => candidate.id === boardPackId);
  return pack?.match?.models ?? [];
}

/**
 * The log handed over by the connection manager — one per session, so input and output land in the same place.
 *
 * → **Asynchronous** ✓ — before the connection is built, the machine-specific
 *   values of the profile are **detected** ✓ (the board's serial number ✓ ·
 *   its address ✓) → the published profiles carry placeholders for them ✓
 *   (a documented address ✓ · an all-zero serial ✓) → **without the
 *   detection every shipped connection points nowhere** ✓.
 */
async function createConnectionFor(
  profile: ConnectionProfile,
  log: SessionLog,
): Promise<Connection> {
  // Compile-time constant: in a production build the whole fake-device routing block is dead code (see above).
  if (!__COCKPIT_FAKE_BUILD__) return createConnection(profile, log, { adbPath });
  const route = fakeRouteFor(profile.id, FAKE_MODE, fakeModule !== null);
  if (route === 'fake' && fakeModule !== null) {
    // ⚠️ Fake device: everything it produces is synthetic data (see `hal/fake/`)
    console.warn(`[FAKE] synthetic data is enabled (COCKPIT_FAKE=${FAKE_MODE})`);
    return new fakeModule.FakeConnection({ now: () => Date.now(), log, profile });
  }
  if (route === 'refuse') {
    // Explicit refusal, never a fallback to a real connection: the 'fake
    // board' profile has transport `local` — falling back there lands on the
    // developer's own shell.
    throw makeError('CONN_OPEN_FAILED', 'the fake device did not load (it does not fall back to a real local connection)', {
      detail: { profileId: profile.id },
    });
  }
  // → **The values of this machine are detected before the connection is built** ✓
  // → and the repaired profile is written into the user directory ✓ → the
  //   next start reads the right values ✓ (no detection, no delay ✓).
  const prepared = await prepareProfile(profile, {
    adbPath,
    expectedModels: expectedModelsFor(profile.board_pack),
    userProfilesDir: userProfilesDir(),
    // → **The serial console is looked for** ✓ (the ports are asked which
    //   one is the console ✓ — **a port that answers is the console** ✓).
    // → It is only the **serial** connection that asks ✓ (the other two
    //   transports do not use a port ✓).
    ports: profile.transport === 'serial' ? hostPortProbe : undefined,
    // → **The SSH records of this machine** ✓ (the addresses the person
    //   reaches ✓ · the private keys they use ✓) → the credential is one of
    //   them ✓ and it is **verified** against the host ✓.
    ssh: readSshRecords(homedir()),
    probeCredential: (target, candidate) => sshAuthenticates(target, candidate.key),
    // → **Does the address still answer?** ✓ → a stored address that does
    //   not answer is detected again ✓ (the freeze is broken ✓).
    probeAddress: tcpAddressProbe,
    log: (message) => console.log(message),
  });
  return createConnection(prepared, log, { adbPath });
}

/**
 * Established connections, indexed by sessionId.
 *
 * It used to be indexed by profileId, so opening the same profile in two tabs
 * left only the last one in the Map — close one of them and the other tab is
 * still alive, but its file browser can no longer find the connection by id
 * (it reports 'connection does not exist').
 *
 * One connection per tab (`TerminalManager.open` creates a new connection
 * every time), so the index belongs to sessions.
 */
const connections = new Map<string, Connection>();

const transfer = new TransferService({
  getConnection: (id) => connections.get(id),
});

const terminal = new TerminalManager({
  listProfiles,
  createConnection: createConnectionFor,
  createLog: (label, transport) => new SessionLog({ label, transport, dataDir: userDataDir() }),
  // Register the connection once it has been established; the file transfer module looks it up by id
  onConnectionOpen: (sessionId, connection) => connections.set(sessionId, connection),
  onConnectionClose: (sessionId) => connections.delete(sessionId),
});

// Pushes from the main process to the renderer
function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args);
  }
}

terminal.onData((sessionId, chunk) => broadcast(IPC.terminalData, sessionId, chunk));
terminal.onExit((sessionId, exitCode) => broadcast(IPC.terminalExit, sessionId, exitCode));

/**
 * The tag runtime — it makes the board's readings move on their own.
 *
 * It opens its own connection, separate from the terminal tab's:
 * the panels must have numbers even when no terminal tab is open —
 * 'watching a board's readings' is this product's main line, the terminal is
 * the accessory.
 *
 * The cost, stated plainly: a serial port is exclusive, the runtime and a
 * terminal tab each need a connection, and only one of them can have a given
 * COM3. The second one fails, and the failure is visible.
 */
const runtime = new TagRuntime({
  packsDir: join(app.getAppPath(), 'profiles', 'boards'),
  // The user's own board pack directory ✓ — the packs instantiated by
  // the wizard land here ✓
  // → On the same id the user's wins ✓ (same rule as connection profiles /
  //   workflow packs / cards ✓)
  userPacksDir: userBoardsDir(),
  createConnection: createConnectionFor,
  createLog: (label, transport) => new SessionLog({ label, transport, dataDir: userDataDir() }),
});

// Readings only ever come out through the TagStore (ADR-D22): the renderer cannot get a copy from anywhere else
handle(IPC.tagsReadings, () => runtime.readings());
handle(IPC.tagsStatus, () => runtime.status);
runtime.subscribe((reading) => broadcast(IPC.tagsChanged, reading));

/**
 * `cockpit://` must be registered as a privileged scheme before ready.
 *
 * `standard: true` gives it a real origin (the origin of
 * `cockpit://card/<id>/…` is `cockpit://card`) — that is what makes CSP's
 * `'self'` meaningful (contract §6.1's no-network promise depends on it).
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

/* ── Cards (contract §6) ──────────────────────────────────────
   Two roots, the user's directory first (the user can modify the builtin
   cards — the premise of 'cards are files').
   A changed directory is rediscovered (hot plug); a card with an invalid
   manifest keeps the previous version.
   ─────────────────────────────────────────────────────────────────── */

const cardRoots: CardRoot[] = [
  { dir: builtinCardsDir(app.getAppPath()), kind: 'builtin' },
  { dir: cardRootsDir(), kind: 'user' },
];

/**
 * The shell's own CSP.
 *
 * Why the production shell does not use `file://`: on `file://` the `'self'`
 * source matches nothing at all (a local scheme's origin is opaque) — a
 * shell that wants a CSP needs a real origin, so the production shell is
 * served from `cockpit://app/` ✓.
 *
 * In development it goes through Vite (`http://localhost:5173`), which does
 * have a real origin, so it uses a separate, looser policy
 * (`script-src 'self' 'unsafe-inline'` leaves room for Vite's inline preamble).
 */
/**
 * The control plane (M6 · contract §5).
 *
 * - No authorization ledger ✓ — effective permission = declaration ✓
 *   (contract §2.4 ✓ · implementation decision record ADR-D46 ✓): the board
 *   pack decides ✓; a card's manifest is its permission ✓; the user
 *   clicking is the consent ✓ → there is no second record of 'who granted
 *   this' any more ✓.
 * - No confirmation chain ✓ — there is no "wait for a nod" state any more ✓
 *   (ADR-D48 ✓): the permission area and the danger floor decide whether an
 *   action runs, and the audit records what happened ✓.
 * - Audit (`actions/audit.ts`): one line per action, line-oriented text.
 */
/**
 * The unified permission area (that table on the settings page ✓ ·
 * implementation decision record ADR-D47 ✓).
 *
 * → One place ✓: turn it off and it is off ✓ — no more pop-ups ✓.
 * → Cards writing to the board are forbidden by default ✓ (C2 ✓) → whoever
 *   needs to write to the board turns it on in settings ✓.
 */
const permissions = new PermissionStore(join(userDataDir(), 'permissions.json'));
const actionAudit = new ActionAudit(join(userDataDir(), 'logs', 'actions.log'));

/**
 * The actions this card may perform — exactly the ones it declares ✓
 * (contract §2.4 ✓ · implementation decision record ADR-D46 ✓).
 *
 * → There is no second ledger of 'what a person granted' any more ✓
 *   (recording the same thing twice ✗ — the two copies will drift apart ✗).
 * → The domain is not narrowed ✓ (`{}` ✓) — a guard's narrowing is for
 *   the 'ask a person' path ✓ (the card path does not ask ✓).
 */
function grantedFor(cardId: string): { actions: Record<string, Record<string, { min?: number; max?: number }> | undefined> } {
  const card = cards.registry.cards().find((c) => c.cardId === cardId);
  const actions: Record<string, Record<string, { min?: number; max?: number }> | undefined> = {};
  for (const id of card?.manifest.permissions.write ?? []) {
    actions[id] = {};
  }
  return { actions };
}

/**
 * The workflow layer (plan 6 ✓ · plan 7 connects it to the cards ✓).
 *
 * → The registry scans two directories: the one shipped with the app
 *   (`profiles/workflows/` ✓) plus the user's own ✓ (the user's directory
 *   first ✓ — the same rule as the card directories ✓).
 * → The gate is not here ✓ — the existence of a workflow pack is itself
 *   the explanation ✓ (implementation decision record ADR-D48 ✓)
 *   → Whether it may run is decided by the unified permission area in
 *     settings ✓ (`05` §7.2 ✓ · implementation decision record ADR-D47 ✓).
 */
const workflowRegistry = new WorkflowRegistry({
  dirs: [builtinWorkflowsDir(app.getAppPath()), userWorkflowsDir()],
});
workflowRegistry.scan();

/** Where workflows register their targets (role → connection ✓ — plan 6 ✓) */
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
  runDeps: {
    targets: workflowTargets,
    profileFor: (id) => listProfiles().find((p) => p.id === id),
    // Every workflow step also goes into the same action audit ✓ (the third ledger of contract `05` §7.2 ✓)
    audit: (row) => actionAudit.append(row),
  },
  /** Workflow-layer authorization ✓ — only one layer is left ✓
   *  (implementation decision record ADR-D48 ✓): the existence of a workflow
   *  pack is itself the explanation ✓ — the gate is the unified permission
   *  area in settings ✓ (implementation decision record ADR-D47 ✓) */
});

/**
 * That table on the settings page's permission area (one row per operation ✓
 * · implementation decision record ADR-D47 ✓).
 *
 * → The actions of the board currently connected ✓ (the board pack decides ✓)
 * → The approved workflows ✓ (only the approved ones are listed ✓ — an
 *   unapproved workflow is invisible to cards ✓)
 * → The host's three operations ✓ (install card / uninstall card / promote
 *   to full screen ✓)
 */
/**
 * One workflow run on the host side → the shape from the shared contract ✓.
 *
 * → The preload must not import main's modules ✓ (layering ✓ · AGENTS.md §5 ✓)
 *   → so this shape must be declared in `shared/` ✓ → here it is only trimmed ✓
 *   (main-internal fields removed ✓) — this is not redaction ✓ (the host is
 *   trusted ✓).
 */
function toHostRun(status: WorkflowRunStatus): HostWorkflowRun {
  return {
    runId: status.runId,
    workflowId: status.workflowId,
    state: status.state,
    current:
      status.current === null
        ? null
        : { stepId: status.current.stepId, kind: status.current.kind, at: status.current.at },
    startedAt: status.startedAt,
    outputs: status.outputs,
  };
}

function permissionOperations(): PermissionOperation[] {
  const operations: PermissionOperation[] = [];
  for (const action of runtime.actionSummaries) {
    operations.push({
      op: `action:${action.id}`,
      label: action.label ?? action.id,
      kind: 'action',
      danger: action.danger === 'destructive' ? 'destructive' : 'reversible',
      // The danger level is only information ✓ (the gate is the switch ✓ — implementation decision record ADR-D48 ✓)
      ...(action.danger === 'destructive' ? { hint: 'destructive action' } : {}),
    });
  }
  for (const flow of workflowRegistry.list()) {
    // The 'approved' layer is gone ✓ (implementation decision record ADR-D48 ✓) — existence is the explanation ✓
    const plan = workflowRegistry.planOf(flow.id);
    operations.push({
      op: `workflow:${flow.id}`,
      label: flow.name,
      kind: 'workflow',
      ...(plan === undefined ? {} : { hint: `${plan.steps.length} steps · ${plan.roles.length} machines` }),
    });
  }
  for (const op of HOST_OPERATIONS) {
    operations.push({ op: `host:${op}`, label: op, kind: 'host' });
  }
  return operations;
}

/**
 * The MCP server (contract `spec/04` §7.1 ✓ · implementation decision record
 * ADR-D2: same process as the GUI ✓).
 *
 * → HTTP loopback ✓ (`127.0.0.1` ✓ — the contract explicitly forbids binding
 *   `0.0.0.0` ✓)
 * → The discovery file ✓ (agents find the port and token through it ✓ — it is
 *   the only coupling point ✓)
 * → It is deleted on quit ✓ (no discovery file pointing at a dead process ✓)
 */
const mcpToken = generateToken();
const mcpDiscoveryPath = discoveryFilePath(userDataDir());
let mcpHttp: { close: () => Promise<void>; port: number } | undefined;

async function startMcpServer(): Promise<void> {
  try {
    const mcp = new McpServer({
      // **The unified permission area** ✓ (the gate of the agent side ✓ —
      // implementation decision record ADR-D47 ✓ · ADR-D48 ✓)
      permissions,
      workflows: workflowService,
      // Host dependencies of the read-side tools ✓ (see `src/main/mcp/host.ts` ✓)
      host: buildMcpHost({
        listProfiles: () => listProfiles(),
        runtime,
        terminal,
        cards: cards.registry,
        cardLog: cards.log,
        // The layout is the same ledger ✓ — shared with the card side ✓ (no second set ✓)
        layoutGet: () => cards.layoutGet(),
        layoutSet: (state) => cards.layoutSet(state),
        // Installing and uninstalling cards ✓ (contract §2.3 ✓)
        cardsRoot: cardRootsDir(),
        // Builtin card ids ✓ — taken only from the builtin directory ✓
        // (cards from the user directory can be uninstalled ✓ — those are the
        // 'things the user installed' ✓)
        builtinCardIds: listCardDirs([{ dir: builtinCardsDir(app.getAppPath()), kind: 'builtin' }]).map(
          (c) => c.cardId,
        ),
        // The agent's action execution ✓ — the same executor ✓ (the card side uses the same one ✓ — the seven-step chain exists in exactly one place ✓)
        agentActions: {
          packId: runtime.packId ?? '',
          // The same value the executor uses ✓ (taken from one place ✓) —
          // if the two differ the credential can never be consumed ✗ (the
          // symptom is 'a person clicked and nothing happened' ✗)
          packIdOf: () => runtime.packId ?? '',
          contractVersion: 'devboard/v1',
          // Which board is the board currently in use ✓ (the credential must be bound to it ✓ — contract `spec/04` §2.4.1 item six ✓)
          deviceKey: () => runtime.currentDeviceKey ?? '',
          hasExitCode: runtime.hasExitCode,
          runTransaction: (fn) => runtime.runTransaction(fn),
          readTag: (tag) => runtime.sampleTag(tag),
          audit: (row) => actionAudit.append(row),
          actions: () => runtime.actionDefs,
          // **The gate of the agent side** ✓ (the same store the settings page
          // writes ✓ — **one book** ✓)
          permissions,
        },
      }),
    });
    const started = await startMcpHttp({
      mcp,
      token: mcpToken,
      host: '127.0.0.1',
      // 0 = let the OS assign it ✓ (avoids a second instance colliding on the port ✓ — contract §7.2 ✓)
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
    // Failing to start must not block the app ✓ (the MCP server is for agents ✓ — if it breaks, the GUI still works ✓)
    console.error(`[MCP] the server does not come up: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function stopMcpServer(): void {
  // The discovery file is deleted first ✓ (no discovery file pointing at a dead process ✓ — contract §7.2 ✓)
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
  /** Workflow ids already declared on the host (rule 14 ✓) — not wired up means null (offline) ✓ */
  availableWorkflows: () => workflowRegistry.list().map((w) => w.id),
  // Action ids from the board pack ✓ (rule 5 ✓) — null means offline ✓
  // → Same yardstick as the MCP `validate_card` ✓ (fixed 2026-11-19 ✓)
  availableActions: () => runtime.packView?.actions ?? null,
  permsFor: (cardId) => {
    const card = cards.registry.cards().find((c) => c.cardId === cardId);
    const declared = {
      read: card?.manifest.permissions.read ?? [],
      write: card?.manifest.permissions.write ?? [],
      workflows: card?.manifest.permissions.workflows ?? [],
    };
    // Effective permission = declaration ✓ (contract §2.4 ✓ ·
    // implementation decision record ADR-D46 ✓)
    // → There is no second record of 'who granted this' any more ✓ (the
    //   board pack decides ✓ · a click is consent ✓)
    return {
      read: declared.read,
      write: declared.write,
      workflows: declared.workflows ?? [],
    };
  },
  /**
   * The workflow side of each card (plan 7 ✓).
   *
   * → One set per card ✓ (authorization is per card ✓).
   * → What is returned to the card is a reduced projection ✓ (contract `05`
   *   §8·B·B5 ✓ — V3-M7 is closed off here ✓).
   */
  workflowsFor: (cardId) => ({
    list: () => workflowService.list(),
    run: (id: string, inputs: Record<string, unknown>) => {
      try {
        // The permission area (implementation decision record ADR-D47 ✓): that
        // one switch in settings ✓
        // → A card triggering a workflow is allowed by default ✓ (that switch
        //   is the gate ✓)
        if (!permissions.allows('card', `workflow:${id}`)) {
          return { ok: false, reason: 'denied' };
        }
        // → This is the whole gate ✓ (the session layer checks the card-level
        //   declaration ✓; there is no second approval ledger ✓ — the
        //   existence of a workflow pack is the explanation ✓ ·
        //   implementation decision record ADR-D48 ✓).
        const { runId } = workflowService.start(id, inputs);
        return { ok: true, runId };
      } catch (err) {
        // Closed reason codes ✓ (host-side wording must not leak to the card — it contains paths ✓)
        return { ok: false, reason: workflowReasonOf(err) };
      }
    },
    status: (runId: string) => {
      try {
        const status = workflowService.status(runId);
        // Ownership check ✓: does this card have permission for this workflow ✓
        // (contract §7.7: 'same as above' = this id is in
        // `permissions.workflows` ✓)
        const allowed =
          cards.registry
            .cards()
            .find((c) => c.cardId === cardId)?.manifest.permissions.workflows ?? [];
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
      // The permission area (implementation decision record ADR-D47 ✓): cards
      // writing to the board are forbidden by default ✓
      // → Whoever needs to write to the board turns that switch on in
      //   settings ✓ (once ✓ · no more pop-ups ✓)
      if (!permissions.allows('card', `action:${actionId}`)) {
        return { ok: false, reason: 'denied', actionId };
      }
      return invokeAction(action, params, {
        packId: runtime.packId ?? '',
        contractVersion: 'devboard/v1',
        // Which board is the board currently in use ✓ (the credential must be bound to it ✓ — contract `spec/04` §2.4.1 item six ✓)
        deviceKey: () => runtime.currentDeviceKey ?? '',
        hasExitCode: runtime.hasExitCode,
        // Execution and readback happen in the same exclusive transaction (spec decision SPEC-D22)
        runTransaction: (fn) => runtime.runTransaction(fn),
        readTag: (tag) => runtime.sampleTag(tag),
        granted: () => grantedFor(cardId),
        audit: (row) => actionAudit.append(row),
        actor: `card:${cardId}`,
      });
    },
  }),
  // Storage is not in the card root directories — fs.watch watches them, and every write triggers a hot refresh (a loop)
  storageDir: cardStorageDir(),
  // The layout is the host's ledger (which card sits in which cell) → it lands in the user data directory
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
    throw makeError('PACK_INVALID', `card instance not registered: ${id}`);
  }
  // v1 has only one connection context (contract §7.8: injected by the host)
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
 * The unified permission area (settings page ✓ · implementation decision
 * record ADR-D47 ✓).
 *
 * → Lists every operation plus who may use it ✓
 * → Changes one entry ✓ (idempotent ✓)
 */
/**
 * Workflow runs on the host side (contract `05` §8·A ✓).
 *
 * → Only the host can cancel ✓ (A4 ✓) → so this pair of channels exists
 *   only on the host side ✓ (there is no `workflows.cancel` in the card API ✓
 *   · and none in MCP either ✓)
 * → What the card sees is a reduced projection ✓ (`cards/workflow-view.ts` ✓)
 */
handle(IPC.workflowsRecent, () => workflowService.recent().map(toHostRun));
handle(IPC.workflowsCancel, (runId) => workflowService.cancel(String(runId)));

/**
 * The board connection wizard ✓ — host-only ✓ (neither cards nor agents can
 * reach it ✓).
 *
 * → A person takes part in exactly one step ✓ (choosing the serial port and
 *   the baud rate ✓) → everything else is automatic ✓.
 * → It writes to the user's directories ✓ (the connection profile ✓ + the
 *   board pack ✓) → so it is host-only ✓.
 */
handle(IPC.wizardRun, (input) =>
  runWizardForHost(
    {
      port: String((input as { port?: unknown }).port ?? ''),
      baudrate: Number((input as { baudrate?: unknown }).baudrate ?? 115200),
      boardName: String((input as { boardName?: unknown }).boardName ?? ''),
      transport:
        (input as { transport?: unknown }).transport === 'adb' ? 'adb' : 'serial',
    },
    {
      appRoot: app.getAppPath(),
      userProfilesDir: userProfilesDir(),
      userBoardsDir: userBoardsDir(),
      userDataDir: userDataDir(),
    },
  ),
);

handle(IPC.permissionsList, () => {
  const operations = permissionOperations();
  permissions.setKnown(operations);
  return permissions.rows(operations);
});
handle(IPC.permissionsSet, (actor, op, allowed) => {
  const key = String(op);
  // An operation that does not exist must not be settable ✓ (otherwise the ledger accumulates junk keys nobody can see ✓)
  if (!permissions.knows(key)) {
    throw makeError('IPC_INVALID_PAYLOAD', `no such operation: ${key}`);
  }
  permissions.set(String(actor) as PermissionActor, key, Boolean(allowed));
});

handle(IPC.themeSet, (theme) => {
  // The renderer remounts the card frames after switching, so the next
  // `cockpit://` response carries the new tokens (contract §6.2).
  shellTheme = theme === 'light' ? 'light' : 'dark';
  // The native window buttons sit on top of the canvas; recolour them too so
  // the top edge stays one surface in both themes.
  if (process.platform !== 'darwin') {
    for (const win of BrowserWindow.getAllWindows()) {
      win.setTitleBarOverlay(titleBarOverlay(shellTheme));
    }
  }
  return undefined;
});

/**
 * A card's CSP violation → its runtime log.
 *
 * The promise of contract §6.1: 'a browser CSP violation is recorded in the
 * card's runtime log, so an agent can see that this card tried to reach the
 * network'.
 *
 * Why not `console-message` (measured on Electron 34.5.8): for `connect-src` /
 * `script-src` violations that event's `sourceId` is an empty string → the
 * violation cannot be attributed to a card → exactly the 'tried to reach the
 * network' cases go uncaught.
 * → Instead the `securitypolicyviolation` event of the card document is used
 * (the listener the host injects, `__host/csp.js`) → attribution is exact by
 * construction.
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
 * Pick a connection profile that can be sampled and start the runtime with it.
 *
 * Try them one by one: the board may be on adb or on a serial port — the
 * first one that cannot connect (no board plugged into adb, the serial port
 * occupied) is not a failure, just move on to the next. If none works, go
 * through another round following the backoff schedule (a board plugged in
 * later must not leave the panels permanently empty).
 *
 * → **The fake board is not a candidate** ✓ — it is **synthetic data** ✓ →
 *   it must never take the role of a real board ✓ (it always connects ✓ →
 *   it wins the race ✓ → the runtime samples synthetic data ✓ and the
 *   interface shows the fake board as the board it is on ✗ — found on
 *   2026-11-21 ✓).
 *   → **Unless the fake board is the only one there is** ✓
 *   (`COCKPIT_FAKE=only` ✓) → then it is what the person asked for ✓.
 */
async function startTagRuntime(): Promise<void> {
  const fakeIds = new Set(fakeProfileIds(process.env));
  const candidates = pickCandidates(listProfiles()).filter(
    (candidate) => FAKE_MODE === 'only' || !fakeIds.has(candidate.profileId),
  );
  if (candidates.length === 0) {
    // No connection with a board pack: the panels will show 'no connection with a board pack'
    return;
  }
  await startWithRetry(runtime, candidates);
  // Rescan the cards once after connecting (or after the tries are over) ✓
  // (fixed 2026-11-19 ✓)
  //
  // → Cards are validated at startup ✓ → at that moment the board is not
  //   connected yet ✓ → rule 5 says the action is 'unverified' ✓ → the card
  //   stays 'degraded' ⚠️
  // → Rescanning after connecting ✓ makes the warning withdraw itself ✓
  //   (instead of relying on a restart ✓)
  cards.refresh();
}

/**
 * Register an invoke channel.
 *
 * The main process does not throw, it returns `{ok, error}`: Electron wraps
 * an error thrown in the main process as
 * `Error invoking remote method 'x': <original error>`.
 * If the original error is a plain object, `String(error)` is
 * `[object Object]` — the user sees `[object Object]` in the interface, and
 * the sentence 'the serial port COM3 is occupied' never reaches their eyes.
 *
 * So the error is flattened here into `{code, message, retryable, detail}`,
 * and the preload turns it back into an exception carrying the error code and
 * throws it to the renderer.
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
 * These two are channels without a return value (ipcMain.on): a thrown
 * exception has nobody to catch it and turns into an uncaught exception that
 * takes the main process down. So it is caught here and logged.
 *
 * Key presses are fire-and-forget — waiting for a round trip on every key
 * would make the terminal unusable.
 */
ipcMain.on(IPC.terminalWrite, (_e, sessionId: string, data: string) =>
  guard('terminalWrite', () => terminal.write(sessionId, data)),
);
ipcMain.on(IPC.terminalResize, (_e, sessionId: string, cols: number, rows: number) =>
  guard('terminalResize', () => terminal.resize(sessionId, cols, rows)),
);

// Closing a session goes through invoke: if it cannot be closed (the serial port is still occupied) the user has to be told, not just the console
handle(IPC.terminalClose, (sessionId) => terminal.close(String(sessionId)));

/** Wraps a call that may throw. The exception is only logged, it must not crash the main process. */
function guard(what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error(`[${what}] ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── The board setup (the values of this machine ✓) ──────────────────────
/**
 * **What does this machine see of the board?** ✓
 *
 * → It only looks ✓ — **nothing is written** ✓.
 * → The adb devices ✓ · the model the board reports ✓ · the address it
 *   reports about itself ✓ · the serial ports ✓ (**and which one answers**
 *   ✓ — that is the only honest way to tell the console from a device that
 *   happens to have a COM port ✓).
 * → **The board pack** the model belongs to ✓ (the pack is the authority on
 *   what its board calls itself ✓).
 */
handle(IPC.boardDetect, async () => {
  const devices = await listAdbDevices({ adbPath });
  const ready = devices.filter((device) => device.state === 'device');
  const serial = ready.length === 1 ? (ready[0]?.serial ?? null) : null;
  const model = serial === null ? null : await readBoardModel(serial, { adbPath });
  const address = serial === null ? null : await readBoardIPv4(serial, { adbPath });

  // → The ports of this machine ✓ (the native module may be missing ✓ → then
  //   there are simply no ports to offer ✓).
  let ports: { path: string; answered: boolean }[] = [];
  try {
    const all = await listHostPorts();
    const { answering } = await probeSerialPorts(all, 1500000, hostPortProbe, 600);
    ports = all.map((port) => ({ path: port.path, answered: answering.includes(port.path) }));
  } catch (err) {
    console.warn(`[board] the serial ports cannot be listed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const packs = listPacksIn([join(app.getAppPath(), 'profiles', 'boards'), userBoardsDir()]);
  const boardPack = model === null ? null : (packs.find((pack) => matchPack(pack, model))?.id ?? null);

  // → **The private keys of this machine** ✓ (the credential is a
  //   machine-specific value ✓ → the person says which one it is ✓).
  const sshKeys = readSshRecords(homedir()).keys.map((path) => ({
    path,
    name: basename(path),
  }));
  return { adbDevices: devices, model, address, ports, boardPack, sshKeys };
});

/**
 * **Write the values the person confirmed** ✓.
 *
 * → Into the **user directory** ✓ (the built-in profiles stay read-only ✓)
 *   → the user's copy wins ✓ (`profiles/loader.ts` ✓).
 * → **It replaces** ✓ — this is the person saying "this is my board" ✓ (the
 *   automatic repair never overwrites ✓).
 * → **Only the connections of that board pack** ✓ (the values belong to one
 *   board ✓ — the guest machine keeps its own address ✓).
 */
handle(IPC.boardApply, async (raw) => {
  const values = parseBoardValues(raw);
  const written: string[] = [];
  const kept: string[] = [];
  for (const profile of listProfiles()) {
    if (profile.board_pack !== values.boardPack) continue;
    const updated = applyValues(profile, values);
    const result = persistProfile(updated, userProfilesDir(), { overwrite: true });
    (result.written ? written : kept).push(profile.id);
  }
  console.log(`[board] the confirmed values were written: ${written.join(', ') || '(none)'}`);
  return { written, kept };
});

// ── File transfer ───────────────────────────────────────────────
handle(IPC.connectionsList, () =>
  listProfiles().map((p) => ({
    id: p.id,
    label: p.label,
    transport: p.transport,
    boardPack: p.board_pack ?? null,
    // This board's identifier ✓ (the physical board and the connection are two layers ✓ — contract `spec/02` §10.2 ✓)
    deviceKey: deviceKeyOf(p),
    // Is it the connection the runtime is currently using ✓ (that and 'is there a live connection' are two separate criteria ✓ — not conflated ✓)
    current: runtime.status.profileId === p.id,
    capabilities: capabilitiesFor(p),
  })),
);

/**
 * Switch to a given board ✓ (the interface's 'select board' ✓ — contract
 * `spec/02` §10.2 ✓).
 *
 * → The interface only lists boards ✓ → which connection to use is the
 *   host's choice ✓ (`profiles/device-select.ts` ✓)
 * → If it cannot connect, it reports an error ✓ — it never silently swaps in
 *   another board ✗ (that would be 'silently doing something else' ✗ — the
 *   user picked A and something else is actually connected ✗).
 * → Already on that board → no reconnect ✓ (a pointless reconnect drops the
 *   readings ✗).
 */
handle(IPC.devicesSelect, async (deviceKey) => {
  const key = String(deviceKey);
  const result = await selectDevice(listProfiles(), key, {
    start: (profile) => runtime.start(profile),
    currentProfileId: () => runtime.status.profileId ?? null,
  });
  if (result.ok) return;
  throw makeError(
    result.reason === 'not_found' ? 'IPC_INVALID_PAYLOAD' : 'CONN_OPEN_FAILED',
    result.detail,
    { detail: { deviceKey: key } },
  );
});

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
  // The host decides the local install location.
  // The renderer only knows the remote path, not where on the host it
  // should go; earlier the renderer passed an empty string while the host
  // comment said 'use the default install location', and that 'default
  // install location' did not exist at all — so the download button always
  // failed.
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
    // The shell draws its own top edge and the native title text is gone:
    // only the system window controls float over the canvas (see visual.css
    // `.window-drag`). The menu is removed in `whenReady`.
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(shellTheme),
    webPreferences: {
      // The preload's file name is not arbitrary: it matches what
      // electron-vite produces (`src/shared/build-layout.ts` is the single
      // source for it), and the self-check script at the end of
      // `npm run build` verifies that the file really exists.
      preload: join(__dirname, '../preload', PRELOAD_FILE),
      contextIsolation: true,
      nodeIntegration: false,
      // The renderer loads untrusted cards (the CSP no-network rule of
      // contract §6.1), so the sandbox is the last line of defence — it must
      // not be turned off in order to use an ESM preload.
      // An ESM preload needs `sandbox: false`, so preloads are always built
      // as CommonJS.
      sandbox: true,
    },
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    // The production shell also goes through `cockpit://app/` — the `'self'` source on `file://` matches nothing at all
    void win.loadURL('cockpit://app/index.html');
  }

  // Dragging a file into the window makes Electron navigate to that file by
  // default — the whole window is replaced by the file's content and the
  // application looks like it has crashed.
  // Block it; drag and drop is handled by the renderer's file browser.
  win.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL();
    if (url !== current) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  return win;
}

app.whenReady().then(async () => {
  // No File/Edit/View… strip under the title bar: the shell is the menu.
  Menu.setApplicationMenu(null);

  // The `cockpit://` handler (cards + shell)
  protocol.handle('cockpit', (request) => cards.protocol(request));

  // ⚠️ The fake device (only in debug builds)
  // A failure to load must not stop the app from starting — the fake device is
  // debugging scaffolding; if it breaks, the only consequence should be one
  // fewer board for the person debugging, not an application that will not
  // open.
  await loadFakeDevice().catch((err: unknown) => {
    console.error(`[FAKE] the fake device failed to load: ${err instanceof Error ? err.message : String(err)}`);
  });

  createWindow();

  // The MCP server (does not block the window from coming up ✓ — it is for agents ✓)
  void startMcpServer();

  // The readings runtime: it does not block the window from coming up —
  // failing to connect is normal (no board plugged in, the port occupied), and
  // the panels will show why.
  void startTagRuntime();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// The discovery file is deleted on quit ✓ (no discovery file pointing at a dead process ✓ — contract §7.2 ✓)
app.on('will-quit', () => {
  stopMcpServer();
});
