import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '../../../src/main/mcp/server';
import { PermissionStore } from '../../../src/main/permissions/policy';
import { WorkflowRegistry } from '../../../src/main/workflows/registry';
import { WorkflowService } from '../../../src/main/workflows/service';
import { TargetRegistry } from '../../../src/main/workflows/targets';
import type { ConnectionProfile } from '../../../src/main/profiles/schema';
import type { Connection, ExecResult } from '../../../src/main/hal/connection';

/**
 * The JSON-RPC layer of MCP and the workflow tools (contract `spec/04` §2.4 /
 * §7.1).
 *
 * The protocol follows the official MCP specification (2025-06-18):
 *
 * - `initialize` → returns `protocolVersion` / `capabilities` / `serverInfo`;
 * - `notifications/initialized` → **202 with an empty body** (specification,
 *   "Sending Messages", item 4);
 * - `tools/list` → the tool list (with `inputSchema`);
 * - `tools/call` → calls a tool;
 * - an unknown method → the JSON-RPC error `-32601`.
 *
 * The boundary on the tool side (spelled out in contract §2.4):
 *
 * - `list_workflows` **returns only the id, the name and the input
 *   declarations** — **not the topology** (which role connects to which
 *   machine is not something an unauthorised party may see);
 * - `workflow_status` is a **reduced projection** (`03` §7.7), not a copy of
 *   the whole thing;
 * - **the tool that passed on a confirmation request is gone**.
 */

/**
 * **The version the server is given** ✓ — a value nobody would write into the
 * code ✓ → **a literal would fail the criterion** ✓.
 */
const TEST_VERSION = '1.2.3';

let dir: string;
let service: WorkflowService;
let registry: WorkflowRegistry;

