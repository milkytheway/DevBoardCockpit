/**
 * Every IPC channel between main and renderer.
 *
 * The channel names are collected here; main and preload share one
 * definition — a misspelled channel name is a compile-time error instead of
 * a silent failure at runtime.
 */

import type { AppErrorPayload } from './errors';
import type { TagReading } from './tag-reading';
import type { RuntimeStatus } from './runtime-status';
import type { LayoutState } from './layout';
import type { BoardApplyResult, BoardDetection, BoardValues } from './board-setup';

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
  /**
   * The link that carries the files ✓.
   *
   * → **The file page does not need an open terminal** ✓ → the host picks
   *   the link itself ✓ (ADB → SSH → serial ✓) → this channel asks for it
   *   ✓ and the host **probes** the candidates ✓ (the previous one that is
   *   not there ✓ → the next one ✓).
   */
  filesEndpoint: 'files:endpoint',
  connectionsList: 'connections:list',
  /**
   * Switch to a given board (the board picker of the UI — the physical
   * board and the connection are two separate layers).
   *
   * → The UI lists boards only; the host picks which connection backs them
   *   (the user clicks a board, not a connection).
   * → v1 has a single connection (`O11` / `O18`), so picking a board means
   *   switching to another board
   * → it does not mean showing several boards at once (that is M8 — a
   *   separate discussion).
   */
  devicesSelect: 'devices:select',
  devicesDelete: 'devices:delete',
  /**
   * The current snapshot of the tag readings.
   *
   * Why there is a "take a snapshot" call and not only "listen for pushes":
   * a window that subscribes late misses the earlier pushes — what it sees
   * when it opens should be the readings as they are now and not a blank
   * page (contract section 2.1: readings have the five states and a seq,
   * they are a snapshot of the current state by nature).
   */
  tagsReadings: 'tags:readings',
  /** The push for a change of a tag reading */
  tagsChanged: 'tags:changed',
  /**
   * The state of the tag runtime (is it connected / why is it not).
   *
   * Why it is a channel of its own: `tags:readings` carries readings only
   * — the reason why not a single number is available never reaches the
   * panel, and the panel can only say generically that there are no
   * readings yet. "The board is not plugged in" and "waiting for a sampling
   * interval" are two different things, and the first one never gets better
   * no matter how long you wait.
   */
  tagsStatus: 'tags:status',
  /** The installed cards (the page renders the card area from them) */
  cardsList: 'cards:list',
  /** A card instance has connected (main opens a session for it) */
  cardsHello: 'cards:hello',
  /** One request from a card → main (the permission decision is made in main) */
  cardsRequest: 'cards:request',
  /**
   * A CSP violation in one card → main (it goes into the runtime log of
   * that card).
   *
   * Why it is a channel of its own: it is not a card API — it is reported
   * by the listener script the host injects (`__host/csp.js`) inside the
   * card's own document. A card that forges one can only pollute its own
   * log.
   */
  cardsCsp: 'cards:csp',
  /** main → card (pushed to one instance) */
  cardsEvent: 'cards:event',
  /** The installed cards changed (hot plug) — the page fetches the manifest again */
  cardsChanged: 'cards:changed',
  /** Reads the layout (which card sits in which cell) */
  layoutGet: 'layout:get',
  /** Stores the layout (after a drag) */
  layoutSet: 'layout:set',
  /**
   * The shell theme (dark/light).
   *
   * Why it has to go through main: the tokens of a card iframe are injected
   * by the protocol handler when it answers `cockpit://`; changing a
   * document attribute in the renderer only changes the shell itself. The
   * theme lives in main, so a card that is mounted again picks up the new
   * `theme.css`.
   */
  themeSet: 'theme:set',
  /**
   * The unified permission area (the table on the settings page ·
   * implementation-layer decision record ADR-D47).
   *
   * → It lists every operation and who may use it.
   */
  permissionsList: 'permissions:list',

  /** Changes one entry (`actor` × `op` × `allowed`) */
  permissionsSet: 'permissions:set',

  /**
   * The recent workflow runs (including the ones still running — the shell
   * shows "running" from them).
   *
   * → Host-side only (contract `docs/spec/05-workflow-pack.md` section 8·A,
   *   item A4: only the host may cancel)
   * → Neither cards nor agents get this copy (a card sees a reduced
   *   projection)
   */
  workflowsRecent: 'workflows:recent',
  /**
   * Cancels one workflow run.
   *
   * → Only the host may cancel: neither cards nor agents have this
   *   interface (contract A4: the agent does not get to decide what is
   *   allowed, and it does not get to decide what gets stopped either —
   *   otherwise the agent would have a channel for deciding on its own not
   *   to act, which puts a bypass into the chain where the human nods)
   * → It is idempotent: cancelling a run that has already finished does not
   *   change a single character of its state (contract A5)
   * → It does not promise that the process really dies (contract A1 — that
   *   depends on the transport and the far end)
   */
  workflowsCancel: 'workflows:cancel',

  /**
   * The board-setup wizard — it runs the wizard once (see the wizard design
   * note in the implementation-layer exploration notes).
   *
   * → The human takes part in one step only: picking the serial port and
   *   the baud rate; everything else is automatic.
   * → Host-only: neither cards nor agents can reach it (it writes into the
   *   user's directories).
   */
  wizardRun: 'wizard:run',

  /**
   * **What does this machine see of the board?** ✓
   *
   * → The published connection profiles carry **placeholders** ✓ → the
   *   person has to see what was found ✓ (the adb devices ✓ · the address
   *   the board reports ✓ · the serial ports ✓) → and to say which one is
   *   right ✓ when there is more than one candidate ✓.
   */
  boardDetect: 'board:detect',
  /**
   * **Write the confirmed values** ✓.
   *
   * → It writes into the **user directory** ✓ (the built-in profiles stay
   *   read-only ✓) → the user's copy wins ✓.
   * → **It replaces what is there** ✓ — this is the person saying "this is
   *   my board" ✓ (the automatic repair never overwrites ✓).
   */
  boardApply: 'board:apply',
} as const;

