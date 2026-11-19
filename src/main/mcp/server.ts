import { MCP_PROTOCOL_VERSION } from './security';
import { projectRunStatusForAgent } from './view';
import type { WorkflowService } from '../workflows/service';
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
 * **MCP 的 JSON-RPC 层**（协议照 MCP 官方规范 2025-06-18 ✓）。
 *
 * ── 为什么自己写而不用 SDK ──
 *
 * `docs/04` §132 的选型表写着用 `@modelcontextprotocol/sdk` ✓，
 * **这一轮推翻它** ✓（**ADR-D39** ✓）：
 *
 * | # | 理由 |
 * |---|---|
 * | 1 | SDK 带 **91 个包 / 29MB** ✓（express · hono · cors · jose · zod 全家桶 ✓）—— 本工程**零 web 框架依赖** ✓ |
 * | 2 | 沙箱与宿主**共用一份 `node_modules`** ✓ → 装新依赖会**把两边的平台二进制搞坏** ✓ → **MCP server 的代码在沙箱里根本没法验** ✓ |
 * | 3 | 这个工程的规矩是「**证据先于断言**」✓ → 引了 SDK 就交一批**没验过**的代码 ✗ |
 *
 * → **代价（诚实说）**：SDK 附带的那些（SSE 推送 · resumability · prompt/resource · OAuth）**本轮不做** ✓
 *   —— **契约里也没有** ✓（`spec/04` §7.1 只要「agent 能发现并连上」✓）。
 */

/** JSON-RPC 2.0 的请求/通知（**我们只用到这几个形状** ✓） */
interface JsonRpcMessage {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 的错误码（**规范里的那几个** ✓） */
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_INTERNAL_ERROR = -32603;

/** 一个工具的声明（**照规范 §「Tool」** ✓） */
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

/** 工具的实现（**入参 → 出参** ✓） */
export type McpToolImpl = (args: Record<string, unknown>) => Promise<unknown> | unknown;

/** MCP server 依赖的宿主能力（**只有这一处** ✓ —— 契约 §9.2「工具是薄封装」✓） */
export interface McpServerDeps {
  /** 流程服务（**卡片侧与 agent 侧共用同一个** ✓ —— ADR-D34 ✓） */
  workflows: WorkflowService;
  /**
   * **读侧工具的宿主依赖** ✓（`docs/04` §9.2.1 ✓）。
   *
   * → **可选** ✓：不传就只有四个流程工具 ✓（**接线之前也能用** ✓ —— 测试与渐进接线 ✓）。
   */
  host?: McpHostDeps;
}

export class McpServer {
  private readonly tools: Map<string, McpToolImpl>;
  private readonly toolDefs: McpToolDef[];

  constructor(deps: McpServerDeps) {
    this.tools = buildTools(deps);
    // **没接宿主依赖 → 不列读侧工具** ✓（**不列一个调不通的工具** ✓ —— 契约 §七.4 的那条要求 ✓）
    this.toolDefs =
      deps.host === undefined ? [...TOOL_DEFS] : [...TOOL_DEFS, ...READ_TOOL_DEFS];
  }

  /** 工具清单（**规范 §「Listing Tools」** ✓） */
  listTools(): McpToolDef[] {
    return [...this.toolDefs];
  }

