import { describe, it, expect } from 'vitest';
import { runWorkflow } from '../../../src/main/workflows/runner';
import { TargetRegistry } from '../../../src/main/workflows/targets';
import { parseWorkflow } from '../../../src/main/workflows/format';
import type { ConnectionProfile } from '../../../src/main/profiles/schema';
import type { Connection, ExecResult } from '../../../src/main/hal/connection';
import type { AuditRow } from '../../../src/main/actions/audit';

/**
 * **角色事实从哪来**（契约 `spec/05` §六 ✓ · `spec/02` §10.3 ✓ · ADR-D43 ✓）。
 *
 * ── 触发这件事的实测 ──
 *
 * 宿主 → 板子 `192.168.5.100`（SSH）：**网络通** ✓ · **认证失败** ✓
 * —— **那把私钥在客机上** ✓。
 *
 * → **`file.transfer` 的 `scp` 命令在**客机**上跑** ✓（命令在源目标上跑 ✓）
 * → **它要用板子的 SSH 地址** ✓ —— 而 target 角色绑的是 `board-adb` ✓
 * → **那条 profile 里没有 `host`** ✗ → **命令里的地址是空串** ✗。
 *
 * → **`options.ssh`** 就是补这个洞的 ✓ —— **它是「这条连接背后那台机器」的端点** ✓。
 * → **流程包一个字不用改** ✓（**机器专属的值不进包** ✓）。
 */
interface FakeTarget {
  profile: ConnectionProfile;
  commands: string[];
}

function harness(boardOptions: Record<string, unknown>): {
  byId: (id: string) => FakeTarget | undefined;
  deps: Parameters<typeof runWorkflow>[2];
} {
  const targets: FakeTarget[] = [
    {
      profile: {
        id: 'guest',
        label: '客机',
        transport: 'ssh',
        options: { host: '10.0.0.2', username: 'builder' },
      },
      commands: [],
    },
    {
      profile: { id: 'board', label: '板子', transport: 'adb', options: boardOptions },
      commands: [],
    },
  ];
  const byId = (id: string): FakeTarget | undefined => targets.find((t) => t.profile.id === id);

  const registry = new TargetRegistry({
    profileFor: (id) => byId(id)?.profile,
    createConnection: (profile) => {
      const target = byId(profile.id) as FakeTarget;
      const conn = {
        id: profile.id,
        transport: profile.transport,
        capabilities: () => ({ exec: true, files: true, exitCode: true, pty: false }),
        open: async () => undefined,
        close: async () => undefined,
        exec: async (command: string): Promise<ExecResult> => {
          target.commands.push(command);
          return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
        },
        pull: async () => undefined,
        push: async () => undefined,
        list: async () => [],
        openSession: async () => {
          throw new Error('测试里不开会话');
        },
      } as unknown as Connection;
      return conn;
    },
  });

  const deps = {
    targets: registry,
    profileFor: (id: string) => byId(id)?.profile,
    audit: (_row: AuditRow): string => 'audit-1',
    now: () => 1_700_000_000_000,
  };
  return { byId, deps };
}

/** 一条「客机编译 → scp 到板子」的流程 ✓ */
function transferPack() {
  return parseWorkflow(
    {
      apiVersion: 'devboard/v1',
      kind: 'Workflow',
      id: 'w.flow',
      name: 'w',
      version: '1.0.0',
      inputs: {},
      roles: {
        build: { purpose: '客机', profile: 'guest' },
        target: { purpose: '板子', profile: 'board' },
      },
      steps: [
        {
          id: 'deliver',
          kind: 'file.transfer',
          from: { role: 'build', path: 'build/hello' },
          to: { role: 'target', placement: 'user-program' },
          cmd: 'scp {from.path} {role:target.user}@{role:target.host}:{to.path}',
        },
      ],
    },
    'w.yaml',
  );
}

describe('流程 · 角色事实的来源', () => {
  it('**adb 的板子 → 事实取自 `options.ssh`** ✓（**那条 scp 要用板子的地址** ✓）', async () => {
    const h = harness({ serial: 'x', ssh: { host: '192.168.5.100', port: 22, username: 'root' } });
    await runWorkflow(transferPack(), {}, h.deps);
    const scp = h.byId('guest')?.commands.find((c) => c.startsWith('scp '));
    // **命令里有板子的地址** ✓（**不是空串** ✓）
    expect(scp).toContain('192.168.5.100');
    // **角色事实带引号** ✓（半可信 ✓ —— 同 `substitute.ts` 的规矩 ✓）
    expect(scp).toContain("'root'@'192.168.5.100'");
  });

  it('**`options.ssh.port` 也进事实** ✓', async () => {
    const h = harness({ ssh: { host: '192.168.5.100', port: 2222, username: 'root' } });
    await runWorkflow(
      parseWorkflow(
        {
          apiVersion: 'devboard/v1',
          kind: 'Workflow',
          id: 'w.flow',
          name: 'w',
          version: '1.0.0',
          inputs: {},
          roles: {
            build: { purpose: '客机', profile: 'guest' },
            target: { purpose: '板子', profile: 'board' },
          },
          steps: [
            {
              id: 'ping',
              kind: 'exec',
              role: 'build',
              cmd: 'ssh -p {role:target.port} {role:target.user}@{role:target.host}',
            },
          ],
        },
        'w.yaml',
      ),
      {},
      h.deps,
    );
    const cmd = h.byId('guest')?.commands[0];
    expect(cmd).toContain('-p 2222');
  });

  it('**ssh 的客机 → 事实仍取自 `options.host`** ✓（**从前的行为没变** ✓）', async () => {
    const h = harness({});
    await runWorkflow(
      parseWorkflow(
        {
          apiVersion: 'devboard/v1',
          kind: 'Workflow',
          id: 'w.flow',
          name: 'w',
          version: '1.0.0',
          inputs: {},
          roles: {
            build: { purpose: '客机', profile: 'guest' },
            target: { purpose: '板子', profile: 'board' },
          },
          steps: [
            {
              id: 'ping',
              kind: 'exec',
              role: 'build',
              cmd: 'ssh {role:build.user}@{role:build.host}',
            },
          ],
        },
        'w.yaml',
      ),
      {},
      h.deps,
    );
    expect(h.byId('guest')?.commands[0]).toBe("ssh 'builder'@'10.0.0.2'");
  });

  it('**板子没声明 `options.ssh` → 地址留空** ✓（**不猜** ✓ —— **不编一个地址出来** ✓）', async () => {
    const h = harness({ serial: 'x' });
    await runWorkflow(transferPack(), {}, h.deps);
    const scp = h.byId('guest')?.commands.find((c) => c.startsWith('scp '));
    // **没有编出地址** ✓
    expect(scp).not.toContain('192.168');
    expect(scp).toContain("@'':");
  });
});