/**
 * One workflow run as the host sees it (the host is trusted — it sees the
 * complete copy).
 *
 * → This shape has to be declared in the contract layer: preload is not
 *   allowed to import modules of main (the layering, AGENTS.md section 5),
 *   so it cannot be a type of `main/workflows/service.ts`.
 */
export interface HostWorkflowRun {
  runId: string;
  workflowId: string;
  /** The four states (`running` / `done` / `failed` / `cancelled` — contract A2) */
  state: 'running' | 'done' | 'failed' | 'cancelled';
  /** The current step (`null` when nothing is in flight — contract B1) */
  current: { stepId: string; kind: string; at: number } | null;
  /** The moment it started (milliseconds UTC) */
  startedAt: number;
  /** The produced slots */
  outputs: Record<string, string>;
}

/**
 * The result of a finished wizard run — host-only.
 *
 * → kind has four values: they are different failures and the fixes differ
 *   completely — `ok`; `port-unopenable` (the serial port cannot be
 *   opened); `no-reply` (the board said nothing); `connection-dead` (not a
 *   single number came out — that means the connection never came up at
 *   all).
 * → "The board said nothing" and "cannot connect" are two different things
 *   and must not be merged in the wording.
 */
export interface WizardRunResult {
  /** Whether it worked */
  ok: boolean;
  /** Which situation it is now */
  kind:
    | 'ok'
    | 'port-unopenable'
    | 'no-reply'
    | 'connection-dead'
    /**
     * **The connection could not be opened** ✓ — and it is **not** a serial
     * port ✓ (the ADB line has no port ✓).
     *
     * → The wording has to name the transport that failed ✓ — "the serial
     *   port cannot be opened" for an ADB failure is a lie ✓ (found on
     *   2026-11-22 ✓).
     */
    | 'connection-failed';
  /** One sentence (plain language — do not merge "connection failed" and "the board said nothing" into one sentence) */
  message: string;
  /** What to check next (an empty array means there is nothing to warn about) */
  hints: string[];
  /** How many meta operations are available (what this board has) */
  greenCount: number;
  /** How many are unavailable */
  redCount: number;
  /** Where the pack landed (only present on success) */
  installedDir?: string;
  /** The id of this board (only present on success) */
  boardId?: string;
}

