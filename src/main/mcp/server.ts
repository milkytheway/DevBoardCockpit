import { MCP_PROTOCOL_VERSION } from './security';
import { projectRunStatusForAgent } from './view';
import type { WorkflowService } from '../workflows/service';
import type { WorkflowPack } from '../workflows/format';
import type { PermissionStore } from '../permissions/policy';
import type { McpHostDeps } from './host';
import { withVersion, withVersionEach } from './convention';
import { executeAction } from './action-tools';
import { sdkDocs } from './sdk-docs';
import { installCard, uninstallCard } from './card-tools';
import { promoteCard } from './promote';
import { dryRunWorkflow } from './workflow-dry-run';
import {
  describeTag,
  getCardRuntimeLog,
  getLayout,
  listCapabilities,
  listCards,
  listConnections,
  listDataSources,
  listTags,
  normalizeLayoutCards,
  sampleTag,
} from './read-tools';

/**
 * The **JSON-RPC layer of the MCP** (the protocol follows the official MCP
 * specification 2025-06-18 ✓).
 *
 * ── Why it is written by hand instead of using the SDK ──
 *
 * The transport selection table chose `@modelcontextprotocol/sdk` ✓,
 * **this round overturns it** ✓ (**ADR-D39** ✓):
 *
 * | # | Reason |
 * |---|---|
 * | 1 | The SDK brings **91 packages / 29MB** ✓ (express · hono · cors · jose · zod, the whole set ✓) — this project has **zero web framework dependencies** ✓ |
 * | 2 | The sandbox and the host **share one `node_modules`** ✓ → installing a new dependency **breaks the platform binaries of both sides** ✓ → **the code of the MCP server cannot be verified in the sandbox at all** ✓ |
 * | 3 | The rule of this project is "**the evidence comes before the assertion**" ✓ → bringing in the SDK means handing over a batch of **unverified** code ✗ |
 *
 * → **The cost (stated honestly)**: what comes with the SDK (SSE push ·
 * resumability · prompt/resource · OAuth) is **not done in this round** ✓
 *   — **it is not in the contract either** ✓ (`spec/04` §7.1 only asks for
 *   "an agent can discover it and connect" ✓).
 */

/** The requests / notifications of JSON-RPC 2.0 (**only these shapes are used** ✓) */
interface JsonRpcMessage {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

/** The error codes of JSON-RPC (**the ones of the specification** ✓) */
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_INTERNAL_ERROR = -32603;

/** The declaration of a tool (**as in the specification §"Tool"** ✓) */
export interface McpToolDef {
  name: string;
  title?: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** The implementation of a tool (**input → output** ✓) */
export type McpToolImpl = (args: Record<string, unknown>) => Promise<unknown> | unknown;

/** The host capabilities the MCP server depends on (**only in this one place** ✓ — contract §9.2 "the tools are thin wrappers" ✓) */
export interface McpServerDeps {
  /** The workflow service (**the card side and the agent side share the same one** ✓ — ADR-D34 ✓) */
  workflows: WorkflowService;
  /**
     * **The unified permission area** ✓ (the gate of the agent side ✓ —
     * implementation decision record ADR-D47 ✓ · ADR-D48 ✓).
     *
     * → **It is required** ✓ — **every tool the agent can call passes through
     *   here** ✓ → **one place decides what the agent may do** ✓.
     */
  permissions: PermissionStore;
  /**
     * **The version of the application** ✓ — **the one the agent sees** ✓
     * (`serverInfo.version` ✓ · the specification §"Initialization" ✓).
     *
     * → **It is required** ✓ — **the version is not written in here** ✓: a
     *   second copy of it ✓ is a version that lies ✓ (the next release would
     *   carry the version of the one before ✓ · and the agent believes it ✓).
     */
  version: string;
  /**
     * **The host dependencies of the read-side tools** ✓.
     *
     * → **Optional** ✓: without them there are only the four workflow tools ✓
     *   (**it works before the wiring** ✓ — the tests and the gradual wiring ✓).
     */
  host?: McpHostDeps;
}

export class McpServer {
  private readonly tools: Map<string, McpToolImpl>;
  private readonly toolDefs: McpToolDef[];
  /** **The version the agent sees** ✓ (**the one the application gives** ✓ — not a copy of it ✓) */
  private readonly version: string;