const PACK_YAML = `apiVersion: devboard/v1
kind: Workflow
id: demo.run
name: demo workflow
version: 1.0.0
inputs:
  project: { type: string, required: true, maxLength: 50 }
roles:
  build:
    purpose: the guest
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
    label: 'the guest',
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
      throw new Error('no session');
    },
  } as unknown as Connection;

  registry = new WorkflowRegistry({
    dirs: [workflowsDir],
  });
  registry.scan();

  const targets = new TargetRegistry({
    profileFor: (id) => (id === 'guest' ? profile : undefined),
    createConnection: () => conn,
  });
  service = new WorkflowService({
    registry,
    runDeps: {
      targets,
      profileFor: (id) => (id === 'guest' ? profile : undefined),
      audit: () => 'audit-1',
    },
  });
});

function server(): McpServer {
  return new McpServer({ workflows: service, permissions: permissionsStore(), version: TEST_VERSION });
}

/** **The unified permission area** ✓ (the gate of the agent side ✓) */
let storeSeq = 0;
function permissionsStore(): PermissionStore {
  // → **one file per store** ✓ (the store persists ✓ — a shared file would
  //   leak the settings of one case into the next one ✗)
  return new PermissionStore(join(tmpdir(), `cockpit-perm-server-${process.pid}-${storeSeq++}.json`));
}

/** Sends a JSON-RPC request */
function call(method: string, params?: unknown): Promise<Record<string, unknown>> {
  return server().handle({
    jsonrpc: '2.0',
    id: 1,
    method,
    ...(params === undefined ? {} : { params: params as Record<string, unknown> }),
  }) as Promise<Record<string, unknown>>;
}


/** **a server with the host dependencies** (the read-side tools need a host to be listed) */
function serverWithHost(): McpServer {
  return new McpServer({
    workflows: service,
    permissions: permissionsStore(),
    version: TEST_VERSION,
    host: {
      pack: () => null,
      readings: () => [],
      history: () => [],
      refreshTag: async () => undefined,
      profiles: () => [],
      capabilities: () => ({ exec: true, pty: false, files: true, exitCode: true }),
      connected: () => false,
      // **the connection of the current runtime** (**null when there is none**)
      currentProfileId: () => null,
      cards: () => [],
      cardDir: () => null,
      validateCard: () => ({
        ok: true,
        errors: [],
        warnings: [],
        resolved: { tags: [], actions: [], layout: null, missing_tags: [], missing_actions: [] },
      }),
      cardLog: () => [],
      layout: () => ({ version: 3, units: [], density: 'comfortable', updatedAt: 0 }),
      saveLayout: () => undefined,
      actions: {} as never,
    },
  });
}

describe('MCP · initialize', () => {
  it('**it returns protocolVersion / capabilities / serverInfo**', async () => {
    const res = await call('initialize', { protocolVersion: '2025-06-18' });
    const result = res['result'] as Record<string, unknown>;
    expect(result['protocolVersion']).toBe('2025-06-18');
    expect(result['capabilities']).toBeTruthy();
    expect((result['serverInfo'] as Record<string, unknown>)['name']).toBeTruthy();
  });

  it('**the tools capability is declared** (the specification: a server that offers tools **MUST** declare it)', async () => {
    const res = await call('initialize', { protocolVersion: '2025-06-18' });
    const caps = (res['result'] as Record<string, unknown>)['capabilities'] as Record<string, unknown>;
    expect(caps['tools']).toBeTruthy();
  });

  it('**the client asks for a version we do not support → we return the one we do** (specification, "Version Negotiation")', async () => {
    const res = await call('initialize', { protocolVersion: '1999-01-01' });
    const result = res['result'] as Record<string, unknown>;
    expect(result['protocolVersion']).toBe('2025-06-18');
  });

  /**
   * **The version the agent sees is the one of this application.**
   *
   * → The agent reads `serverInfo.version` ✓ and believes it ✓ → a version
   *   written into the code ✓ is a version that lies ✓ (the next release
   *   would carry the version of the one before ✓).
   * → The criterion asks for **a version nobody would write in the code** ✓
   *   (the one the test gives ✓) → **a literal would fail it** ✓.
   */
  it('**serverInfo carries the version the application gives** (**not a version written in here** ✓)', async () => {
    const res = await call('initialize', { protocolVersion: '2025-06-18' });
    const info = (res['result'] as Record<string, unknown>)['serverInfo'] as Record<string, unknown>;
    expect(info['version']).toBe(TEST_VERSION);
  });
});

describe('MCP · notifications (no response)', () => {
  it('`notifications/initialized` → **it returns null** (the HTTP layer answers 202 with an empty body)', async () => {
    const res = await server().handle({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(res).toBeNull();
  });
});

describe('MCP · tools/list', () => {
  it('**the list contains the three workflow tools** (**`confirm_workflow` is gone**)', async () => {
    const res = await call('tools/list');
    const tools = (res['result'] as Record<string, unknown>)['tools'] as {
      name: string;
      inputSchema?: unknown;
    }[];
    const names = tools.map((t) => t.name);
    expect(names).toContain('list_workflows');
    expect(names).toContain('run_workflow');
    expect(names).toContain('workflow_status');
    // **the tool that passed on a confirmation request is gone** (there is no
// "ask the operator" outcome any more)
    expect(names).not.toContain('confirm_workflow');
  });

  it('**the tool list has 19 entries** (21 → 19 — the two tools that asked the operator are gone)', async () => {
    const res = await serverWithHost().handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    const tools = (res?.['result'] as Record<string, unknown>)['tools'] as { name: string }[];
    expect(tools).toHaveLength(19);
    // **the two tools that asked the operator are gone**
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('confirm_action');
    expect(names).not.toContain('confirm_workflow');
  });

  it('**every tool carries an inputSchema** (an agent needs it to fill the arguments)', async () => {
    const res = await call('tools/list');
    const tools = (res['result'] as Record<string, unknown>)['tools'] as {
      name: string;
      inputSchema?: unknown;
    }[];
    for (const tool of tools) {
      expect(tool.inputSchema, `${tool.name} has no inputSchema`).toBeTruthy();
    }
  });

  it('**there is no tool that cancels a workflow** (contract §2.4: whether to stop is the judgement of the operator)', async () => {
    const res = await call('tools/list');
    const tools = (res['result'] as Record<string, unknown>)['tools'] as { name: string }[];
    expect(tools.map((t) => t.name)).not.toContain('cancel_workflow');
  });
});

describe('MCP · unknown method', () => {
  it('**-32601 (the method does not exist)**', async () => {
    const res = await call('nope/nope');
    const err = res['error'] as { code: number; message: string };
    expect(err.code).toBe(-32601);
  });
});

describe('MCP · get_card_sdk_docs', () => {
  it('**it is in `tools/list`** (contract §2.3)', async () => {
    const res = await call('tools/list');
    const tools = (res['result'] as Record<string, unknown>)['tools'] as { name: string }[];
    expect(tools.map((t) => t.name)).toContain('get_card_sdk_docs');
  });

  it('**it can be called** — and **the content comes from the live code**', async () => {
    const svc = serverWithHost();
    const res = (await svc.callTool('get_card_sdk_docs', { topic: 'api' })) as {
      apiVersion: string;
      topics: string[];
      content: string;
    };
    expect(res.apiVersion).toBe('devboard/v1');
    expect(res.topics).toEqual(['api']);
    // **The name of the method comes from the API registry** (it is not copied by hand)
    expect(res.content).toContain('tags.get');
  });
});

describe('MCP · the permission area is the gate of the agent side', () => {
  it('**`run_workflow` is `denied` when the permission area does not allow it** ✓ (ADR-D47 ✓ · ADR-D48 ✓)', async () => {
    const store = permissionsStore();
    store.set('agent', 'workflow:demo.run', false);
    const mcp = new McpServer({ workflows: service, permissions: store, version: TEST_VERSION });
    const res = (await mcp.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'run_workflow', arguments: { id: 'demo.run' } },
    })) as { result?: { content?: { text?: string }[] } };
    const text = res.result?.content?.[0]?.text ?? '';
    expect(text).toContain('denied');
  });

  it('**`run_workflow` runs when the permission area allows it** ✓', async () => {
    const res = (await call('tools/call', {
      name: 'run_workflow',
      arguments: { id: 'demo.run' },
    })) as { result?: { content?: { text?: string }[] } };
    const text = res.result?.content?.[0]?.text ?? '';
    expect(text).not.toContain('denied');
  });
});

describe('MCP · the three workflow tools', () => {
  it('**every response carries apiVersion** (contract §4: the version field is on every response)', async () => {
    const svc = server();
    const list = (await svc.callTool('list_workflows', {})) as unknown[];
    // **The list carries it as well** — the contract says "every response"
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

  it('`list_workflows` → **it returns only the id, the name and the input declarations** (**not the topology**)', async () => {
    const res = await server().callTool('list_workflows', {});
    const list = res as { id: string; name: string; inputs: Record<string, unknown> }[];
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('demo.run');
    expect(list[0]?.name).toBe('demo workflow');
    expect(list[0]?.inputs['project']).toBeTruthy();
    // **The roles and the machines may not show** (the contract says that in §2.4 — that is the **topology**)
    const dumped = JSON.stringify(list);
    expect(dumped).not.toContain('build');
    expect(dumped).not.toContain('guest');
    expect(dumped).not.toContain('ubuntu-ssh');
    // **The keys are only the ones the contract names** (contract §2.4: `[{ id, name, inputs }]`)
    // → one key more is one thing leaked more (`version` / `approved` / the topology may not be there)
    expect(Object.keys(list[0] as Record<string, unknown>).sort()).toEqual([
      'apiVersion',
      'id',
      'inputs',
      'name',
    ]);
  });

  it('`run_workflow` → **it returns a run_id**', async () => {
    const res = await server().callTool('run_workflow', {
      id: 'demo.run',
      inputs: { project: 'x' },
    });
    expect((res as { run_id: string }).run_id).toMatch(/^wf-/);
  });

  it('`run_workflow` runs a workflow **without such a pack** → **it fails** (it does not quietly run anyway)', async () => {
    const res = await server().callTool('run_workflow', {
      id: 'nobody.run',
      inputs: {},
    });
    const out = res as { ok?: boolean; reason?: string };
    expect(out.ok).toBe(false);
    expect(out.reason).toBeTruthy();
  });

  it('`workflow_status` → **a reduced projection** (**no outputs / inputs / role**)', async () => {
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
    // **These belong to the host side** (contract §2.4: the details stay with the host and the agent)
    expect(dumped).not.toContain('outputs');
    expect(dumped).not.toContain('inputs');
    expect(dumped).not.toContain('"role"');
    expect(dumped).not.toContain('audit_id');
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