/** Who may execute an operation (card / agent) */
export type PermissionActor = 'card' | 'agent';

/** One row of the permission area on the settings page */
export interface PermissionRow {
  /** The key of the operation (`action:backlight.set`) */
  op: string;
  /** The display name */
  label: string;
  /** The category (`action` / `workflow` / `host`) */
  kind: 'action' | 'workflow' | 'host';
  /** The explanation inside this category (plain language) */
  hint?: string;
  /** The danger level: `destructive` is not covered by a blanket permission (it has to be enabled entry by entry) */
  danger?: 'reversible' | 'destructive';
  /** Whether a card may use it */
  card: boolean;
  /** Whether an agent may use it */
  agent: boolean;
}

/** One instance of a card */
export interface CardInstanceInfo {
  instanceId: string;
  cardId: string;
  /** The entry address of the card (`cockpit://card/<instance id>/<entry>`) */
  url: string;
  connectionId: string | null;
  /** Whether this card has missing capabilities (degraded) */
  degraded: boolean;
  /**
   * The default size the card reports for itself (the `layout.w/h` of the
   * manifest).
   *
   * Why it is needed: when the page places the card into the main area it
   * has to know how large it should be — the manifest expresses the
   * author's intent and only the host can read it, so the host carries it
   * out here.
   */
  layout?: { w: number; h: number; min_w?: number; min_h?: number };
}

/** One request from a card */
export interface CardRequest {
  instanceId: string;
  /** The request id (echoed back verbatim in the response) */
  id: string;
  /** The full name, e.g. `tags.get` */
  method: string;
  args: unknown;
}

/** The response to one request from a card */
export interface CardResponse {
  id: string;
  ok: boolean;
  value?: unknown;
  reason?: string;
}

/**
 * The details of one CSP violation.
 *
 * Pure data (all the conventions of the cross-process boundary live in this
 * file). The fields come from the DOM `SecurityPolicyViolationEvent`.
 */
export interface CardCspViolation {
  /** What it wanted to access (an inline script is `inline`) */
  blockedURI: string;
  /** The directive that was violated (e.g. `connect-src`) */
  effectiveDirective: string;
  /** The concrete form that was violated (the specific form of `effectiveDirective`) */
  violatedDirective: string;
  /** The file that triggered the violation (the card's own URL) */
  sourceFile: string;
  /** The line number (0 = none) */
  lineNumber: number;
  /** The offending piece of code (as the browser reports it, possibly empty) */
  sample: string;
}

/**
 * Validates the details of one CSP violation.
 *
 * Why it exists: this data comes from the card (a card is an arbitrary web
 * page written by an AI) — before it crosses the process boundary it has to
 * be narrowed to a closed shape, otherwise main would receive anything at
 * all.
 *
 * @returns `null` when it does not qualify (never guess — the contract's
 * "never guess" stance)
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
 * The return value of every invoke channel.
 *
 * Why it is wrapped in an `ok`: when the main process throws, Electron wraps
 * the error into `Error invoking remote method 'x': <original error>`. If
 * the original error is a plain object, `String(error)` is `[object Object]`
 * — the user sees `[object Object]` and the sentence "serial port COM3 is
 * busy" never reaches the screen.
 *
 * So the main process does not throw; it returns
 * `{ok:false, error:{code,message,…}}`, and preload turns that back into an
 * exception carrying the error code and throws it to the renderer. The
 * error code therefore survives the IPC boundary and the renderer can
 * branch on `code`.
 */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: AppErrorPayload };