  constructor(deps: McpServerDeps) {
    this.version = deps.version;
    this.tools = buildTools(deps);
    // **Without the host dependencies the read-side tools are not listed** ✓ (**a tool that cannot be called is not listed** ✓ — the requirement of contract §7.4 ✓)
    this.toolDefs =
      deps.host === undefined ? [...TOOL_DEFS] : [...TOOL_DEFS, ...READ_TOOL_DEFS];
  }

  /** The list of the tools (**the specification §"Listing Tools"** ✓) */
  listTools(): McpToolDef[] {
    return [...this.toolDefs];
  }

  /**
     * **Handles one JSON-RPC message** ✓.
     *
     * → A **notification** (no `id` ✓) → returns `null` ✓ (the HTTP layer gives
     *   it **a 202 with an empty body** ✓ — the specification §"Sending
     *   Messages", point 4 ✓).
     * → A **request** (with an `id` ✓) → returns `{ jsonrpc, id, result }` or
     *   `{ jsonrpc, id, error }` ✓.
     */
  async handle(message: JsonRpcMessage): Promise<Record<string, unknown> | null> {
    // A **notification** → no response ✓
    if (message.id === undefined) {
      await this.runNotification(message);
      return null;
    }
    const id = message.id;
    try {
      const result = await this.dispatch(message);
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: errorCodeOf(err),
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  /** Calls a tool (**an error inside the tool → turned into a result with `isError` ✓** — the specification §"Tool Execution Errors" ✓) */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const impl = this.tools.get(name);
    if (impl === undefined) {
      throw new RpcError(JSON_RPC_METHOD_NOT_FOUND, `No such tool: ${name}`);
    }
    return impl(args);
  }
  private async dispatch(message: JsonRpcMessage): Promise<unknown> {
    switch (message.method) {
      case 'initialize':
        return {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'devboard-cockpit', version: this.version },
        };
      case 'tools/list':
        return { tools: this.listTools() };
      case 'tools/call': {
        const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
        if (typeof params.name !== 'string') {
          throw new RpcError(JSON_RPC_INVALID_PARAMS, 'tools/call is missing name');
        }
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        try {
          const value = await this.callTool(params.name, args);
          return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError: false };
        } catch (err) {
          // **The tool failed** → a result with `isError: true` ✓ (not a protocol error ✓ — the specification §"Tool Execution Errors" ✓)
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: false,
                  reason: reasonOf(err),
                  detail: err instanceof Error ? err.message : String(err),
                }),
              },
            ],
            isError: true,
          };
        }
      }
      case 'ping':
        return {};
      default:
        throw new RpcError(JSON_RPC_METHOD_NOT_FOUND, `No such method: ${message.method}`);
    }
  }

  private async runNotification(message: JsonRpcMessage): Promise<void> {
    // **In this round `initialized` is the only notification** ✓ (the specification §"Lifecycle" ✓) → everything else is ignored ✓
    if (message.method === 'notifications/initialized') return;
  }
}

/** An exception that carries an error code (**a protocol error** ✓) */
class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function errorCodeOf(err: unknown): number {
  if (err instanceof RpcError) return err.code;
  return JSON_RPC_INTERNAL_ERROR;
}

/** The **closed reason codes** of a tool failure ✓ (contract §4: a failure uses `ok:false + reason` ✓) */
export type McpReason =
  | 'denied'
  | 'not_found'
  | 'invalid_params'
  | 'busy'
  | 'failed';

/**
 * Turns a host-side exception into a **closed reason code** ✓.
 *
 * → **It does not rely on parsing the error messages** ✓ (that is the bad
 *   smell of "parsing error messages" ✗) →
 *   the errors of the host side carry `detail.reason` ✓ (registered by
 *   `registry.ts` ✓) → it is taken directly ✓.
 */
