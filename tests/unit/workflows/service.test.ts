import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowRegistry } from '../../../src/main/workflows/registry';
import { WorkflowService } from '../../../src/main/workflows/service';
import type { ConnectionProfile } from '../../../src/main/profiles/schema';
import type { Connection, ExecResult } from '../../../src/main/hal/connection';
import type { AuditRow } from '../../../src/main/actions/audit';

/**
 * 流程的**宿主服务** —— 卡片与 agent 触发流程的那一层。
 *
 * ── 这三条是两份独立评审的 C1 / C2 / C3 ──
 *
 * 1. **只认 id，不认路径** → agent 不能自写一个包就跑 ✓；
 * 2. **跑之前查批准账** → 没批准的包跑不了 ✓；
 * 3. **长任务 = run_id + 轮询** → 编译要一分钟，同步返回不成立 ✓。
 */
let dir: string;
let userDir: string;
let approvalFile: string;

const PACK = {
  formatVersion: 1,
  kind: 'Workflow',
  id: 'demo.run',
  name: '演示流程',
  version: '1.0.0',
  inputs: { project: { type: 'string', required: true, maxLength: 50 } },
  roles: { build: { purpose: '客机', profile: 'guest' } },
  steps: [{ id: 'hello', kind: 'exec', role: 'build', cmd: 'echo {input:project}' }],
};

function yamlOf(pack: typeof PACK): string {
  return [
    'formatVersion: 1',
    'kind: Workflow',
    `id: ${pack.id}`,
    `name: ${pack.name}`,
    `version: ${pack.version}`,
    'inputs:',
    '  project: { type: string, required: true, maxLength: 50 }',
    'roles:',
    '  build: { purpose: 客机, profile: guest }',
    'steps:',
    '  - id: hello',
    '    kind: exec',
    '    role: build',
    '    cmd: "echo {input:project}"',
    '',
  ].join('\n');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cockpit-service-'));
  userDir = join(dir, 'workflows');
  approvalFile = join(dir, 'workflows-approved.json');
  mkdirSync(userDir, { recursive: true });
  writeFileSync(join(userDir, 'demo.yaml'), yamlOf(PACK), 'utf8');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function service(): { svc: WorkflowService; reg: WorkflowRegistry; audits: AuditRow[] } {
  const reg = new WorkflowRegistry({ dirs: [userDir], approvalFile });
  reg.scan();
  const audits: AuditRow[] = [];
  const profiles = new Map<string, ConnectionProfile>([
    ['guest', { id: 'guest', label: '客机', transport: 'ssh', options: { host: '10.0.0.2' } }],
  ]);
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
  const svc = new WorkflowService({
    registry: reg,
    runDeps: {
      targets: {
        connectionFor: async () => conn,
        runOn: async <T>(_id: string, fn: (c: Connection) => Promise<T>): Promise<T> => fn(conn),
        closeAll: async () => undefined,
        openCount: 0,
      } as never,
      profileFor: (id) => profiles.get(id),
      audit: (row) => {
        audits.push(row);
        return `audit-${audits.length}`;
      },
      now: () => 1_700_000_000_000,
    },
    now: () => 1_700_000_000_000,
  });
  return { svc, reg, audits };
}

describe('流程服务 · 只认 id，不认路径', () => {
  it('**没批准的流程跑不了**', () => {
    const { svc } = service();
    expect(() => svc.start('demo.run', { project: 'x' })).toThrow(/还没有被批准/);
  });

  it('**批准之后能跑**，而且**列表里只列批过的**', () => {
    const { svc, reg } = service();
    reg.approve('demo.run');
    expect(svc.list().map((w) => w.id)).toEqual(['demo.run']);
    expect(() => svc.start('demo.run', { project: 'x' })).not.toThrow();
  });

  it('列表里带**输入声明**（卡片要按它渲染表单 ✓）', () => {
    const { svc, reg } = service();
    reg.approve('demo.run');
    const first = svc.list()[0];
    expect(first?.inputs['project']).toEqual({
      type: 'string',
      required: true,
    });
  });

  it('**没有这个流程** → 报错（说清楚 ✓）', () => {
    const { svc, reg } = service();
    reg.approve('demo.run');
    expect(() => svc.start('nobody', {})).toThrow(/没有这个流程包/);
  });
});

describe('流程服务 · 长任务 = run_id + 轮询', () => {
  it('`start` **立刻给 runId**（不等跑完 ✓）', () => {
    const { svc, reg } = service();
    reg.approve('demo.run');
    const started = svc.start('demo.run', { project: 'x' });
    expect(started.runId).toMatch(/^wf-/);
  });

  it('跑完之后 `status` **有完整的时间线**', async () => {
    const { svc, reg } = service();
    reg.approve('demo.run');
    const { runId } = svc.start('demo.run', { project: 'x' });
    // **等它跑完**（测试里轮询 ✓）
    for (let i = 0; i < 50 && svc.status(runId).state === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const status = svc.status(runId);
    expect(status.state).toBe('done');
    expect(status.ok).toBe(true);
    expect(status.stages).toHaveLength(1);
    expect(status.stages[0]?.audit_id).toBeTruthy();
  });

  it('**没有这次运行** → 报错', () => {
    const { svc } = service();
    expect(() => svc.status('wf-nope')).toThrow(/没有这次运行/);
  });

  it('每次运行**一行审计**（追责 ✓）', async () => {
    const { svc, reg, audits } = service();
    reg.approve('demo.run');
    const { runId } = svc.start('demo.run', { project: 'x' });
    for (let i = 0; i < 50 && svc.status(runId).state === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(audits.length).toBeGreaterThan(0);
    expect(audits[0]?.actor).toMatch(/^workflow:/);
  });
});
