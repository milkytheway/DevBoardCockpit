import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowRegistry } from '../../../src/main/workflows/registry';
import { WorkflowService } from '../../../src/main/workflows/service';
import type { WorkflowRunDeps } from '../../../src/main/workflows/runner';
import type { ConnectionProfile } from '../../../src/main/profiles/schema';
import type { Connection, ExecResult } from '../../../src/main/hal/connection';
import type { AuditRow } from '../../../src/main/actions/audit';
import { ConfirmationStore } from '../../../src/main/actions/authorization';

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

interface TestPack {
  apiVersion: string;
  kind: string;
  id: string;
  name: string;
  version: string;
  inputs: Record<string, { type: string; required?: boolean; maxLength?: number }>;
  roles: Record<string, { purpose: string; profile: string }>;
  steps: { id: string; kind: string; role: string; cmd: string; danger?: string }[];
}

const PACK: TestPack = {
  apiVersion: 'devboard/v1',
  kind: 'Workflow',
  id: 'demo.run',
  name: '演示流程',
  version: '1.0.0',
  inputs: { project: { type: 'string', required: true, maxLength: 50 } },
  roles: { build: { purpose: '客机', profile: 'guest' } },
  steps: [{ id: 'hello', kind: 'exec', role: 'build', cmd: 'echo {input:project}' }],
};

/** 一个带 destructive 步的流程（**要人点头** ✓） */
const DANGEROUS_PACK = {
  ...PACK,
  id: 'demo.danger',
  steps: [
    {
      id: 'danger',
      kind: 'exec',
      role: 'build',
      danger: 'destructive',
      cmd: 'echo {input:project}',
    },
  ],
} as TestPack;