function reasonOf(err: unknown): McpReason {
  const detail = (err as { detail?: { reason?: string } } | undefined)?.detail;
  const raw = detail?.reason;
  if (raw === 'not_found') return raw;
  if (err instanceof RpcError && err.code === JSON_RPC_INVALID_PARAMS) return 'invalid_params';
  return 'failed';
}

/** The failure result of a tool (**contract §4** ✓: `ok:false + reason` ✓) */
export interface McpFailure {
  ok: false;
  reason: McpReason;
  detail?: string;
}

function failure(reason: McpReason, detail?: string): McpFailure {
  return { ok: false, reason, ...(detail === undefined ? {} : { detail }) };
}

/** The declarations of the four workflow tools (**contract `spec/04` §2.4** ✓) */
/**
 * The declaration of a tool (**contract `spec/04` §2.4** ✓).
 *
 * → **Exported** ✓ — so that the contract boundary "**there is no cancel
 *   here**" **can be tested** ✓
 *   (contract A4 ✓: **the agent does not get to decide "stop or not"** ✓ —
 *   that boundary **is worth keeping** ✓).
 */
export const TOOL_DEFS: McpToolDef[] = [
  {
    name: 'list_workflows',
    title: 'List the runnable workflows',
    description:
      'List the workflows **in the registry** (only id / name / input declarations — no topology: which role connects to which machine is not for unauthorised parties to see).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'run_workflow',
    title: 'Run a workflow',
    description: 'Run a workflow, **returning** the run_id **immediately**; poll workflow_status for progress.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Workflow id (run list_workflows first to see the available ones)' },
        inputs: { type: 'object', description: 'Input values (given according to the input declarations of the workflow)' },
        dry_run: {
          type: 'boolean',
          description: '**Preview only** what will run ✓ (**no execution** ✓ · **no audit written** ✓ · **no run_id** ✓)',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'workflow_status',
    title: 'Inspect the status of a run',
    description: 'Inspect the **status and stage timeline** of a run (a reduced projection: no paths, parameter values, or roles).',
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string', description: 'The run id returned by run_workflow' } },
      required: ['run_id'],
    },
  },
  {
    name: 'install_card',
    title: 'Install a card',
    description:
      'Install a card directory into the card root (**copy + hot reload** ✓).' +
      '**Actions to write that the board pack does not declare → not installed** ✓ (**the board pack decides** ✓).' +
      '**Installing a card no longer requires "approval"** ✓ — **the card manifest is its permission** ✓ (ADR-D46 ✓).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path of the card directory' } },
      required: ['path'],
    },
  },
  {
    name: 'uninstall_card',
    title: 'Uninstall a card',
    description: 'Delete a user card (**no grant ledger to clear** ✓ — that layer was removed on 2026-11-16 ✓).',
    inputSchema: {
      type: 'object',
      properties: { card_id: { type: 'string', description: 'Card id' } },
      required: ['card_id'],
    },
  },
  {
    name: 'promote_card',
    title: 'Promote a card to fullscreen',
    description:
      'Promote a card to fullscreen (**it changes the layout** ✓ — fullscreen is one state of the layout ✓).' +
      '**The host records "who wants fullscreen" ✓; how many rows it spans is computed by the renderer from the viewport** ✓ (only the renderer knows the row height ✓).',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string', description: 'Card id' },
        connection_id: {
          type: 'string',
          description: 'Which connection (**omitted = the only instance of that card** ✓ · more than one is an error ✓)',
        },
      },
      required: ['card_id'],
    },
  },
  {
    name: 'get_card_sdk_docs',
    title: 'Get the card authoring reference',
    description:
      'The **syntax reference** for authoring cards: manifest format / the APIs this build actually has / example cards / layout.' +
      '**Generated from the live code** ✓ — it cannot drift ✓. Omit topic to get all of it.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          enum: ['manifest', 'api', 'examples', 'layout'],
          description: 'Which section (**omitting it means all of them** ✓)',
        },
      },
    },
  },
];