/**
 * The host capabilities that cards and the renderer can reach.
 *
 * When a method is added, register the channel name in the `IPC` object
 * above at the same time.
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
  /**
   * The link that carries the files ✓ — the host picks it ✓
   * (ADB → SSH → serial ✓).
   *
   * → **The id is the key of the connection table of the host** ✓ — the
   *   `files:list` / `files:push` / `files:pull` take it ✓.
   */
  filesEndpoint(): Promise<FileEndpointInfo>;
  connectionsList(): Promise<ConnectionInfo[]>;
  /**
   * Switch to a given board (the board picker of the UI).
   *
   * → If it cannot connect, it reports an error; it must not silently
   *   switch to another board, because that would be silently doing
   *   something else.
   * → What it hands over is the identity of the board (`device_key`), not
   *   the connection id.
   */
  devicesSelect(deviceKey: string): Promise<void>;
  /** Removes a user-added board. Shipped boards are protected by the host. */
  devicesDelete(deviceKey: string): Promise<BoardDeleteResult>;
  /**
   * A snapshot of all current tag readings.
   *
   * The readings only come out through TagStore (implementation-layer
   * decision record ADR-D22) — the renderer cannot get a copy from
   * anywhere else.
   */
  tagsReadings(): Promise<TagReading[]>;
  /**
   * Listens for changes of the readings.
   *
   * @returns The unsubscribe function.
   */
  onTagChanged(cb: (reading: TagReading) => void): () => void;
  /**
   * Gets the state of the runtime (is it connected / why is it not).
   *
   * The panel relies on it to speak plainly: when there are no readings,
   * "cannot connect: serial port COM3 is busy" and "waiting for a sampling
   * interval" are two different things.
   */
  tagsStatus(): Promise<RuntimeStatus>;
  /** The installed cards */
  cardsList(): Promise<CardInstanceInfo[]>;
  /** A card instance has connected (main opens a session for it) */
  cardsHello(instanceId: string): Promise<void>;
  /** One request from a card (the permission decision is made in main) */
  cardsRequest(req: CardRequest): Promise<CardResponse>;
  /** Reads the layout */
  layoutGet(): Promise<LayoutState>;
  /** Stores the layout */
  layoutSet(state: LayoutState): Promise<void>;
  /**
   * The unified permission area (the settings page · implementation-layer
   * decision record ADR-D47).
   *
   * → One row per operation and two kinds of executor (card / agent)
   * → Writing to the board from a card is forbidden by default (C2); the
   *   person who wants to write to the board turns it on in the settings.
   */
  permissionsList(): Promise<PermissionRow[]>;
  /** Changes one entry (idempotent) */
  permissionsSet(actor: PermissionActor, op: string, allowed: boolean): Promise<void>;
  /**
   * The recent workflow runs (including the ones still running).
   *
   * → Host-side only (contract `docs/spec/05-workflow-pack.md` section 8·A,
   *   item A4): neither cards nor agents can reach it.
   */
  workflowsRecent(): Promise<HostWorkflowRun[]>;
  /**
   * Cancels one workflow run (contract `docs/spec/05-workflow-pack.md`
   * section 8·A).
   *
   * → It is idempotent: cancelling a run that has already finished does not
   *   change a single character of its state (A5).
   * → It does not promise that the process really dies (A1) — the transport
   *   has the last word.
   */
  workflowsCancel(runId: string): Promise<{ runId: string }>;

  /**
   * The board-setup wizard (see the wizard design note in the
   * implementation-layer exploration notes).
   *
   * ── The human takes part in one step only ──
   *
   * → port = the serial port name (picked by hand — no automatic
   *   enumeration; the user has already decided)
   * → baudrate = the baud rate (not probed — the user has already decided)
   * → boardName = what this board is called (the name given to the pack)
   *
   * → Host-only: neither cards nor agents can reach it.
   */
  /**
   * Detects what this machine can see of the board ✓.
   *
   * → **It only looks** ✓ — nothing is written ✓.
   */
  boardDetect(): Promise<BoardDetection>;
  /**
   * Writes the confirmed values into the user directory ✓.
   *
   * → **It replaces** ✓ — this is the person saying "this is my board" ✓.
   */
  boardApply(values: BoardValues): Promise<BoardApplyResult>;
  wizardRun(input: {
    port: string;
    baudrate: number;
    boardName?: string;
    /** Which transport to use — the default is serial */
    transport?: 'serial' | 'adb';
  }): Promise<WizardRunResult>;
  /** Tells main about the shell theme: a card that reloads gets the matching tokens */
  setTheme(theme: 'dark' | 'light'): Promise<void>;
  /** A CSP violation in one card → main (it goes into the runtime log of that card) */
  cardsCsp(instanceId: string, detail: CardCspViolation): Promise<void>;
  /**
   * Listens to the pushes of main (reading changes and the like).
   *
   * @returns The unsubscribe function.
   */
  onCardEvent(cb: (instanceId: string, payload: unknown) => void): () => void;
  /**
   * Listens for "the installed cards changed" (hot plug).
   *
   * @returns The unsubscribe function.
   */
  onCardsChanged(cb: () => void): () => void;
  /**
   * Gets the host absolute path of a File.
   *
   * Since Electron 32 `File.path` has been removed; the supported way is
   * `webUtils.getPathForFile(file)` — it can only be called in the renderer
   * process or in preload, so preload proxies it.
   *
   * Passing `file.name` (the basename only) does not work: it would make
   * the host look for a file of that name in its own CWD — which either
   * fails or transfers a different file (a data safety problem).
   */
  getPathForFile(file: File): string;
}

