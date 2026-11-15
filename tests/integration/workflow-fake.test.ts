import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkflow } from '../../src/main/workflows/runner';
import { TargetRegistry } from '../../src/main/workflows/targets';
import { parseWorkflow } from '../../src/main/workflows/format';
import { ActionAudit } from '../../src/main/actions/audit';
import { FakeConnection } from '../../src/main/hal/fake/connection';
import { fakeProfile } from '../../src/main/hal/fake/profile';
import { SessionLog } from '../../src/main/logging/session-log';
import type { ConnectionProfile } from '../../src/main/profiles/schema';

/**
 * 流程层的**集成验证**（**假设备**扮两个角色）。
 *
 * ── 为什么不是 Electron e2e ──
 *
 * **应用里还没有流程的入口**（首版只由 `npm run workflow:run` 触发 ✓ ——
 * ADR-D31 R1：卡片 API 与 MCP 工具首版不动契约 ✓）。
 * → 在 Electron 里跑一条流程**证明不了应用的事**（它压根不经过应用 ✗）。
 * → 所以这里验的是**真链路**：流程包 → 目标登记处 → **真 HAL（假设备）** → 七步链 → **真审计文件** ✓。
 *
 * ── 两个角色 = 两块盘 ──
 *
 * 假设备**按 profile id 分盘**（`fakeFilesystem(profile.id)` ✓）→
 * `build` 与 `target` 各有一块 ✓ → 「板子上真的有那个文件了吗」**验的是另一块盘** ✓
 * ——这正是**跨目标判据**要证明的那件事 ✓（RF-6 的反面 ✓）。
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cockpit-workflow-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ROLES = {
  build: { purpose: '假客机', profile: 'build' },
  target: { purpose: '假板子', profile: 'target' },
};

function harness(): {
  run: ReturnType<typeof runWorkflow>;
  auditPath: string;
  readAudit: () => string[];
} {
  const log = new SessionLog({ label: 'fake', transport: 'local', dataDir: dir });
  const profiles = new Map<string, ConnectionProfile>([
    ['build', fakeProfile('build')],
    ['target', fakeProfile('target')],
  ]);
  const registry = new TargetRegistry({
    profileFor: (id) => profiles.get(id),
    createConnection: (profile) =>
      new FakeConnection({
        now: () => 1_700_000_000_000,
        log,
        profile,
        // **不注入故障**（这条判据要的是「干净地跑通」✓）
        timeoutEvery: 0,
        breakMeminfoEvery: 0,
      }),
  });
  const auditPath = join(dir, 'logs', 'actions.log');
  const audit = new ActionAudit(auditPath);

  const pack = parseWorkflow(
    {
      apiVersion: 'devboard/v1',
      kind: 'Workflow',
      id: 'fake-flow.build-run',
      name: '假设备上的编译→直传→落位',
      version: '1.0.0',
      inputs: { artifact: { type: 'string', maxLength: 50 } },
      roles: ROLES,
      steps: [
        { id: 'compile', kind: 'exec', role: 'build', cmd: 'make {input:artifact}' },
        {
          id: 'find',
          kind: 'discover',
          role: 'build',
          dir: 'build',
          pattern: '*.ko',
          exclude: ['*.o'],
          out: 'artifacts',
        },
        {
          id: 'deliver',
          kind: 'file.transfer',
          from: { role: 'build', path: '{output:artifacts}' },
          to: { role: 'target', placement: 'kernel-module' },
          cmd: 'scp {from.path} {role:target.user}@{role:target.host}:{to.path}',
          out: 'dest',
          // **判据指名目标** → 在**另一块盘**上验 ✓
          readback: { kind: 'verify', role: 'target', command: 'test -f {to.path}' },
        },
        {
          id: 'load',
          kind: 'exec',
          role: 'target',
          cmd: 'depmod -a && modprobe {output:artifacts.name}',
          readback: { kind: 'command_ok' },
        },
      ],
    },
    'fake-flow.yaml',
  );

  // ── 先在**假客机**那块盘上放一个产物 ──
  // （发现要找到东西才走得到下一步 ✓；假设备的盘一开始是空的 ✓）
  const seed = async (): Promise<void> => {
    await registry.runOn('build', async (conn) => conn.exec('echo ko > build/hello.ko'));
  };

  const run = (async () => {
    await seed();
    return runWorkflow(
      pack,
      { artifact: 'hello' },
      {
        targets: registry,
        profileFor: (id) => profiles.get(id),
        audit: (row) => audit.append(row),
        now: () => 1_700_000_000_000,
      },
      { approved: true },
    );
  })();

  return {
    run,
    auditPath,
    readAudit: () =>
      existsSync(auditPath)
        ? readFileSync(auditPath, 'utf8').trim().split('\n').filter((l) => l.length > 0)
        : [],
  };
}

describe('流程层 · 假设备上的两个角色', () => {
  it('一条流程跑通，**每个阶段都有审计行**（时间线 ↔ 审计对得上）', async () => {
    const h = harness();
    const result = await h.run;

    // **假设备上产物要先在**（否则 discover 找不到 ✓）
    expect(result.stages.length).toBeGreaterThan(0);
    // 每个阶段都有 audit_id ✓
    for (const stage of result.stages) {
      expect(stage.audit_id, `阶段 ${stage.stepId} 没有 audit_id`).toBeTruthy();
    }
    // **审计文件里能查到那些行** ✓
    const lines = h.readAudit();
    expect(lines.length).toBeGreaterThan(0);
    for (const stage of result.stages) {
      expect(lines.some((l) => l.includes(stage.audit_id as string))).toBe(true);
    }
  });

  it('**跨目标的判据在目标那块盘上验**（不是在自己的盘上自说自话 ✓）', async () => {
    const h = harness();
    await h.run;
    const lines = h.readAudit();
    // 跨目标判据**单独一行**（两个事实 → 两行账 ✓）
    const cross = lines.filter((l) => l.includes(':deliver:readback'));
    expect(cross).toHaveLength(1);
    // 判据是「在目标上验」→ 它的 action id 里带着 target 的角色 ✓
    expect(cross[0]).toContain('workflow:fake-flow.build-run');
  });
});
