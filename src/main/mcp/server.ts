import { MCP_PROTOCOL_VERSION } from './security';
import { projectRunStatusForAgent } from './view';
import type { WorkflowService } from '../workflows/service';
import type { McpHostDeps } from './host';
import { withVersion, withVersionEach } from './convention';
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
      throw new RpcError(JSON_RPC_METHOD_NOT_FOUND, `没有这个工具：${name}`);
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
          throw new RpcError(JSON_RPC_INVALID_PARAMS, 'tools/call 缺 name');
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
        throw new RpcError(JSON_RPC_METHOD_NOT_FOUND, `没有这个方法：${message.method}`);
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
  | 'not_approved'
  | 'invalid_params'
  | 'busy'
  | 'no_pending_confirmation'
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
  if (raw === 'not_found' || raw === 'not_approved') return raw;
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
const TOOL_DEFS: McpToolDef[] = [
  {
    name: 'list_workflows',
    title: '列出可跑的流程',
    description:
      '列出**用户批过**的流程（只有 id / 名称 / 输入声明 —— 不给拓扑：哪个角色连哪台机器是未授权方不该看的）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'run_workflow',
    title: '跑一条流程',
    description: '跑一条流程，**立刻返回** run_id；进度用 workflow_status 轮询。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '流程 id（先跑 list_workflows 看有哪些）' },
        inputs: { type: 'object', description: '输入值（按流程的输入声明给）' },
      },
      required: ['id'],
    },
  },
  {
    name: 'workflow_status',
    title: '看一次运行的状态',
    description: '看一次运行的**状态与阶段时间线**（缩减投影：不给路径、参数值、角色）。',
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string', description: 'run_workflow 给的运行 id' } },
      required: ['run_id'],
    },
  },
  {
    name: 'confirm_workflow',
    title: '递一次确认请求',
    description:
      '**递一次确认请求**（人点了才生效 —— 这个工具**不会**让凭据生效；批准是 GUI 那一侧的事）。',
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string', description: '运行 id' } },
      required: ['run_id'],
    },
  },
];

/**
 * **读侧工具的声明**（契约 `spec/04` §2.1 / §2.2 / §2.3 / §2.5 ✓ · ADR-D40 ✓）。
 *
 * → **单独一份** ✓ —— 不与流程工具混在一张表里 ✓（那一张是「流程那一组」✓）。
 * → **接了宿主依赖才有** ✓（`host` 没传就不列 ✓ —— **不列一个调不通的工具** ✓）。
 */