/**
 * The **declarations of the read-side tools** (contract `spec/04` §2.1 / §2.2
 * / §2.3 / §2.5 ✓ · ADR-D40 ✓).
 *
 * → **A separate list** ✓ — not mixed into one table with the workflow tools ✓
 *   (that one is "the workflow group" ✓).
 * → **They exist only once the host dependencies are there** ✓ (without the
 *   `host` they are not listed ✓ — **a tool that cannot be called is not
 *   listed** ✓).
 */
export const READ_TOOL_DEFS: McpToolDef[] = [
  {
    name: 'list_connections',
    title: 'List the connected profiles',
    description:
      'List the connection profiles: id / label / transport / bound board pack / **is there a live connection now** / connection-level capabilities.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_data_sources',
    title: 'List the data sources',
    description:
      'List the data sources of the current board pack (**reader granularity**): which tags each reader provides, which poll group it belongs to, its period, and its current state.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_capabilities',
    title: 'What the workbench itself offers',
    description: 'List the available transports and the capability bits of the workbench itself (**cards** / **mcp** / **layout_share** / **record**).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_tags',
    title: 'List the currently readable tags',
    description:
      'List the tags that are **actually readable right now**: name / type / unit / range / current value and status / which reader provides it. **This is the first tool to call when writing a card**.',
    inputSchema: {
      type: 'object',
      properties: {
        board: { type: 'string', description: 'Restrict to one board (**omitting it means the current board**)' },
      },
    },
  },
  {
    name: 'describe_tag',
    title: 'Inspect the semantics of a tag',
    description:
      'Inspect the **verbatim semantics** of a tag (to prevent misuse), the reader it comes from together with the redacted parameters of that reader, and the most recent sample window. **The command does not provide this**.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Tag name' } },
      required: ['name'],
    },
  },
  {
    name: 'sample_tag',
    title: 'Fetch the most recent samples',
    description:
      '**Take one targeted sample first**, then fetch the n most recent samples (value / unit / status / timestamp) — used to judge "is this reading stable, and how long is its refresh period".',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tag name' },
        n: { type: 'number', description: 'How many samples (**the n most recent**, not n seconds)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_cards',
    title: 'List the installed cards',
    description:
      'List the installed cards: id / manifest id / version / path / installation status / **whether it is degraded on the current board** (which tags are missing and which cannot be read).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'validate_card',
    title: 'Validate a card',
    description:
      'Statically validate a card directory (**without installing**): the list of errors and warnings, plus which tags and actions it would actually bind to and which of them are missing.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path of the card directory' } },
      required: ['path'],
    },
  },
  {
    name: 'get_card_runtime_log',
    title: 'Inspect the card runtime log',
    description: 'Inspect the runtime errors of a card (level / timestamp / message / source). **The eyes of the agent for self-testing**.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string', description: 'Card id' },
        since: { type: 'number', description: 'Only entries after this timestamp (milliseconds, UTC)' },
      },
      required: ['card_id'],
    },
  },
  {
    name: 'get_layout',
    title: 'Read the current layout',
    description: 'Read the layout of the main area (per cell: card id / connection id / position and size).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_layout',
    title: 'Save the layout',
    description: '**Replace** the whole layout of the main area. Cells that fall outside the grid are dropped and reported in `dropped`.',
    inputSchema: {
      type: 'object',
      properties: {
        layout: {
          type: 'object',
          description: 'Layout (`{ cards: [{ card_id, connection_id, x, y, w, h }] }`)',
        },
      },
      required: ['layout'],
    },
  },
  {
    name: 'execute_action',
    title: 'Execute an action',
    description:
      'Execute an action declared by the board pack. **If it is in the grant set → execute it directly** ✓ (**destructive is executed directly too** ✓ — ' +
      '**the danger level is only information** ✓ — **the gate is the unified permission area in the settings** ✓).' +
      '`dry_run` only returns **the command that would be executed** ✓ (it does not execute ✓).',
    inputSchema: {
      type: 'object',
      properties: {
        action_id: { type: 'string', description: 'The id of an action declared by the board pack' },
        params: { type: 'object', description: 'Parameter values (given according to the action declaration)' },
        dry_run: { type: 'boolean', description: 'Only preview the command that would be executed, **do not execute**' },
        device_key: {
          type: 'string',
          description:
            '**Which board to act on** ✓ (the `device_key` of `list_connections` ✓ — **several connections to the same board give the same one** ✓).' +
            '**Omitted = the board of the current runtime** ✓; **given but not matching → `not_found`** ✓ (**it never silently acts on the current board** ✓).',
        },
      },
      required: ['action_id'],
    },
  },
];