function yamlOf(pack: TestPack): string {
  const steps = pack.steps
    .map((s) =>
      [
        `  - id: ${s.id}`,
        `    kind: ${s.kind}`,
        `    role: ${s.role}`,
        ...(s.danger === undefined ? [] : [`    danger: ${s.danger}`]),
        `    cmd: "${s.cmd}"`,
      ].join('\n'),
    )
    .join('\n');
  return [
    'apiVersion: devboard/v1',
    'kind: Workflow',
    `id: ${pack.id}`,
    `name: ${pack.name}`,
    `version: ${pack.version}`,
    'inputs:',
    '  project: { type: string, required: true, maxLength: 50 }',
    'roles:',
    '  build: { purpose: 客机, profile: guest }',
    'steps:',
    steps,
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

function service(
  pack: TestPack = PACK,
): {
  svc: WorkflowService;
  reg: WorkflowRegistry;
  audits: AuditRow[];
  confirmations: ConfirmationStore;
  deps: WorkflowRunDeps;
} {
  // **换一个包**（测试要能造 destructive 的那一种 ✓）
  writeFileSync(join(userDir, 'demo.yaml'), yamlOf(pack), 'utf8');
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
  const confirmations = new ConfirmationStore();
  const deps: WorkflowRunDeps = {
    confirmations,
    // （连接替身：所有目标都走同一条假连接 ✓ —— 流程层的单测不测传输 ✓）
    targets: {
      connectionFor: async () => conn,
      runOn: async <T>(_id: string, fn: (c: Connection) => Promise<T>): Promise<T> => fn(conn),
      closeAll: async () => undefined,
      openCount: 0,
    } as never,
    profileFor: (id: string) => profiles.get(id),
    audit: (row: AuditRow) => {
      audits.push(row);
      return `audit-${audits.length}`;
    },
    now: () => 1_700_000_000_000,
  };
  const svc = new WorkflowService({
    registry: reg,
    confirmations,
    runDeps: deps,
  });
  return { svc, reg, audits, confirmations, deps };
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

describe('流程服务 · 确认链的落点（人点头 → 继续跑）', () => {
  it('destructive 步 → **停在等确认**（不是失败 ✓）', async () => {
    const { svc, reg } = service(DANGEROUS_PACK);
    reg.approve('demo.danger');
    const { runId } = svc.start('demo.danger', { project: 'x' });
    for (let i = 0; i < 50 && svc.status(runId).state === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const status = svc.status(runId);
    // **这一档是「等确认」**，不是 failed ✓
    expect(status.state).toBe('awaiting_confirmation');
    expect(status.needsConfirmation?.stepId).toBe('danger');
    expect(status.pausedAtStep).toBe(0);
  });

  it('**人点头之后继续跑**（前面的步**不重跑** ✓）', async () => {
    const h = service(DANGEROUS_PACK);
    h.reg.approve('demo.danger');
    const { runId } = h.svc.start('demo.danger', { project: 'x' });
    for (let i = 0; i < 50 && h.svc.status(runId).state === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const token = h.svc.status(runId).needsConfirmation?.confirmId as string;
    expect(token).toBeTruthy();

    // **点头**（就是「人点了」那一下 ✓）
    h.svc.approveAndResume(runId, token);
    for (let i = 0; i < 50 && h.svc.status(runId).state === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const status = h.svc.status(runId);
    expect(status.state).toBe('done');
    expect(status.ok).toBe(true);
  });

  it('**没点头就不许继续**（凭据还在待确认 ✓）', async () => {
    const { svc, reg } = service(DANGEROUS_PACK);
    reg.approve('demo.danger');
    const { runId } = svc.start('demo.danger', { project: 'x' });
    for (let i = 0; i < 50 && svc.status(runId).state === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // **拿一张没被批准的凭据去续跑** → 拒绝 ✓
    expect(() => svc.approveAndResume(runId, 'cf-fake')).toThrow(/还没被批准/);
  });

  it('**agent 只能「请求」确认，不能自己批准**（V3-C1 ✓）', async () => {
    const h = service(DANGEROUS_PACK);
    h.reg.approve('demo.danger');
    const { runId } = h.svc.start('demo.danger', { project: 'x' });
    for (let i = 0; i < 50 && h.svc.status(runId).state === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // **请求** → 只是递进队列 ✓，**凭据仍然无效** ✓
    const requested = h.svc.requestConfirmation(runId);
    expect(requested.confirmId).toBeTruthy();
    expect(h.confirmations.isApproved(requested.confirmId)).toBe(false);
    // → 流程**还在等**（没被批准就跑不了 ✓）
    expect(h.svc.status(runId).state).toBe('awaiting_confirmation');
  });

  it('**卡级授权**：这张卡没被授过这个流程 → 跑不了（V3-I9 ✓）', () => {
    const h = service();
    h.reg.approve('demo.run');
    // **这张卡只被授过别的流程** ✓ → 跑这个流程要被拒 ✓
    const svc = new WorkflowService({
      registry: h.reg,
      confirmations: h.confirmations,
      grantedWorkflows: () => ['other.flow'],
      runDeps: h.deps,
    });
    expect(() => svc.start('demo.run', { project: 'x' }, { cardId: 'card-1' })).toThrow(/没有被授权/);
    // **授过了就放行** ✓
    const granted = new WorkflowService({
      registry: h.reg,
      confirmations: h.confirmations,
      grantedWorkflows: () => ['demo.run'],
      runDeps: h.deps,
    });
    expect(() => granted.start('demo.run', { project: 'x' }, { cardId: 'card-1' })).not.toThrow();
  });

  it('**同一个流程同时只允许跑一次**（两个流程抢一条串口会串台 ✓）', async () => {
    const h = service();
    h.reg.approve('demo.run');
    const { runId } = h.svc.start('demo.run', { project: 'x' });
    // **还在跑** → 第二次要被拒 ✓
    expect(() => h.svc.start('demo.run', { project: 'x' })).toThrow(/正在跑/);
    // 等它跑完 → 就能再跑 ✓
    for (let i = 0; i < 50 && h.svc.status(runId).state === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(() => h.svc.start('demo.run', { project: 'x' })).not.toThrow();
  });

  it('**取消**：状态变 cancelled（**不是 failed** ✓），且在飞的那一步真停 ✓', async () => {
    const h = service();
    h.reg.approve('demo.run');
    const { runId } = h.svc.start('demo.run', { project: 'x' });
    // **取消** ✓
    h.svc.cancel(runId);
    const status = h.svc.status(runId);
    // **取消不是失败** ✓（契约 §八·3 的状态机 ✓）
    expect(status.state).toBe('cancelled');
    expect(status.reason).toBe('cancelled');
  });

  it('**取消一个不存在的运行 → 报错** ✓', () => {
    const { svc } = service();
    expect(() => svc.cancel('wf-nope')).toThrow(/没有这次运行/);
  });

  it('不是「等确认」的状态 → 不能 confirm', () => {
    const { svc } = service();
    expect(() => svc.approveAndResume('wf-nope', 'cf-x')).toThrow(/没有这次运行/);
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
