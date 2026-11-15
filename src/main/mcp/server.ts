import { MCP_PROTOCOL_VERSION } from './security';
import { projectRunStatusForAgent } from './view';
import type { WorkflowService } from '../workflows/service';

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
}

export class McpServer {
  private readonly tools: Map<string, McpToolImpl>;

  constructor(deps: McpServerDeps) {
    this.tools = buildTools(deps);
  }

  /** 工具清单（**规范 §「Listing Tools」** ✓） */
  listTools(): McpToolDef[] {
    return [...TOOL_DEFS];
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

/** 契约版本（**每个响应都带上** ✓ —— 契约 §四 ✓） */
const API_VERSION = 'devboard/v1';

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

/**
 * **给一个返回值补上 `apiVersion`** ✓（契约 §四：「每个响应里都带上」✓）。
 *
 * → **列表也要补** ✓（`list_workflows` 返回的是数组 ✓ —— 逐项补 ✓）。
 */
function withVersion<T>(value: T): T & { apiVersion: string } {
  return { apiVersion: API_VERSION, ...value };
}

/** 列表的每一项都补上 ✓ */
function withVersionEach<T>(items: T[]): (T & { apiVersion: string })[] {
  return items.map((item) => ({ apiVersion: API_VERSION, ...item }));
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

/** 四个流程工具的实现（**薄封装** ✓ —— 契约 §9.2 ✓） */
function buildTools(deps: McpServerDeps): Map<string, McpToolImpl> {
  const { workflows } = deps;
  return new Map<string, McpToolImpl>([
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
}
