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

/**
 * 流程的**宿主服务** —— 卡片与 agent 触发流程的那一层。
 *
 * ── 这三条是两份独立评审的 C1 / C2 / C3 ──
 *
 * 1. **只认 id，不认路径** → agent 不能自写一个包就跑 ✓；
 * 2. **跑之前查批准账** → **那一层没了** ✓（**2026-11-16 改** ✓ · ADR-D48 ✓）——
 *    **流程包的存在本身就是说明** ✓ —— **闸在设置里的统一权限区** ✓（ADR-D47 ✓）；
 * 3. **长任务 = run_id + 轮询** → 编译要一分钟，同步返回不成立 ✓。
 */
let dir: string;
let userDir: string;

interface TestPack {
  apiVersion: string;
  kind: string;
  id: string;
  name: string;
  version: string;
  inputs: Record<string, { type: string; required?: boolean; maxLength?: number; default?: unknown }>;
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

/** 两步的流程（**看「跑到一半」那一下用** ✓） */
const TWO_STEP_PACK: TestPack = {
  ...PACK,
  steps: [
    { id: 'one', kind: 'exec', role: 'build', cmd: 'echo {input:project}' },
    { id: 'two', kind: 'exec', role: 'build', cmd: 'echo second' },
  ],
};

/** 一个带 destructive 步的流程（**危险等级只是信息** ✓ —— **不再问人** ✓） */
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
    // **有 default 的输入也要写进去** ✓（契约 §二 ✓）
    ...Object.entries(pack.inputs)
      .filter(([, def]) => def.default !== undefined)
      .map(([name, def]) => `  ${name}: { type: ${def.type}, default: ${def.default} }`),
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
  mkdirSync(userDir, { recursive: true });
  writeFileSync(join(userDir, 'demo.yaml'), yamlOf(PACK), 'utf8');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function service(
  pack: TestPack = PACK,
  harnessOpts: { gate?: boolean; throwOnAudit?: boolean } = {},
): {
  svc: WorkflowService;
  reg: WorkflowRegistry;
  audits: AuditRow[];
  deps: WorkflowRunDeps;
  /** 放一条卡着的命令过去 ✓ */
  releaseOne: () => void;
  /** 等到有 n 条命令卡着 ✓ */
  untilWaiting: (n: number) => Promise<void>;
  /** 审计被调用了几次 ✓（用来等「那一步真的跑完了」✓） */
  auditCount: () => number;
} {
  // **换一个包**（测试要能造 destructive 的那一种 ✓）
  writeFileSync(join(userDir, 'demo.yaml'), yamlOf(pack), 'utf8');
  const reg = new WorkflowRegistry({ dirs: [userDir] });
  reg.scan();
  const audits: AuditRow[] = [];
  const throwOnAudit = harnessOpts.throwOnAudit === true;
  let auditCalls = 0;
  const profiles = new Map<string, ConnectionProfile>([
    ['guest', { id: 'guest', label: '客机', transport: 'ssh', options: { host: '10.0.0.2' } }],
  ]);
  // **闸门**：命令卡住，直到测试放它过去 ✓
  // → 「跑到一半」这件事**得能被看见** ✓（不然只能靠 sleep 猜 ✗）
  const waiting: (() => void)[] = [];
  const conn = {
    id: 'guest',
    transport: 'ssh',
    capabilities: () => ({ exec: true, files: true, exitCode: true, pty: false }),
    open: async () => undefined,
    close: async () => undefined,
    // **认取消信号** ✓（真的 HAL 认 ✓ —— 假设备不认的话，
    // 「在飞的那一步真停」这条判据**永远测不到** ✗）
    // → 而且**给它 20ms 的窗口** ✓（否则取消总是晚一步 ✗）
    exec: async (_command: string, opts?: { signal?: AbortSignal }): Promise<ExecResult> => {
      if (harnessOpts.gate === true) {
        await new Promise<void>((r) => waiting.push(r));
      } else {
        await new Promise((r) => setTimeout(r, 20));
      }
      const cancelled = opts?.signal?.aborted === true;
      return {
        exitCode: cancelled ? null : 0,
        stdout: 'hi',
        stderr: '',
        durationMs: 20,
        timedOut: false,
        ...(cancelled ? { cancelled: true } : {}),
      };
    },
    pull: async () => undefined,
    push: async () => undefined,
    list: async () => [],
    openSession: async () => {
      throw new Error('不开会话');
    },
  } as unknown as Connection;
  const deps: WorkflowRunDeps = {
    // （连接替身：所有目标都走同一条假连接 ✓ —— 流程层的单测不测传输 ✓）
    targets: {
      connectionFor: async () => conn,
      runOn: async <T>(_id: string, fn: (c: Connection) => Promise<T>): Promise<T> => fn(conn),
      closeAll: async () => undefined,
      openCount: 0,
    } as never,
    profileFor: (id: string) => profiles.get(id),
    audit: (row: AuditRow) => {
      // **审计抛错** → 用来走到**服务层的 catch 路径** ✓（独立评审 40 的 I-1 ✓）
      // ⚠️ **第二次才抛** ✓ —— 第一次是 `cancel()` 自己那行审计 ✓（它不该炸 ✓）
      auditCalls += 1;
      if (throwOnAudit && auditCalls > 1) throw new Error('审计炸了');
      audits.push(row);
      return `audit-${audits.length}`;
    },
    now: () => 1_700_000_000_000,
  };
  const svc = new WorkflowService({
    registry: reg,
    runDeps: deps,
  });
  return {
    svc,
    reg,
    audits,
    deps,
    releaseOne: () => waiting.shift()?.(),
    auditCount: () => auditCalls,
    untilWaiting: async (n: number): Promise<void> => {
      for (let i = 0; i < 200 && waiting.length < n; i += 1) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(waiting.length).toBeGreaterThanOrEqual(n);
    },
  };
}

describe('流程服务 · 只认 id，不认路径', () => {
  it('**没批准的流程包也能跑** ✓（**存在即说明** ✓ —— ADR-D48 ✓）', () => {
    const { svc } = service();
    // **不再有「有没有被批准」那一问** ✓（**闸在设置里的统一权限区** ✓）
    expect(() => svc.start('demo.run', { project: 'x' })).not.toThrow();
  });

  it('**列表里列得出全部的包** ✓（**不再有「没批过的就不列」** ✓）', () => {
    const { svc } = service();
    expect(svc.list().map((w) => w.id)).toEqual(['demo.run']);
    expect(svc.list()[0]?.name).toBe('演示流程');
  });

  it('列表里的输入声明**带 default**（卡片要能自己预填 ✓ —— 独立评审 40 的 I-3 ✓）', () => {
    const h = service({
      ...PACK,
      inputs: { project: { type: 'string', required: true, maxLength: 50 }, count: { type: 'integer', default: 5 } },
    });
    const first = h.svc.list()[0];
    expect(first?.inputs['count']).toEqual({ type: 'integer', default: 5 });
  });

  it('列表里带**输入声明**（卡片要按它渲染表单 ✓）', () => {
    const { svc } = service();
    const first = svc.list()[0];
    expect(first?.inputs['project']).toEqual({
      type: 'string',
      required: true,
    });
  });

  it('**没有这个流程** → 报错（说清楚 ✓）', () => {
    const { svc } = service();
    expect(() => svc.start('nobody', {})).toThrow(/没有这个流程包/);
  });
});

describe('流程服务 · 流程包的闸（**存在即说明** ✓ —— ADR-D48 ✓）', () => {
  it('destructive 步 → **直接跑完**（**不再停在等确认** ✓ —— **危险等级只是信息** ✓）', async () => {
    const { svc } = service(DANGEROUS_PACK);
    const { runId } = svc.start('demo.danger', { project: 'x' });
    for (let i = 0; i < 50 && svc.status(runId).state === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const status = svc.status(runId);
    // **跑完了** ✓（**不是「等确认」** ✓ —— **那一档没了** ✓）
    expect(status.state).toBe('done');
    expect(status.ok).toBe(true);
    // **那一步真的在时间线上** ✓
    expect(status.stages.map((s) => s.stepId)).toEqual(['danger']);
  });

  it('**卡级授权没了**：**流程包在目录里就谁都能跑** ✓（ADR-D46 ✓）', () => {
    const h = service();
    // **卡片触发** ✓ —— **不再有「这张卡被授过吗」那一问** ✓
    expect(() => h.svc.start('demo.run', { project: 'x' })).not.toThrow();
  });

  it('**不再有「批准账」那一问** ✓（**流程包存在即说明** ✓ —— ADR-D48 ✓）', () => {
    const h = service();
    // **同一个包连着跑两次都放行** ✓（**没有「批过没批过」的差别** ✓）
    expect(() => h.svc.start('demo.run', { project: 'x' })).not.toThrow();
  });

  it('**同一个流程同时只允许跑一次**（两个流程抢一条串口会串台 ✓）', async () => {
    const h = service();
    const { runId } = h.svc.start('demo.run', { project: 'x' });
    // **还在跑** → 第二次要被拒 ✓
    expect(() => h.svc.start('demo.run', { project: 'x' })).toThrow(/正在跑/);
    // 等它跑完 → 就能再跑 ✓
    for (let i = 0; i < 50 && h.svc.status(runId).state === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(() => h.svc.start('demo.run', { project: 'x' })).not.toThrow();
  });

  it('**取消**：状态变 cancelled（**不是 failed** ✓）', async () => {
    const h = service();
    const { runId } = h.svc.start('demo.run', { project: 'x' });
    // **取消** ✓
    h.svc.cancel(runId);
    const status = h.svc.status(runId);
    // **取消不是失败** ✓（契约 §八·3 的状态机 ✓）
    expect(status.state).toBe('cancelled');
    expect(status.reason).toBe('cancelled');
  });

  it('**取消之后它自己收尾时，不能把状态翻回去**（await 那次 unwind 之后仍然是 cancelled ✓）', async () => {
    const h = service();
    const { runId } = h.svc.start('demo.run', { project: 'x' });
    h.svc.cancel(runId);

    // **等它自己收尾** ✓（时间线出现 = 收尾走完了 ✓）
    for (let i = 0; i < 50 && h.svc.status(runId).stages.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(h.svc.status(runId).stages.length).toBeGreaterThan(0);

    // ⚠️ **这一条是独立评审 40 的 C-1** ✓：
    // 取消是**同步**置上的 ✓，但那次运行**自己 unwind 的时候**会再写一次状态 ✓ ——
    // → 「取消」这个状态**必须活到最后** ✓（否则界面会把「人叫停」说成「出错了」✗）
    expect(h.svc.status(runId).state).toBe('cancelled');
    expect(h.svc.status(runId).reason).toBe('cancelled');
  });

  it('**被取消的那一步，理由写 cancelled**（不是「回读不符」✓ —— 人叫停 ≠ 板子不听话 ✓）', async () => {
    const h = service();
    const { runId } = h.svc.start('demo.run', { project: 'x' });
    h.svc.cancel(runId);
    for (let i = 0; i < 50 && h.svc.status(runId).stages.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const stage = h.svc.status(runId).stages[0];
    expect(stage?.ok).toBe(false);
    // ⚠️ 取消的退出码是 `null` ✓ → 不看 `cancelled` 标志就会掉进「返回非 0」那一档 ✗
    expect(stage?.reason).toBe('cancelled');
  });

  it('**取消一个已经跑完的运行 → 状态不变**（幂等 ✓ —— 不能把 done 改成 cancelled ✗）', async () => {
    const h = service();
    const { runId } = h.svc.start('demo.run', { project: 'x' });
    // **等它跑完** ✓
    for (let i = 0; i < 50 && h.svc.status(runId).state === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const before = h.svc.status(runId).state;
    expect(before).toBe('done');

    // **取消一个已经结束的运行** → 不该改它的状态 ✓
    h.svc.cancel(runId);
    expect(h.svc.status(runId).state).toBe(before);
  });

  it('**取消之后走了异常路径 → 状态仍是 cancelled**（不是 failed ✓）', async () => {
    // ⚠️ **独立评审 40 的 I-1** ✓：成功路径有守卫 ✓，**catch 路径没有** ✓
    // → 取消之后只要有任何异常到达 execute ✓，界面上的「人叫停」就被说成「出错了」✗
    const h = service(PACK, { gate: true, throwOnAudit: true });
    const { runId } = h.svc.start('demo.run', { project: 'x' });
    await h.untilWaiting(1);

    // **取消** ✓
    h.svc.cancel(runId);
    expect(h.svc.status(runId).state).toBe('cancelled');

    // **放它过去** ✓ → 那一步跑完 ✓ → 审计抛错 ✓ → 服务层的 catch 路径 ✓
    h.releaseOne();
    // ⚠️ **不能等状态变** ✓ —— 取消后它已经是 `cancelled` ✓（不是 `running` ✓）
    // → 那样循环直接跳过 ✓，断言在异常发生**之前**就跑了 ✓ → **判据是空的** ✗
    // → 改成等「审计真的被调到第 2 次」✓（那就是那一步跑完的信号 ✓）
    for (let i = 0; i < 50 && h.auditCount() < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(h.auditCount()).toBeGreaterThanOrEqual(2);
    // **异常处理完之后再看状态** ✓
    await new Promise((r) => setTimeout(r, 20));
    // **「人叫停」必须活到最后** ✓（契约 §八·A·A2 ✓）
    expect(h.svc.status(runId).state).toBe('cancelled');
  });

  it('**取消要记一行审计**（「谁叫停的」查得到 ✓）', async () => {
    const h = service();
    const { runId } = h.svc.start('demo.run', { project: 'x' });
    h.svc.cancel(runId);
    const cancelRows = h.audits.filter((r) => r.actionId.endsWith(':cancel'));
    expect(cancelRows).toHaveLength(1);
    expect(cancelRows[0]?.params['runId']).toBe(runId);
  });

  it('**跑到一半，`status` 说得出「现在在第几步、从什么时候开始」**（界面不能一片死寂 ✓）', async () => {
    const h = service(TWO_STEP_PACK, { gate: true });
    const { runId } = h.svc.start('demo.run', { project: 'x' });
    await h.untilWaiting(1);

    // **那一步还在跑** ✓ → 「现在在第几步」要说得出 ✓
    const running = h.svc.status(runId);
    expect(running.current?.stepId).toBe('one');
    expect(running.current?.at).toBeGreaterThan(0);

    // **跑完之后 → current 变 null** ✓（运行结束了就没有「当前」了 ✓）
    h.releaseOne();
    await h.untilWaiting(1); // 第二步卡住了 ✓
    h.releaseOne();
    for (let i = 0; i < 50 && h.svc.status(runId).state === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(h.svc.status(runId).current).toBeNull();
  });

  it('**时间线边跑边填**（不是跑完才给 ✓）', async () => {
    const h = service(TWO_STEP_PACK, { gate: true });
    const { runId } = h.svc.start('demo.run', { project: 'x' });
    await h.untilWaiting(1);

    // **第一步还没跑完 → 时间线是空的** ✓
    expect(h.svc.status(runId).stages).toHaveLength(0);

    // **放第一步过去** ✓ → 第二步卡住 ✓
    h.releaseOne();
    await h.untilWaiting(1);

    // **时间线已经有第一行了** ✓（不是等整条跑完才有 ✓）
    expect(h.svc.status(runId).stages.map((s) => s.stepId)).toEqual(['one']);
    // **「现在在第几步」也跟着走到第二步** ✓
    expect(h.svc.status(runId).current?.stepId).toBe('two');
  });

  it('**取消一个不存在的运行 → 报错** ✓', () => {
    const { svc } = service();
    expect(() => svc.cancel('wf-nope')).toThrow(/没有这次运行/);
  });
});

describe('流程服务 · 长任务 = run_id + 轮询', () => {
  it('`start` **立刻给 runId**（不等跑完 ✓）', () => {
    const { svc } = service();
    const started = svc.start('demo.run', { project: 'x' });
    expect(started.runId).toMatch(/^wf-/);
  });

  it('跑完之后 `status` **有完整的时间线**', async () => {
    const { svc } = service();
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
    const { svc, audits } = service();
    const { runId } = svc.start('demo.run', { project: 'x' });
    for (let i = 0; i < 50 && svc.status(runId).state === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(audits.length).toBeGreaterThan(0);
    expect(audits[0]?.actor).toMatch(/^workflow:/);
  });
});
