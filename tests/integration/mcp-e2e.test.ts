import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { startMcpHttp } from '../../src/main/mcp/http';
import { McpServer } from '../../src/main/mcp/server';
import { PermissionStore } from '../../src/main/permissions/policy';
import type { McpHostDeps } from '../../src/main/mcp/host';
import { generateToken } from '../../src/main/mcp/security';
import { discoveryFilePath, removeDiscoveryFile, writeDiscoveryFile } from '../../src/main/mcp/discovery';
import { WorkflowRegistry } from '../../src/main/workflows/registry';
import { WorkflowService } from '../../src/main/workflows/service';
import { TargetRegistry } from '../../src/main/workflows/targets';
import type { ConnectionProfile } from '../../src/main/profiles/schema';
import type { Connection, ExecResult } from '../../src/main/hal/connection';

/**
 * The end-to-end of MCP (the contract `docs/spec/04-mcp-tools.md` sections
 * 2.4, 7.1 and 7.2).
 *
 * ── Why it starts a real service and sends real HTTP ──
 *
 * That is the shape in which an agent uses it: **read the discovery file →
 * connect to the port → carry the token → send JSON-RPC**. So the test walks
 * that shape once — if any link of the chain does not fit, the agent cannot
 * connect.
 */

/** **The version the server is given** ✓ (a value nobody would write into the code ✓) */
const TEST_VERSION = '1.2.3';