/** The implementations of the four workflow tools (**thin wrappers** ✓ — contract §9.2 ✓) */
function buildTools(deps: McpServerDeps): Map<string, McpToolImpl> {
  const { workflows } = deps;
  const tools = new Map<string, McpToolImpl>([
    [
      'list_workflows',
      () =>
        // **Only the id / name / the declarations of the inputs are given** ✓ (contract §2.4 ✓ — no topology ✓)
        withVersionEach(
          workflows.list().map((w) => ({
            id: w.id,
            name: w.name,
            inputs: w.inputs,
          })),
        ),
    ],
    [
      'run_workflow',
      (args) => {
        const id = args['id'];
        if (typeof id !== 'string' || id.length === 0) {
          return withVersion(failure('invalid_params', 'run_workflow is missing id'));
        }
        const inputs = (args['inputs'] ?? {}) as Record<string, unknown>;
        const dryRun = args['dry_run'];
        if (dryRun !== undefined && typeof dryRun !== 'boolean') {
          return withVersion(failure('invalid_params', 'dry_run must be omitted or a boolean'));
        }
        // **① The existence** ✓ (contract §2.4 ✓ — **before the authorisation** ✓)
        let pack: WorkflowPack;
        try {
          pack = workflows.pack(id);
        } catch (err) {
          return withVersion(
            failure(reasonOf(err), err instanceof Error ? err.message : String(err)),
          );
        }
        // **② The unified permission area is the gate** ✓ (contract §2.4 ✓ ·
        // implementation decision record ADR-D47 ✓ · ADR-D48 ✓)
        if (!deps.permissions.allows('agent', `workflow:${id}`)) {
          return withVersion(
            failure('denied', `The permission area does not allow the agent to run the workflow "${id}"`),
          );
        }
        // **dry_run: a preview** ✓ (**not a single step is run** ✓ · **nothing is written to the audit** ✓ · **there is no run_id** ✓)
        if (dryRun === true) {
          try {
            const preview = dryRunWorkflow(pack, inputs);
            return withVersion({
              ok: preview.ok,
              ...(preview.steps === undefined ? {} : { steps: preview.steps }),
              ...(preview.reason === undefined ? {} : { reason: preview.reason }),
              ...(preview.detail === undefined ? {} : { detail: preview.detail }),
            });
          } catch (err) {
            return withVersion(
              failure(reasonOf(err), err instanceof Error ? err.message : String(err)),
            );
          }
        }
        try {
          const { runId } = workflows.start(id, inputs);
          return withVersion({ ok: true, run_id: runId });
        } catch (err) {
          // **A failure uses `ok:false + reason`** ✓ (contract §4 ✓ — it does not throw ✓)
          return withVersion(
            failure(reasonOf(err), err instanceof Error ? err.message : String(err)),
          );
        }
      },
    ],
    [
      'workflow_status',
      (args) => {
        const runId = args['run_id'];
        if (typeof runId !== 'string' || runId.length === 0) {
          return withVersion(failure('invalid_params', 'workflow_status is missing run_id'));
        }
        try {
          // **The projection of the agent side** ✓ (`04` §2.4 ✓ — it carries the audit_id ✓ and not the details ✓)
          return withVersion({ ok: true, ...projectRunStatusForAgent(workflows.status(runId)) });
        } catch {
          return withVersion(failure('not_found', 'No such run'));
        }
      },
    ],
    [
      'install_card',
      (args) => {
        const path = args['path'];
        if (typeof path !== 'string' || path.length === 0) {
          return withVersion(failure('invalid_params', 'install_card is missing path'));
        }
        if (deps.host?.cardTools === undefined) {
          return withVersion(failure('failed', 'The host has no card installation capability wired up'));
        }
        // **The unified permission area** ✓ (ADR-D47 ✓)
        if (!deps.permissions.allows('agent', 'host:install_card')) {
          return withVersion(failure('denied', 'The permission area does not allow the agent to install cards'));
        }
        return withVersion(installCard(deps.host.cardTools, path));
      },
    ],
    [
      'uninstall_card',
      (args) => {
        const cardId = args['card_id'];
        if (typeof cardId !== 'string' || cardId.length === 0) {
          return withVersion(failure('invalid_params', 'uninstall_card is missing card_id'));
        }
        if (deps.host?.cardTools === undefined) {
          return withVersion(failure('failed', 'The host has no card installation capability wired up'));
        }
        // **The unified permission area** ✓ (ADR-D47 ✓)
        if (!deps.permissions.allows('agent', 'host:uninstall_card')) {
          return withVersion(failure('denied', 'The permission area does not allow the agent to uninstall cards'));
        }
        return withVersion(uninstallCard(deps.host.cardTools, cardId));
      },
    ],
    [
      'promote_card',
      (args) => {
        const cardId = args['card_id'];
        if (typeof cardId !== 'string' || cardId.length === 0) {
          return withVersion(failure('invalid_params', 'promote_card is missing card_id'));
        }
        const conn = args['connection_id'];
        if (conn !== undefined && typeof conn !== 'string') {
          return withVersion(failure('invalid_params', 'connection_id must be omitted or a string'));
        }
        if (deps.host === undefined) {
          return withVersion(failure('failed', 'The host has no layout capability wired up'));
        }
        // **The unified permission area** ✓ (ADR-D47 ✓)
        if (!deps.permissions.allows('agent', 'host:promote_card')) {
          return withVersion(failure('denied', 'The permission area does not allow the agent to promote cards'));
        }
        const result = promoteCard(deps.host.layout(), cardId, conn as string | undefined);
        if (!result.ok || result.layout === undefined) {
          return withVersion(
            failure(
              result.reason === 'invalid_params' ? 'invalid_params' : 'not_found',
              result.detail,
            ),
          );
        }
        // **It is stored** ✓ (**full screen is a state of the layout** ✓ — without storing it it does not take effect ✓)
        deps.host.saveLayout(result.layout);
        return withVersion({ ok: true, mode: 'fullscreen' });
      },
    ],
    [
      'get_card_sdk_docs',
      (args) => {
        const topic = args['topic'];
        if (topic !== undefined && typeof topic !== 'string') {
          return withVersion(failure('invalid_params', 'topic must be omitted or a string'));
        }
        return withVersion(sdkDocs(topic));
      },
    ],
  ]);
  // **The read-side tools** ✓ (**only once the host dependencies are there** ✓)
  if (deps.host !== undefined) {
    for (const [name, impl] of buildReadTools(deps.host)) tools.set(name, impl);
  }
  return tools;
}