/** One usable connection: a summary of the profile plus its capability bits */
/**
 * **The link that carries the files** ✓ — what the host picked ✓.
 *
 * → The file page asks for it ✓ and does not need an open terminal ✓.
 * → **Which link it is** ✓ (ADB ✓ · SSH ✓ · serial ✓) — the person sees it ✓
 *   (a transfer that goes somewhere else is a surprise ✗).
 */
export interface FileEndpointInfo {
  /** The id in the table of connections of the host ✓ (the transfer takes it ✓) */
  id: string;
  /** The profile it uses ✓ */
  profileId: string;
  /** The name of the connection ✓ */
  label: string;
  /** The channel it is ✓ */
  transport: TransportKind;
  /** The capability bits of the connection ✓ (the file browser needs them ✓) */
  capabilities: ConnectionCapabilities;
}

export interface ConnectionInfo {
  id: string;
  label: string;
  transport: TransportKind;
  boardPack: string | null;  /**
   * The identity of this board (the physical board and the connection are
   * two separate layers — contract `docs/spec/02-board-pack.md` section
   * 10.2).
   *
   * → Several connections to the same board carry the same value, and the
   *   UI groups by board because of it.
   */
  deviceKey: string;
  /**
   * Whether it is the connection the runtime currently uses.
   *
   * → This is a different criterion from "is there a live connection", and
   *   the two are not mixed up: an open terminal session counts as a live
   *   connection, but it is not the one the runtime uses.
   */
  current: boolean;
  /** Whether this board was added by the user and may be deleted. */
  deletable?: boolean;
  capabilities: ConnectionCapabilities;
}

export interface BoardDeleteResult {
  deviceKey: string;
  removedProfiles: string[];
  removedPack: boolean;
}

/** The kind of transport. Defined in shared — main and renderer both need it and must not each keep a copy */
export type TransportKind = 'serial' | 'adb' | 'ssh' | 'local';

/**
 * The connection-level capability bits. The UI degrades by capability, not
 * by transport name.
 *
 * It is defined in shared rather than in main/hal — the renderer needs it
 * to decide whether the file browser entry has to be disabled, but the
 * renderer must not import main.
 *
 * ── Why it is called "connection level" and not just "capabilities" ──
 *
 * The contract layer (`docs/spec/02-board-pack.md` section 10.3) has
 * another vocabulary of board-level capabilities (`shell` / `exec` /
 * `stream` / `files`). That is not the same axis: the board level says
 * what this board can do, the connection level says what this connection
 * can do. A serial port cannot transfer files (device fact S7), but the
 * board of course has a file channel — the same word, two meanings.
 *
 * That is why it must be called `ConnectionCapabilities` here: colliding
 * names would merge the two vocabularies into one (implementation-layer
 * decision record ADR-D24). The table comparing the board level with the
 * connection level is in `docs/spec/02-board-pack.md` section 10.3.2.
 */
export interface ConnectionCapabilities {
  /** Can run one command and get a result */
  exec: boolean;
  /** Can open an interactive terminal (a real pty, with echo and ANSI) */
  pty: boolean;
  /** Can transfer files */
  files: boolean;
  /** Whether exec can return an exit code. False for serial (device fact S5) */
  exitCode: boolean;
}

/** One entry in a remote directory */
export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  sizeBytes: number | null;
  modifiedAt: string | null;
}
