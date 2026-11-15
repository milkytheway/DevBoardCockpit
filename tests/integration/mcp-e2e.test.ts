import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { startMcpHttp } from '../../src/main/mcp/http';
import { McpServer } from '../../src/main/mcp/server';
import { generateToken } from '../../src/main/mcp/security';
import { discoveryFilePath, removeDiscoveryFile, writeDiscoveryFile } from '../../src/main/mcp/discovery';
import { WorkflowRegistry } from '../../src/main/workflows/registry';
import { WorkflowService } from '../../src/main/workflows/service';
import { TargetRegistry } from '../../src/main/workflows/targets';
import { ConfirmationStore } from '../../src/main/actions/authorization';
import type { ConnectionProfile } from '../../src/main/profiles/schema';
import type { Connection, ExecResult } from '../../src/main/hal/connection';

/**
 * **MCP 的端到端**（契约 `spec/04` §2.4 / §7.1 / §7.2 ✓）。
 *
 * ── 为什么这条要「真起一个服务、真发 HTTP」 ──
 *
 * agent 的用法就是这个形状 ✓：**读发现文件 → 连端口 → 带 token → 发 JSON-RPC** ✓。
 * → 所以就按这个形状走一遍 ✓ —— **中间任何一环接不上，agent 就连不上** ✓。
 */
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

let dir: string;
let server: { close: () => Promise<void>; port: number };
let token: string;
let discoveryPath: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cockpit-mcp-e2e-'));
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

  const registry = new WorkflowRegistry({
    dirs: [workflowsDir],
    approvalFile: join(dir, 'workflows-approved.json'),
  });
  registry.scan();
  registry.approve('demo.run');

  const confirmations = new ConfirmationStore();
  const service = new WorkflowService({
    registry,
    confirmations,
    runDeps: {
      targets: new TargetRegistry({
        profileFor: (id) => (id === 'guest' ? profile : undefined),
        createConnection: () => conn,
      }),
      profileFor: (id) => (id === 'guest' ? profile : undefined),
      audit: () => 'audit-1',
      confirmations,
    },
  });

  token = generateToken();
  server = await startMcpHttp({
    mcp: new McpServer({ workflows: service }),
    token,
    host: '127.0.0.1',
    port: 0,
  });

  discoveryPath = discoveryFilePath(dir);
  writeDiscoveryFile(discoveryPath, {
    apiVersion: 'devboard/v1',
    transport: 'http',
    host: '127.0.0.1',
    port: server.port,
    pid: process.pid,
    token,
    cards_dir: join(dir, 'cards'),
    started_at: new Date().toISOString(),
  });
});

afterEach(async () => {
  removeDiscoveryFile(discoveryPath);
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

/** **按 agent 的用法**：读发现文件 → 按里面的端口与 token 发请求 ✓ */
async function agentCall(
  method: string,
  params?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const info = JSON.parse(readFileSync(discoveryPath, 'utf8')) as {
    host: string;
    port: number;
    token: string;
  };
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        host: info.host,
        port: info.port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${info.token}`,
          'MCP-Protocol-Version': '2025-06-18',
          ...extraHeaders,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => {
          text += String(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }));
  });
}

describe('MCP · agent 的用法（端到端）', () => {
  it('**读发现文件 → 连上去 → initialize → tools/list → tools/call** ✓', async () => {
    // ① initialize ✓
    const init = await agentCall('initialize', { protocolVersion: '2025-06-18' });
    expect(init.status).toBe(200);
    const initResult = (JSON.parse(init.body) as { result: Record<string, unknown> }).result;
    expect(initResult['protocolVersion']).toBe('2025-06-18');

    // ② tools/list ✓
    const list = await agentCall('tools/list');
    const tools = (JSON.parse(list.body) as { result: { tools: { name: string }[] } }).result.tools;
    expect(tools.map((t) => t.name)).toContain('run_workflow');

    // ③ tools/call → 起一条流程 ✓
    const call = await agentCall('tools/call', {
      name: 'run_workflow',
      arguments: { id: 'demo.run', inputs: { project: 'x' } },
    });
    expect(call.status).toBe(200);
    const result = (JSON.parse(call.body) as { result: { content: { text: string }[] } }).result;
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as { ok: boolean; run_id: string };
    expect(payload.ok).toBe(true);
    expect(payload.run_id).toMatch(/^wf-/);

    // ④ workflow_status → 看时间线 ✓
    const status = await agentCall('tools/call', {
      name: 'workflow_status',
      arguments: { run_id: payload.run_id },
    });
    const statusResult = (JSON.parse(status.body) as { result: { content: { text: string }[] } }).result;
    const statusPayload = JSON.parse(statusResult.content[0]?.text ?? '{}') as {
      state: string;
      stages: unknown[];
    };
    expect(statusPayload.state).toBeTruthy();
    expect(statusPayload.stages.length).toBeGreaterThan(0);
  });

  it('**发现文件里的 token 不对 → 401** ✓（token 真的是凭据 ✓）', async () => {
    const reply = await agentCall('tools/list', undefined, { Authorization: 'Bearer wrong' });
    expect(reply.status).toBe(401);
  });

  it('**恶意 Origin → 403** ✓（agent 不是浏览器 ✓，但恶意网页是 ✓）', async () => {
    const reply = await agentCall('tools/list', undefined, { Origin: 'https://evil.example.com' });
    expect(reply.status).toBe(403);
  });

  it('**发现文件用完就能删** ✓（退出时清 ✓ —— 契约 §7.2 ✓）', () => {
    expect(existsSync(discoveryPath)).toBe(true);
    removeDiscoveryFile(discoveryPath);
    expect(existsSync(discoveryPath)).toBe(false);
  });
});
