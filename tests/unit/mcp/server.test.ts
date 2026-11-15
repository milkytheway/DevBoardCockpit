import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '../../../src/main/mcp/server';
import { WorkflowRegistry } from '../../../src/main/workflows/registry';
import { WorkflowService } from '../../../src/main/workflows/service';
import { TargetRegistry } from '../../../src/main/workflows/targets';
import { ConfirmationStore } from '../../../src/main/actions/authorization';
import type { ConnectionProfile } from '../../../src/main/profiles/schema';
import type { Connection, ExecResult } from '../../../src/main/hal/connection';

/**
 * **MCP 的 JSON-RPC 层与流程工具**（契约 `spec/04` §2.4 / §7.1 ✓）。
 *
 * ── 协议照 MCP 官方规范（2025-06-18）──
 *
 * - `initialize` → 回 `protocolVersion` / `capabilities` / `serverInfo` ✓；
 * - `notifications/initialized` → **202 空体** ✓（规范 §「Sending Messages」第 4 条 ✓）；
 * - `tools/list` → 工具清单 ✓（带 `inputSchema` ✓）；
 * - `tools/call` → 调工具 ✓；
 * - 未知方法 → JSON-RPC error `-32601` ✓。
 *
 * ── 工具那一侧的边界（契约 §2.4 明写 ✓）──
 *
 * - `list_workflows` **只给 id / name / 输入声明** ✓ —— **不给拓扑** ✓
 *   （哪个角色连哪台机器 → 那是未授权方不该看到的 ✗）；
 * - `workflow_status` 是**缩减投影** ✓（`03` §7.7 ✓）—— **不是**原样搬过去 ✓；
 * - `confirm_workflow` **只递请求** ✓ —— **不使凭据生效** ✓（批准是 GUI 那一侧的事 ✓）。
 */

let dir: string;
let service: WorkflowService;
let registry: WorkflowRegistry;