const PACK_YAML = `apiVersion: devboard/v1
kind: Workflow
id: demo.run
name: Demo workflow
version: 1.0.0
inputs:
  project: { type: string, required: true, maxLength: 50 }
roles:
  build:
    purpose: Guest machine
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
/** **The unified permission area** ✓ (the gate of the agent side ✓) */
let permissions: PermissionStore;
let discoveryPath: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cockpit-mcp-e2e-'));
  const workflowsDir = join(dir, 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(join(workflowsDir, 'demo.yaml'), PACK_YAML, 'utf8');

  const profile: ConnectionProfile = {
    id: 'guest',
    label: 'Guest machine',
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
      throw new Error('no session is opened');
    },
  } as unknown as Connection;

  const registry = new WorkflowRegistry({
    dirs: [workflowsDir],
  });
  registry.scan();

  const service = new WorkflowService({
    registry,
    runDeps: {
      targets: new TargetRegistry({
        profileFor: (id) => (id === 'guest' ? profile : undefined),
        createConnection: () => conn,
      }),
      profileFor: (id) => (id === 'guest' ? profile : undefined),
      audit: () => 'audit-1',
    },
  });

  // **The unified permission area** ✓ (the gate of the agent side ✓)
  permissions = new PermissionStore(join(dir, 'permissions.json'));
  token = generateToken();
  server = await startMcpHttp({
    mcp: new McpServer({ workflows: service, permissions: permissions, version: TEST_VERSION, host: hostDeps() }),
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

/** The way an agent uses it: read the discovery file → send the request to the port and the token in it */
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

/**
 * The host dependencies of the read side and of the write side (**fake** —
 * what is verified here is that an agent can connect and call, **not** what
 * the board can really do — that is the job of the unit tests of the modules
 * themselves).
 */
function hostDeps(): McpHostDeps {
  const readings = [
    { tag: 'cpu.usage', value: 42, unit: '%', status: 'ok' as const, at: 1000, seq: 1 },
  ];
  return {
    pack: () => ({
      id: 'demo-pack',
      name: 'Demo pack',
      version: '1.0.0',
      poll_groups: [{ id: 'fast', interval_ms: 1000, readers: ['cpu'] }],
      readers: [
        {
          id: 'cpu',
          kind: 'proc_stat',
          args: { stat_path: '/proc/stat' },
          provides: ['cpu.usage'],
          poll_group: 'fast',
          interval_ms: 1000,
        },
      ],
      actions: [],
    }),
    readings: () => readings,
    history: () => [],
    refreshTag: async () => undefined,
    profiles: () => [{ id: 'guest', label: 'Guest machine', transport: 'ssh', options: {} }],
    capabilities: () => ({ exec: true, pty: false, files: true, exitCode: true }),
    connected: () => true,
    // The connection the runtime is using now (**no connection means `null`**)
    currentProfileId: () => 'guest',
    cards: () => [],
    cardDir: () => null,
    validateCard: () => ({
      ok: true,
      errors: [],
      warnings: [],
      resolved: { tags: ['cpu.usage'], actions: [], layout: null, missing_tags: [], missing_actions: [] },
    }),
    cardLog: () => [],
    layout: () => ({ version: 3, units: [], density: 'comfortable' as const, updatedAt: 0 }),
    saveLayout: () => undefined,
    actions: {
      packId: 'demo-pack',
      packIdOf: () => 'demo-pack',
      contractVersion: 'devboard/v1',
      // The board in use: the credentials are bound to it (contract
      // `docs/spec/04-mcp-tools.md` section 2.4.1, the sixth item)
      deviceKey: () => 'demo-board',
      hasExitCode: true,
      runTransaction: async <T>(fn: (connection: Connection) => Promise<T>): Promise<T> =>
        fn({
          exec: async () => ({
            exitCode: 0,
            stdout: '',
            stderr: '',
            durationMs: 1,
            timedOut: false,
          }),
        } as unknown as Connection),
      readTag: async () => undefined,
      audit: () => 'audit-e2e',
      permissions,
      actions: () => [
        {
          id: 'demo.action',
          label: 'Demo action',
          danger: 'reversible',
          command: 'echo {value}',
          params: { value: { type: 'integer', min: 0, max: 100 } },
          readback: { kind: 'none', consequence: 'for the demonstration' },
        },
      ],
    },
  };
}

describe('MCP · the way an agent uses it (end to end)', () => {
  it('reads the discovery file → connects → initialize → tools/list → tools/call', async () => {
    // ① initialize
    const init = await agentCall('initialize', { protocolVersion: '2025-06-18' });
    expect(init.status).toBe(200);
    const initResult = (JSON.parse(init.body) as { result: Record<string, unknown> }).result;
    expect(initResult['protocolVersion']).toBe('2025-06-18');

    // ② tools/list
    const list = await agentCall('tools/list');
    const tools = (JSON.parse(list.body) as { result: { tools: { name: string }[] } }).result.tools;
    expect(tools.map((t) => t.name)).toContain('run_workflow');

    // ③ tools/call → start a workflow
    const call = await agentCall('tools/call', {
      name: 'run_workflow',
      arguments: { id: 'demo.run', inputs: { project: 'x' } },
    });
    expect(call.status).toBe(200);
    const result = (JSON.parse(call.body) as { result: { content: { text: string }[] } }).result;
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as { ok: boolean; run_id: string };
    expect(payload.ok).toBe(true);
    expect(payload.run_id).toMatch(/^wf-/);

    // ④ workflow_status → look at the timeline
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

  it('tools/list holds the tools of the read side and of the write side (they are there once the host dependencies are connected)', async () => {
    const list = await agentCall('tools/list');
    const tools = (JSON.parse(list.body) as { result: { tools: { name: string }[] } }).result.tools;
    const names = tools.map((t) => t.name);
    for (const expected of [
      'list_connections',
      'list_data_sources',
      'list_capabilities',
      'list_tags',
      'describe_tag',
      'sample_tag',
      'list_cards',
      'validate_card',
      'get_card_runtime_log',
      'get_layout',
      'set_layout',
      'execute_action',
    ]) {
      expect(names, `${expected} is missing`).toContain(expected);
    }
    // The two tools that "ask a person" are gone (removed on 2026-11-16 —
    // ADR-D48)
    expect(names).not.toContain('confirm_action');
    expect(names).not.toContain('confirm_workflow');
  });

  it('tools/call → list_tags really returns something (over real HTTP)', async () => {
    const call = await agentCall('tools/call', {
      name: 'list_tags',
      arguments: {},
    });
    expect(call.status).toBe(200);
    const result = (JSON.parse(call.body) as { result: { content: { text: string }[] } }).result;
    const payload = JSON.parse(result.content[0]?.text ?? '[]') as {
      name: string;
      unit: string;
      apiVersion: string;
    }[];
    expect(payload[0]?.name).toBe('cpu.usage');
    // Every entry carries the apiVersion (contract section 4)
    expect(payload[0]?.apiVersion).toBe('devboard/v1');
  });

  it('tools/call → execute_action really runs (over real HTTP)', async () => {
    const call = await agentCall('tools/call', {
      name: 'execute_action',
      arguments: { action_id: 'demo.action', params: { value: 7 } },
    });
    expect(call.status).toBe(200);
    const result = (JSON.parse(call.body) as { result: { content: { text: string }[] } }).result;
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as {
      ok: boolean;
      apiVersion: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.apiVersion).toBe('devboard/v1');
  });

  it('tools/call → an action that does not exist gives not_found (not denied)', async () => {
    const call = await agentCall('tools/call', {
      name: 'execute_action',
      arguments: { action_id: 'nope.nope' },
    });
    const result = (JSON.parse(call.body) as { result: { content: { text: string }[] } }).result;
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as { ok: boolean; reason: string };
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe('not_found');
  });

  it('a wrong token in the discovery file gives 401 (the token really is a credential)', async () => {
    const reply = await agentCall('tools/list', undefined, { Authorization: 'Bearer wrong' });
    expect(reply.status).toBe(401);
  });

  it('a hostile Origin gives 403 (an agent is not a browser, but a hostile web page is)', async () => {
    const reply = await agentCall('tools/list', undefined, { Origin: 'https://evil.example.com' });
    expect(reply.status).toBe(403);
  });

  it('the discovery file can be deleted once it has been used (it is cleaned up on exit — contract section 7.2)', () => {
    expect(existsSync(discoveryPath)).toBe(true);
    removeDiscoveryFile(discoveryPath);
    expect(existsSync(discoveryPath)).toBe(false);
  });
});