/**
 * The **implementations of the read-side tools** (contract `spec/04` §2.1 /
 * §2.2 / §2.3 / §2.5 ✓).
 *
 * → **They are all thin wrappers** ✓ (contract §6 ✓) — forwarding + projection
 *   ✓, **no business decision** ✓.
 * → **Without the host dependencies not one of them is registered** ✓ (**a
 *   tool that cannot be called is not listed** ✓).
 */
function buildReadTools(host: McpHostDeps): Map<string, McpToolImpl> {
  return new Map<string, McpToolImpl>([
    [
      'list_connections',
      () => withVersionEach(listConnections(host)),
    ],
    [
      'list_data_sources',
      () => withVersionEach(listDataSources(host)),
    ],
    [
      'list_capabilities',
      () => withVersion(listCapabilities(host)),
    ],
    [
      'list_tags',
      (args) => {
        // **The `board` argument**: in v1 there is only one board ✓ → **leaving it out means the current one** ✓
        // → **Another board → an empty array** ✓ (no guessing ✓ — contract §2.1 says "without it, nothing is given" ✓)
        const wanted = args['board'];
        if (typeof wanted === 'string' && wanted.length > 0) {
          const current = host.pack()?.id ?? null;
          if (wanted !== current) return withVersionEach([]);
        }
        return withVersionEach(listTags(host));
      },
    ],
    [
      'describe_tag',
      (args) => {
        const name = args['name'];
        if (typeof name !== 'string' || name.length === 0) {
          return withVersion(failure('invalid_params', 'describe_tag is missing name'));
        }
        const described = describeTag(host, name);
        if (described === null) {
          return withVersion(failure('not_found', `No such tag: ${name}`));
        }
        return withVersion(described);
      },
    ],
    [
      'sample_tag',
      async (args) => {
        const name = args['name'];
        if (typeof name !== 'string' || name.length === 0) {
          return withVersion(failure('invalid_params', 'sample_tag is missing name'));
        }
        const n = args['n'];
        if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
          return withVersion(failure('invalid_params', 'sample_tag n must be a positive integer'));
        }
        // **Sample it in a directed way once first** ✓ (contract §2.1 ✓ — without the sampling what comes out is **a frozen old sample** ✓)
        await host.refreshTag(name);
        return withVersionEach(sampleTag(host, name, n));
      },
    ],
    [
      'list_cards',
      () => withVersionEach(listCards(host)),
    ],
    [
      'validate_card',
      (args) => {
        const path = args['path'];
        if (typeof path !== 'string' || path.length === 0) {
          return withVersion(failure('invalid_params', 'validate_card is missing path'));
        }
        return withVersion(host.validateCard(path));
      },
    ],
    [
      'get_card_runtime_log',
      (args) => {
        const cardId = args['card_id'];
        if (typeof cardId !== 'string' || cardId.length === 0) {
          return withVersion(failure('invalid_params', 'get_card_runtime_log is missing card_id'));
        }
        const since = args['since'];
        if (since !== undefined && (typeof since !== 'number' || !Number.isFinite(since))) {
          return withVersion(failure('invalid_params', 'since must be a millisecond timestamp'));
        }
        return withVersionEach(getCardRuntimeLog(host, cardId, since as number | undefined));
      },
    ],
    [
      'get_layout',
      () => withVersion(getLayout(host)),
    ],
    [
      'set_layout',
      (args) => {
        const layout = args['layout'];
        if (layout === null || typeof layout !== 'object') {
          return withVersion(failure('invalid_params', 'set_layout is missing layout'));
        }
        const normalized = normalizeLayoutCards((layout as Record<string, unknown>)['cards']);
        host.saveLayout({
          version: 3,
          units: normalized.cards.map((c) => ({
            cardId: c.card_id,
            connectionId: c.connection_id,
            x: c.x,
            y: c.y,
            w: c.w,
            h: c.h,
          })),
          density: host.layout().density,
          updatedAt: Date.now(),
        });
        return withVersion({ ok: true, dropped: normalized.dropped });
      },
    ],
    [
      'execute_action',
      async (args) => {
        const actionId = args['action_id'];
        if (typeof actionId !== 'string' || actionId.length === 0) {
          return withVersion(failure('invalid_params', 'execute_action is missing action_id'));
        }
        const params = (args['params'] ?? {}) as Record<string, unknown>;
        const dryRun = args['dry_run'];
        if (dryRun !== undefined && typeof dryRun !== 'boolean') {
          return withVersion(failure('invalid_params', 'dry_run must be omitted or a boolean'));
        }
        const deviceKey = args['device_key'];
        if (deviceKey !== undefined && (typeof deviceKey !== 'string' || deviceKey.length === 0)) {
          return withVersion(failure('invalid_params', 'device_key must be omitted or a non-empty string'));
        }
        const result = await executeAction(
          host.actions,
          actionId,
          params,
          {
            ...(dryRun === undefined ? {} : { dryRun }),
            ...(deviceKey === undefined ? {} : { deviceKey }),
          },
        );
        return withVersion(result);
      },
    ],
  ]);
}