  /**
   * **处理一条 JSON-RPC 消息** ✓。
   *
   * → **通知**（没有 `id` ✓）→ 返回 `null` ✓（HTTP 层给 **202 空体** ✓ —— 规范 §「Sending Messages」第 4 条 ✓）。
   * → **请求**（有 `id` ✓）→ 返回 `{ jsonrpc, id, result }` 或 `{ jsonrpc, id, error }` ✓。
   */
  async handle(message: JsonRpcMessage): Promise<Record<string, unknown> | null> {
    // **通知** → 不回响应 ✓
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

  /** 调一个工具（**工具内部抛错 → 转成 `isError` 的结果** ✓ —— 规范 §「Tool Execution Errors」✓） */
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
          serverInfo: { name: 'devboard-cockpit', version: '0.1.0' },
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
          // **工具执行失败** → `isError: true` 的结果 ✓（不是协议错误 ✓ —— 规范 §「Tool Execution Errors」✓）
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
    // **本轮只有 initialized 这一条通知** ✓（规范 §「Lifecycle」✓）→ 别的忽略 ✓
    if (message.method === 'notifications/initialized') return;
  }
}

/** 带错误码的异常（**协议错误** ✓） */
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

/** 工具失败的**封闭理由码** ✓（契约 §四：失败用 `ok:false + reason` ✓） */
export type McpReason =
  | 'denied'
  | 'not_found'
  | 'invalid_params'
  | 'busy'
  | 'failed';

/**
 * 把宿主侧的异常翻成**封闭理由码** ✓。
 *
 * → **不靠解析中文消息** ✓（那是「解析错误消息」的坏味道 ✗）→
 *   宿主侧的错误带 `detail.reason` ✓（`registry.ts` 登记的 ✓）→ 直接取 ✓。
 */
function reasonOf(err: unknown): McpReason {
  const detail = (err as { detail?: { reason?: string } } | undefined)?.detail;
  const raw = detail?.reason;
  if (raw === 'not_found') return raw;
  if (err instanceof RpcError && err.code === JSON_RPC_INVALID_PARAMS) return 'invalid_params';
  return 'failed';
}

/** 工具的失败结果（**契约 §四** ✓：`ok:false + reason` ✓） */
export interface McpFailure {
  ok: false;
  reason: McpReason;
  detail?: string;
}

function failure(reason: McpReason, detail?: string): McpFailure {
  return { ok: false, reason, ...(detail === undefined ? {} : { detail }) };
}

/** 四个流程工具的声明（**契约 `spec/04` §2.4** ✓） */
/**
 * 工具的声明（**契约 `spec/04` §2.4** ✓）。
 *
 * → **导出来** ✓ —— 为了让「**这里没有 cancel**」这条**契约边界**能被**测到** ✓
 *   （契约 A4 ✓：**agent 不给「停不停」** ✓ —— 那条边界**值得守着** ✓）。
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
 * **读侧工具的声明**（契约 `spec/04` §2.1 / §2.2 / §2.3 / §2.5 ✓ · ADR-D40 ✓）。
 *
 * → **单独一份** ✓ —— 不与流程工具混在一张表里 ✓（那一张是「流程那一组」✓）。
 * → **接了宿主依赖才有** ✓（`host` 没传就不列 ✓ —— **不列一个调不通的工具** ✓）。
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

/** 四个流程工具的实现（**薄封装** ✓ —— 契约 §9.2 ✓） */
function buildTools(deps: McpServerDeps): Map<string, McpToolImpl> {
  const { workflows } = deps;
  const tools = new Map<string, McpToolImpl>([
    [
      'list_workflows',
      () =>
        // **只给 id / name / 输入声明** ✓（契约 §2.4 ✓ —— 不给拓扑 ✓）
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
        // **dry_run：预览** ✓（**不跑任何一步** ✓ · **不写审计** ✓ · **没有 run_id** ✓）
        if (dryRun === true) {
          try {
            const pack = workflows.pack(id);
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
          // **失败用 `ok:false + reason`** ✓（契约 §四 ✓ —— 不抛异常 ✓）
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
          // **agent 侧投影** ✓（`04` §2.4 ✓ —— 含 audit_id ✓，不含明细 ✓）
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
        const result = promoteCard(deps.host.layout(), cardId, conn as string | undefined);
        if (!result.ok || result.layout === undefined) {
          return withVersion(
            failure(
              result.reason === 'invalid_params' ? 'invalid_params' : 'not_found',
              result.detail,
            ),
          );
        }
        // **存下去** ✓（**全屏是布局状态** ✓ —— 不存就不生效 ✓）
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
  // **读侧工具** ✓（**接了宿主依赖才有** ✓）
  if (deps.host !== undefined) {
    for (const [name, impl] of buildReadTools(deps.host)) tools.set(name, impl);
  }
  return tools;
}

/**
 * **读侧工具的实现**（契约 `spec/04` §2.1 / §2.2 / §2.3 / §2.5 ✓）。
 *
 * → **全部是薄封装** ✓（契约 §六 ✓）—— 转发 + 投影 ✓，**不含业务判断** ✓。
 * → **没接宿主依赖 → 一个都不注册** ✓（**不列一个调不通的工具** ✓）。
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
        // **`board` 参数**：v1 只有一块板 ✓ → **省略就是当前那块** ✓
        // → **给了别的 board → 空数组** ✓（不猜 ✓ —— 契约 §2.1 说「不给就不给」✓）
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
        // **先定向采一次** ✓（契约 §2.1 ✓ —— 不采的话拿到的是**冻结的旧样本** ✓）
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