const READ_TOOL_DEFS: McpToolDef[] = [
  {
    name: 'list_connections',
    title: '列出连着的配置',
    description:
      '列出连接配置（profile）：id / 标签 / 传输 / 绑的板型包 / **现在有活连接吗** / 连接级能力位。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_data_sources',
    title: '列出数据源',
    description:
      '列出当前板型包的数据源（**reader 粒度**）：每个 reader 提供哪些 tag、属于哪个轮询组、周期多长、现在什么状态。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_capabilities',
    title: '工作台自己有什么',
    description: '列出可用的传输与工作台自己的能力位（**cards** / **mcp** / **layout_share** / **record**）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_tags',
    title: '列出当前可读的量',
    description:
      '列出**当前实际可读**的 tag：名字 / 类型 / 单位 / 取值域 / 现在的值与状态 / 哪个 reader 提供的。**写卡时第一个该调它**。',
    inputSchema: {
      type: 'object',
      properties: {
        board: { type: 'string', description: '只看某块板（**省略就是当前那块**）' },
      },
    },
  },
  {
    name: 'describe_tag',
    title: '看一个量的语义',
    description:
      '看一个 tag 的**语义原文**（防误用）、来源 reader 与它的脱敏参数、最近的样本窗口。**命令不会给**。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'tag 名' } },
      required: ['name'],
    },
  },
  {
    name: 'sample_tag',
    title: '取最近的样本',
    description:
      '**先定向采一次**再取最近 n 个样本（值 / 单位 / 状态 / 时刻）——用来判断「这个量稳不稳、刷新周期多长」。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'tag 名' },
        n: { type: 'number', description: '要几个样本（**最近 n 个**，不是 n 秒）' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_cards',
    title: '列出装着的卡片',
    description:
      '列出装着的卡片：id / manifest id / 版本 / 路径 / 装的状态 / **在当前板上是不是残的**（缺哪些 tag、哪些读不出来）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'validate_card',
    title: '校验一张卡',
    description:
      '静态校验一个卡片目录（**不安装**）：错误与警告清单，以及它实际会绑到哪些 tag 与动作、哪些会缺失。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '卡片目录的绝对路径' } },
      required: ['path'],
    },
  },
  {
    name: 'get_card_runtime_log',
    title: '看卡片的运行时日志',
    description: '看一张卡运行时的错误（level / 时刻 / 消息 / 来源）。**agent 的自测眼睛**。',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string', description: '卡片 id' },
        since: { type: 'number', description: '只看这个时刻之后的（毫秒 UTC）' },
      },
      required: ['card_id'],
    },
  },
  {
    name: 'get_layout',
    title: '读当前布局',
    description: '读主区的布局（每格：卡片 id / 连接 id / 坐标与尺寸）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_layout',
    title: '保存布局',
    description: '**整份替换**主区的布局。越界的格子会被丢掉并报在 `dropped` 里。',
    inputSchema: {
      type: 'object',
      properties: {
        layout: {
          type: 'object',
          description: '布局（`{ cards: [{ card_id, connection_id, x, y, w, h }] }`）',
        },
      },
      required: ['layout'],
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
          return withVersion(failure('invalid_params', 'run_workflow 缺 id'));
        }
        const inputs = (args['inputs'] ?? {}) as Record<string, unknown>;
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
          return withVersion(failure('invalid_params', 'workflow_status 缺 run_id'));
        }
        try {
          // **agent 侧投影** ✓（`04` §2.4 ✓ —— 含 audit_id ✓，不含明细 ✓）
          return withVersion({ ok: true, ...projectRunStatusForAgent(workflows.status(runId)) });
        } catch {
          return withVersion(failure('not_found', '没有这次运行'));
        }
      },
    ],
    [
      'confirm_workflow',
      (args) => {
        const runId = args['run_id'];
        if (typeof runId !== 'string' || runId.length === 0) {
          return withVersion(failure('invalid_params', 'confirm_workflow 缺 run_id'));
        }
        try {
          // **只递请求** ✓ —— **不使凭据生效** ✓（契约 §2.4 ✓）
          const { confirmId } = workflows.requestConfirmation(runId);
          return withVersion({
            ok: true,
            confirm_id: confirmId,
            expires_at: Date.now() + 5 * 60_000,
          });
        } catch {
          return withVersion(failure('no_pending_confirmation', '这次运行没有待确认的步骤'));
        }
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
          return withVersion(failure('invalid_params', 'describe_tag 缺 name'));
        }
        const described = describeTag(host, name);
        if (described === null) {
          return withVersion(failure('not_found', `没有这个 tag：${name}`));
        }
        return withVersion(described);
      },
    ],
    [
      'sample_tag',
      async (args) => {
        const name = args['name'];
        if (typeof name !== 'string' || name.length === 0) {
          return withVersion(failure('invalid_params', 'sample_tag 缺 name'));
        }
        const n = args['n'];
        if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
          return withVersion(failure('invalid_params', 'sample_tag 的 n 要是正整数'));
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
          return withVersion(failure('invalid_params', 'validate_card 缺 path'));
        }
        return withVersion(host.validateCard(path));
      },
    ],
    [
      'get_card_runtime_log',
      (args) => {
        const cardId = args['card_id'];
        if (typeof cardId !== 'string' || cardId.length === 0) {
          return withVersion(failure('invalid_params', 'get_card_runtime_log 缺 card_id'));
        }
        const since = args['since'];
        if (since !== undefined && (typeof since !== 'number' || !Number.isFinite(since))) {
          return withVersion(failure('invalid_params', 'since 要是毫秒时间戳'));
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
          return withVersion(failure('invalid_params', 'set_layout 缺 layout'));
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
  ]);
}