const PACK_YAML = `apiVersion: devboard/v1
kind: Workflow
id: demo.run
name: 演示流程
version: 1.0.0
inputs:
  project: { type: string, required: true, maxLength: 50 }
roles:
  build:
    purpose: 客机
    profile: guest
steps:
  - id: hello
    kind: exec
    role: build
    cmd: 'echo {input:project}'
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cockpit-mcp-'));
  const workflowsDir = join(dir, 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(join(workflowsDir, 'demo.yaml'), PACK_YAML, 'utf8');

  const profile: ConnectionProfile = {
    id: 'guest',
    label: '客机',
    transport: 'ssh',
    options: { host: '10.0.0.2' },
  };
  const conn = {
    id: 'guest',
    transport: 'ssh',
    capabilities: () => ({ exec: true, files: true, exitCode: true, pty: false }),
    open: async () => undefined,
    close: async () => undefined,
    exec: async (): Promise<ExecResult> => ({
      exitCode: 0,
      stdout: 'hi',
      stderr: '',
      durationMs: 1,
      timedOut: false,
    }),
    pull: async () => undefined,
    push: async () => undefined,
    list: async () => [],
    openSession: async () => {
      throw new Error('不开会话');
    },
  } as unknown as Connection;

  registry = new WorkflowRegistry({
    dirs: [workflowsDir],
    approvalFile: join(dir, 'workflows-approved.json'),
  });
  registry.scan();
  registry.approve('demo.run');

  const targets = new TargetRegistry({
    profileFor: (id) => (id === 'guest' ? profile : undefined),
    createConnection: () => conn,
  });
  const confirmations = new ConfirmationStore();
  service = new WorkflowService({
    registry,
    confirmations,
    runDeps: {
      targets,
      profileFor: (id) => (id === 'guest' ? profile : undefined),
      audit: () => 'audit-1',
      confirmations,
    },
  });
});

function server(): McpServer {
  return new McpServer({ workflows: service });
}

/** 发一个 JSON-RPC 请求 */
function call(method: string, params?: unknown): Promise<Record<string, unknown>> {
  return server().handle({
    jsonrpc: '2.0',
    id: 1,
    method,
    ...(params === undefined ? {} : { params: params as Record<string, unknown> }),
  }) as Promise<Record<string, unknown>>;
}

describe('MCP · initialize', () => {
  it('**回 protocolVersion / capabilities / serverInfo** ✓', async () => {
    const res = await call('initialize', { protocolVersion: '2025-06-18' });
    const result = res['result'] as Record<string, unknown>;
    expect(result['protocolVersion']).toBe('2025-06-18');
    expect(result['capabilities']).toBeTruthy();
    expect((result['serverInfo'] as Record<string, unknown>)['name']).toBeTruthy();
  });

  it('**声明 tools 能力** ✓（规范：提供工具的 server **MUST** 声明 ✓）', async () => {
    const res = await call('initialize', { protocolVersion: '2025-06-18' });
    const caps = (res['result'] as Record<string, unknown>)['capabilities'] as Record<string, unknown>;
    expect(caps['tools']).toBeTruthy();
  });

  it('**客户端要一个我们不支持的版本 → 回我们自己支持的** ✓（规范 §「Version Negotiation」✓）', async () => {
    const res = await call('initialize', { protocolVersion: '1999-01-01' });
    const result = res['result'] as Record<string, unknown>;
    expect(result['protocolVersion']).toBe('2025-06-18');
  });
});

describe('MCP · 通知（不发响应）', () => {
  it('`notifications/initialized` → **返回 null**（HTTP 层给 202 空体 ✓）', async () => {
    const res = await server().handle({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(res).toBeNull();
  });
});

describe('MCP · tools/list', () => {
  it('**清单里有那四个流程工具** ✓', async () => {
    const res = await call('tools/list');
    const tools = (res['result'] as Record<string, unknown>)['tools'] as {
      name: string;
      inputSchema?: unknown;
    }[];
    const names = tools.map((t) => t.name);
    expect(names).toContain('list_workflows');
    expect(names).toContain('run_workflow');
    expect(names).toContain('workflow_status');
    expect(names).toContain('confirm_workflow');
  });

  it('**每个工具带 inputSchema** ✓（agent 要靠它填参数 ✓）', async () => {
    const res = await call('tools/list');
    const tools = (res['result'] as Record<string, unknown>)['tools'] as {
      name: string;
      inputSchema?: unknown;
    }[];
    for (const tool of tools) {
      expect(tool.inputSchema, `${tool.name} 没有 inputSchema`).toBeTruthy();
    }
  });

  it('**没有「取消流程」的工具** ✓（契约 §2.4：停不停是人的判断 ✓）', async () => {
    const res = await call('tools/list');
    const tools = (res['result'] as Record<string, unknown>)['tools'] as { name: string }[];
    expect(tools.map((t) => t.name)).not.toContain('cancel_workflow');
  });
});

describe('MCP · 未知方法', () => {
  it('**-32601（方法不存在）** ✓', async () => {
    const res = await call('nope/nope');
    const err = res['error'] as { code: number; message: string };
    expect(err.code).toBe(-32601);
  });
});

describe('MCP · 四个流程工具', () => {
  it('**每个响应都带 apiVersion** ✓（契约 §四：版本字段在每个响应里都带上 ✓）', async () => {
    const svc = server();
    const list = (await svc.callTool('list_workflows', {})) as unknown[];
    // **列表也要带** ✓ —— 契约说的是「每个响应」✓
    expect((list[0] as Record<string, unknown>)['apiVersion']).toBe('devboard/v1');

    const started = (await svc.callTool('run_workflow', {
      id: 'demo.run',
      inputs: { project: 'x' },
    })) as Record<string, unknown>;
    expect(started['apiVersion']).toBe('devboard/v1');

    const status = (await svc.callTool('workflow_status', {
      run_id: started['run_id'],
    })) as Record<string, unknown>;
    expect(status['apiVersion']).toBe('devboard/v1');
  });

  it('`list_workflows` → **只给 id / name / 输入声明**（**不给拓扑** ✓）', async () => {
    const res = await server().callTool('list_workflows', {});
    const list = res as { id: string; name: string; inputs: Record<string, unknown> }[];
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('demo.run');
    expect(list[0]?.name).toBe('演示流程');
    expect(list[0]?.inputs['project']).toBeTruthy();
    // **不许露出角色/机器** ✓（契约 §2.4：「哪个角色连哪台机器 → 那是未授权方不该看到的」✓）
    const dumped = JSON.stringify(list);
    expect(dumped).not.toContain('build');
    expect(dumped).not.toContain('guest');
    expect(dumped).not.toContain('ubuntu-ssh');
  });

  it('`run_workflow` → **返回 run_id** ✓', async () => {
    const res = await server().callTool('run_workflow', {
      id: 'demo.run',
      inputs: { project: 'x' },
    });
    expect((res as { run_id: string }).run_id).toMatch(/^wf-/);
  });

  it('`run_workflow` 跑一个**没批准的**流程 → **失败**（不是偷偷跑起来 ✓）', async () => {
    const res = await server().callTool('run_workflow', {
      id: 'nobody.run',
      inputs: {},
    });
    const out = res as { ok?: boolean; reason?: string };
    expect(out.ok).toBe(false);
    expect(out.reason).toBeTruthy();
  });

  it('`workflow_status` → **缩减投影**（**不给 outputs / inputs / role** ✓）', async () => {
    const svc = server();
    const started = (await svc.callTool('run_workflow', {
      id: 'demo.run',
      inputs: { project: 'x' },
    })) as { run_id: string };
    const status = (await svc.callTool('workflow_status', {
      run_id: started.run_id,
    })) as Record<string, unknown>;
    expect(status['state']).toBeTruthy();
    expect(status['stages']).toBeTruthy();
    const dumped = JSON.stringify(status);
    // **这些是宿主侧的东西** ✓（契约 §2.4：明细留给宿主与 agent ✓）
    expect(dumped).not.toContain('outputs');
    expect(dumped).not.toContain('inputs');
    expect(dumped).not.toContain('"role"');
    expect(dumped).not.toContain('audit_id');
  });

  it('`confirm_workflow` → **只递请求**（**凭据不因此生效** ✓ —— 契约 §2.4 ✓）', async () => {
    const svc = server();
    const started = (await svc.callTool('run_workflow', {
      id: 'demo.run',
      inputs: { project: 'x' },
    })) as { run_id: string };
    // **这个流程没有 destructive 步** ✓ → 没有待确认的凭据 ✓
    const res = await svc.callTool('confirm_workflow', { run_id: started.run_id });
    const out = res as { ok?: boolean; reason?: string };
    expect(out.ok).toBe(false);
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
