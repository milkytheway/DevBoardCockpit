import { describe, it, expect } from 'vitest';
import { runWorkflow } from '../../../src/main/workflows/runner';
import { TargetRegistry } from '../../../src/main/workflows/targets';
import { parseWorkflow } from '../../../src/main/workflows/format';
import type { ConnectionProfile } from '../../../src/main/profiles/schema';
import type { Connection, ExecResult } from '../../../src/main/hal/connection';
import type { AuditRow } from '../../../src/main/actions/audit';
import type { FileEntry } from '../../../src/shared/ipc-contract';

/**
 * 流程执行器 —— **把「一件事怎么做」跑出来**。
 *
 * ── 这几条判据在防什么 ──
 *
 * | 判据 | 防的是 |
 * |---|---|
 * | 命令**发到指名的目标上** | 「客机那一步跑到了板子上」 |
 * | 输入**按类型编码** | `; reboot` 这种注入 |
 * | 危险命令**要人确认** | 流程成了「在用户机器上跑任意命令」的通道 |
 * | 判据**在指名的角色上读** | 「板子上没有产物」被判成「有」（假阳性） |
 * | **每步一行审计** | 事后追不了责 |
 */
interface FakeTarget {
  profile: ConnectionProfile;
  commands: string[];
  files: FileEntry[];
  /** 这个目标上 `cat -- <path>` 的答案 */
  catAnswers: Record<string, string>;
}

function harness(opts: { files?: Record<string, FileEntry[]>; onExec?: (command: string) => void } = {}) {
  const targets: FakeTarget[] = [
    {
      profile: { id: 'guest', label: '客机', transport: 'ssh', options: { host: '10.0.0.2', username: 'builder' } },
      commands: [],
      files: [],
      catAnswers: {},
    },
    {
      profile: { id: 'board', label: '板子', transport: 'adb', options: {} },
      commands: [],
      files: [],
      catAnswers: {},
    },
  ];
  const byId = (id: string): FakeTarget | undefined => targets.find((t) => t.profile.id === id);
  /** 取一个目标（没有就抛——测试里写错了要立刻知道） */
  const target = (id: string): FakeTarget => {
    const found = byId(id);
    if (found === undefined) throw new Error(`没有这个测试目标：${id}`);
    return found;
  };
  for (const t of targets) {
    if (opts.files?.[t.profile.id] !== undefined) t.files = opts.files[t.profile.id] as FileEntry[];
  }

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
          // **测试可以在这里叫停** ✓（「在飞的那一步被取消」✓）
          opts.onExec?.(command);
          if (command.startsWith('cat -- ')) {
            const path = command.slice('cat -- '.length).replace(/^'|'$/g, '');
            const answer = target.catAnswers[path];
            return answer === undefined
              ? { exitCode: 1, stdout: '', stderr: 'No such file', durationMs: 1, timedOut: false }
              : { exitCode: 0, stdout: answer, stderr: '', durationMs: 1, timedOut: false };
          }
          if (command === 'uname -r') {
            return { exitCode: 0, stdout: '6.1.141\n', stderr: '', durationMs: 1, timedOut: false };
          }
          if (command.includes('id_ed25519.pub')) {
            // **公钥那一步要真的产出东西**（凭据准备靠它 ✓）
            return {
              exitCode: 0,
              stdout: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI-test claude-sandbox\n',
              stderr: '',
              durationMs: 1,
              timedOut: false,
            };
          }
          return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
        },
        pull: async () => undefined,
        push: async () => undefined,
        list: async (dir: string): Promise<FileEntry[]> =>
          target.files.filter((f) => f.path.startsWith(dir === '.' ? '' : dir)),
        openSession: async () => {
          throw new Error('测试里不开会话');
        },
      } as unknown as Connection;
      return conn;
    },
  });

  const audits: AuditRow[] = [];
  const deps = {
    targets: registry,
    profileFor: (id: string) => byId(id)?.profile,
    audit: (row: AuditRow): string => {
      audits.push(row);
      return `audit-${audits.length}`;
    },
    now: () => 1_700_000_000_000,
  };
  return { targets, byId, target, audits, deps };
}

const ROLES = {
  build: { purpose: '客机', profile: 'guest' },
  target: { purpose: '板子', profile: 'board' },
};

describe('流程 · exec 步', () => {
  it('命令**发到指名的目标上**', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [{ id: 'compile', kind: 'exec', role: 'build', cmd: 'make' }],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps, { approved: true });
    expect(result.ok).toBe(true);
    expect(h.byId('guest')?.commands).toEqual(['make']);
    // **板子上一个命令都没有**（不串台 ✓）
    expect(h.byId('board')?.commands).toEqual([]);
  });

  it('输入**按类型编码**（`; reboot` 被当字面量）', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w',
        name: 'w',
        version: '1.0.0',
        inputs: { note: { type: 'string', maxLength: 64 } },
        roles: ROLES,
        steps: [{ id: 'echo', kind: 'exec', role: 'build', cmd: 'echo {input:note}' }],
      },
      'w.yaml',
    );
    await runWorkflow(pack, { note: 'x; reboot' }, h.deps, { approved: true });
    expect(h.byId('guest')?.commands[0]).toBe("echo 'x; reboot'");
  });

  it('**命中危险地板 → 要人确认**（流程不继续）', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          { id: 'reboot', kind: 'exec', role: 'target', cmd: 'reboot' },
          { id: 'after', kind: 'exec', role: 'target', cmd: 'echo after' },
        ],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps, { approved: true });
    expect(result.ok).toBe(false);
    expect(result.needsConfirmation?.stepId).toBe('reboot');
    // **命令没执行**（确认之前不许跑 ✓）
    expect(h.byId('board')?.commands).toEqual([]);
    // 后面的步没跑
    expect(h.byId('board')?.commands).not.toContain('echo after');
  });

  it('**审计行里有最终命令**（追责的第一环 ✓）', async () => {
    const h = harness();
    await runWorkflow(
      parseWorkflow(
        {
          apiVersion: 'devboard/v1',
          kind: 'Workflow',
          id: 'w',
          name: 'w',
          version: '1.0.0',
          inputs: { value: { type: 'integer', min: 0, max: 255 } },
          roles: ROLES,
          steps: [{ id: 'set', kind: 'exec', role: 'target', cmd: 'echo {input:value} > /tmp/v' }],
        },
        'w.yaml',
      ),
      { value: 128 },
      h.deps,
      { approved: true },
    );
    // **命令是编码过的** ✓（整数不带引号 ✓）
    expect(h.audits[0]?.command).toBe('echo 128 > /tmp/v');
  });

  it('流程的审计行里有**这一步的输入**（流程的参数在流程包里，不在板型包里 ✓）', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w',
        name: 'w',
        version: '1.0.0',
        inputs: { project: { type: 'string', maxLength: 50 } },
        roles: ROLES,
        steps: [{ id: 'compile', kind: 'exec', role: 'build', cmd: 'make {input:project}' }],
      },
      'w.yaml',
    );
    await runWorkflow(pack, { project: '01-hello' }, h.deps, { approved: true });
    expect(h.audits[0]?.inputs).toEqual({ project: '01-hello' });
    expect(h.audits[0]?.command).toBe("make '01-hello'");
  });

  it('**每步一行审计**，时间线上的 audit_id 指得到', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          { id: 'a', kind: 'exec', role: 'build', cmd: 'make' },
          { id: 'b', kind: 'exec', role: 'build', cmd: 'make install' },
        ],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps, { approved: true });
    expect(h.audits).toHaveLength(2);
    expect(result.stages[0]?.audit_id).toBe('audit-1');
    expect(result.stages[1]?.audit_id).toBe('audit-2');
    // 审计的 actor 是这个流程
    expect(h.audits[0]?.actor).toBe('workflow:w');
  });
});

describe('流程 · 危险等级与输出', () => {
  it('**声明 destructive 的步要人确认**（凭据准备那一步 ✓ A10）', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          {
            id: 'authorize',
            kind: 'exec',
            role: 'target',
            danger: 'destructive',
            cmd: 'cat >> /root/.ssh/authorized_keys',
          },
        ],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps, { approved: true });
    expect(result.ok).toBe(false);
    expect(result.needsConfirmation?.stepId).toBe('authorize');
    // **命令没执行**（确认之前不许跑 ✓）
    expect(h.byId('board')?.commands).toEqual([]);
  });

  it('`out` 槽 = **这条命令的输出**（下一步要用它 ✓）', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          { id: 'read', kind: 'exec', role: 'build', cmd: 'cat ~/.ssh/id_ed25519.pub', out: 'pubkey' },
        ],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps, { approved: true });
    expect(result.ok).toBe(true);
    // **槽里就是那条命令的输出** ✓（下一步要用它 ✓）
    expect(result.outputs['pubkey']).toBe('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI-test claude-sandbox');
  });
});

describe('流程 · 角色事实', () => {
  it('角色事实**要包引号**（profile 是半可信的 → 不能原样插）', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          { id: 'ping', kind: 'exec', role: 'build', cmd: 'ssh {role:build.user}@{role:build.host}' },
        ],
      },
      'w.yaml',
    );
    await runWorkflow(pack, {}, h.deps, { approved: true });
    expect(h.byId('guest')?.commands[0]).toBe("ssh 'builder'@'10.0.0.2'");
  });
});

describe('流程 · 确认凭据', () => {
  it('**同一张凭据换一组输入 → 作废**（凭据必须绑住这一步的输入 ✓）', async () => {
    // 一个**真的**确认凭据库（不是桩）
    const issued = new Map<string, { actionId: string; digest: string }>();
    const confirmations = {
      approve: (): boolean => true,
      request: (): boolean => true,
      issue: (actionId: string, params: Record<string, unknown>): string => {
        const token = `cf-${issued.size}`;
        issued.set(token, {
          actionId,
          digest: JSON.stringify(params),
        });
        return token;
      },
      consume: (token: string, actionId: string, params: Record<string, unknown>): boolean => {
        const found = issued.get(token);
        if (found === undefined) return false;
        issued.delete(token);
        return found.actionId === actionId && found.digest === JSON.stringify(params);
      },
    };

    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w',
        name: 'w',
        version: '1.0.0',
        inputs: { note: { type: 'string', maxLength: 64 } },
        roles: ROLES,
        steps: [
          {
            id: 'danger',
            kind: 'exec',
            role: 'target',
            danger: 'destructive',
            cmd: 'echo {input:note}',
          },
        ],
      },
      'w.yaml',
    );
    const deps = { ...h.deps, confirmations };

    // 第一次 → 要确认（凭据发下来了）
    const first = await runWorkflow(pack, { note: 'a' }, deps, { approved: true });
    expect(first.needsConfirmation).toBeTruthy();
    const token = first.needsConfirmation?.confirmId as string;

    // **拿同一张凭据换一组输入** → 必须作废 ✓
    const replay = await runWorkflow(pack, { note: 'b' }, deps, {
      approved: true,
      confirmIds: { danger: token },
    });
    expect(replay.needsConfirmation).toBeTruthy();
    // **命令没执行** ✓
    expect(h.byId('board')?.commands.some((c) => c.includes('b'))).toBe(false);
  });
});

describe('流程 · 续跑', () => {
  it('**从第几步开始** → 前面的步**不重跑**（重跑 = 编译两遍 ✗）', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          { id: 'first', kind: 'exec', role: 'build', cmd: 'echo first' },
          { id: 'second', kind: 'exec', role: 'build', cmd: 'echo second' },
        ],
      },
      'w.yaml',
    );
    await runWorkflow(pack, {}, h.deps, { approved: true, startAt: 1 });
    // **第一步没跑** ✓
    expect(h.byId('guest')?.commands).toEqual(['echo second']);
  });

  it('续跑时**带上之前的产出**（槽还在 ✓）', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          { id: 'find', kind: 'discover', role: 'build', dir: 'build', pattern: '*.ko', out: 'artifacts' },
          { id: 'use', kind: 'exec', role: 'build', cmd: 'ls {output:artifacts}' },
        ],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps, {
      approved: true,
      startAt: 1,
      outputs: { artifacts: 'build/hello.ko' },
    });
    // **第二步用的是之前那个槽** ✓
    expect(h.byId('guest')?.commands).toEqual(["ls 'build/hello.ko'"]);
    expect(result.outputs['artifacts']).toBe('build/hello.ko');
  });

  it('**续跑是同一次运行** → runId 沿用 ✓', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [{ id: 'a', kind: 'exec', role: 'build', cmd: 'echo a' }],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps, { approved: true, runId: 'wf-fixed' });
    expect(result.runId).toBe('wf-fixed');
  });
});

describe('流程 · 输入的 default', () => {
  it('**调用方没给 → 用包里的 default** ✓', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w',
        name: 'w',
        version: '1.0.0',
        inputs: { project: { type: 'string', maxLength: 50, default: '01-hello' } },
        roles: ROLES,
        steps: [{ id: 'build', kind: 'exec', role: 'build', cmd: 'make {input:project}' }],
      },
      'w.yaml',
    );
    await runWorkflow(pack, {}, h.deps, { approved: true });
    // **命令里用的是默认值** ✓
    expect(h.byId('guest')?.commands[0]).toBe("make '01-hello'");
  });

  it('**`pattern` 挡形状**（不匹配的输入被拒 ✓）', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w',
        name: 'w',
        version: '1.0.0',
        inputs: { project: { type: 'string', maxLength: 50, pattern: '^[a-z0-9-]+$' } },
        roles: ROLES,
        steps: [{ id: 'build', kind: 'exec', role: 'build', cmd: 'make {input:project}' }],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, { project: 'BAD; rm -rf /' }, h.deps, { approved: true });
    // **不合规的输入 → 不成功** ✓（契约 §7.7：方法不抛异常，返回失败 ✓）
    expect(result.ok).toBe(false);
    expect(result.stages[0]?.reason).toBe('invalid_params');
    // **命令没发出去** ✓
    expect(h.byId('guest')?.commands).toHaveLength(0);
  });
});

describe('流程 · discover 步', () => {
  it('按规则找到产物，**落进槽**', async () => {
    const h = harness({
      files: {
        guest: [
          { name: 'hello.ko', path: 'build/hello.ko', isDirectory: false, sizeBytes: 10, modifiedAt: null },
          { name: 'hello.o', path: 'build/hello.o', isDirectory: false, sizeBytes: 10, modifiedAt: null },
        ],
      },
    });
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          {
            id: 'find',
            kind: 'discover',
            role: 'build',
            dir: 'build',
            pattern: '*.ko',
            exclude: ['*.o'],
            out: 'artifacts',
          },
        ],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps, { approved: true });
    expect(result.ok).toBe(true);
    expect(result.outputs['artifacts']).toBe('build/hello.ko');
  });

  it('没找到 → **失败**（不报成功）', async () => {
    const h = harness({ files: { guest: [] } });
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [{ id: 'find', kind: 'discover', role: 'build', dir: 'build', pattern: '*.ko', out: 'artifacts' }],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps, { approved: true });
    expect(result.ok).toBe(false);
    expect(result.stages[0]?.reason).toBe('not_found');
  });
});

describe('流程 · file.transfer 步（直传）', () => {
  it('传输命令在**源目标**上跑，目的地落进槽', async () => {
    const h = harness({
      files: {
        guest: [{ name: 'hello.ko', path: 'build/hello.ko', isDirectory: false, sizeBytes: 10, modifiedAt: null }],
      },
    });
    h.target('board').catAnswers['/usr/lib/modules/6.1.141/extra/hello.ko'] = 'ELF';
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          { id: 'find', kind: 'discover', role: 'build', dir: 'build', pattern: '*.ko', out: 'artifacts' },
          {
            id: 'deliver',
            kind: 'file.transfer',
            from: { role: 'build', path: '{output:artifacts}' },
            to: { role: 'target', placement: 'kernel-module' },
            cmd: 'scp {from.path} {role:target.user}@{role:target.host}:{to.path}',
            out: 'dest',
            readback: { kind: 'verify', role: 'target', command: 'test -f {to.path}' },
          },
        ],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps, { approved: true });
    expect(result.ok).toBe(true);
    // **命令在客机上跑**（源目标 ✓）
    expect(h.byId('guest')?.commands.some((c) => c.startsWith('scp '))).toBe(true);
    // 目的地按 placement 解析（内核版本问的是板子 ✓）
    expect(result.outputs['dest']).toBe('/usr/lib/modules/6.1.141/extra/hello.ko');
  });

  it('**判据在指名的角色上读**（在板子上问板子）', async () => {
    const h = harness({
      files: {
        guest: [{ name: 'hello.ko', path: 'build/hello.ko', isDirectory: false, sizeBytes: 10, modifiedAt: null }],
      },
    });
    h.target('board').catAnswers['/usr/lib/modules/6.1.141/extra/hello.ko'] = 'ELF';
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          { id: 'find', kind: 'discover', role: 'build', dir: 'build', pattern: '*.ko', out: 'artifacts' },
          {
            id: 'deliver',
            kind: 'file.transfer',
            from: { role: 'build', path: '{output:artifacts}' },
            to: { role: 'target', placement: 'kernel-module' },
            cmd: 'scp {from.path} {role:target.user}@{role:target.host}:{to.path}',
            out: 'dest',
            readback: { kind: 'verify', role: 'target', command: 'test -f {to.path}' },
          },
        ],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps, { approved: true });
    expect(result.ok).toBe(true);
    // **验证命令跑在板子上**（不在客机上 ✓）
    expect(h.byId('board')?.commands.some((c) => c.includes('test -f'))).toBe(true);
    expect(h.byId('guest')?.commands.some((c) => c.includes('test -f'))).toBe(false);
  });
});

describe('流程 · 取消（人叫停）', () => {
  it('**被叫停了 → 后面那一步不跑**（人不要了，就别再往下做 ✓）', async () => {
    const controller = new AbortController();
    const h = harness({
      // **第一步跑完就叫停** ✓
      onExec: (command) => {
        if (command.includes('first')) controller.abort();
      },
    });
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          { id: 'one', kind: 'exec', role: 'build', cmd: 'echo first' },
          { id: 'two', kind: 'exec', role: 'build', cmd: 'echo second' },
        ],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps, {
      approved: true,
      signal: controller.signal,
    });
    // **第一步跑了** ✓
    expect(h.byId('guest')?.commands.some((c) => c.includes('first'))).toBe(true);
    // **第二步不该跑** ✓（人叫停了 ✗ → 还往下做 = 不听话 ✗）
    expect(h.byId('guest')?.commands.some((c) => c.includes('second'))).toBe(false);
    // **时间线上只有第一步** ✓
    expect(result.stages.map((s) => s.stepId)).toEqual(['one']);
  });

  it('**被叫停了 → 不跑跨目标的判据**（取消后别再让人多等一条命令 ✓）', async () => {
    const controller = new AbortController();
    const h = harness({
      files: {
        guest: [{ name: 'hello.ko', path: 'build/hello.ko', isDirectory: false, sizeBytes: 10, modifiedAt: null }],
      },
      // **传输那一步开始时叫停** ✓
      onExec: (command) => {
        if (command.startsWith('scp ')) controller.abort();
      },
    });
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          { id: 'find', kind: 'discover', role: 'build', dir: 'build', pattern: '*.ko', out: 'artifacts' },
          {
            id: 'deliver',
            kind: 'file.transfer',
            from: { role: 'build', path: '{output:artifacts}' },
            to: { role: 'target', placement: 'kernel-module' },
            cmd: 'scp {from.path} {role:target.user}@{role:target.host}:{to.path}',
            out: 'dest',
            readback: { kind: 'verify', role: 'target', command: 'test -f {to.path}' },
          },
        ],
      },
      'w.yaml',
    );
    await runWorkflow(pack, {}, h.deps, { approved: true, signal: controller.signal });
    // **板子上那条 `test -f` 不该跑** ✓（东西都没传完，验它没有意义 ✗）
    expect(h.byId('board')?.commands.some((c) => c.includes('test -f'))).toBe(false);
  });
});

describe('流程 · assert 步', () => {
  it('判据不符 → **失败**（assert 的默认）', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          {
            id: 'check',
            kind: 'assert',
            readback: { kind: 'file_equals', role: 'target', path: '/tmp/x', expect: '1' },
          },
        ],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps, { approved: true });
    expect(result.ok).toBe(false);
    expect(result.stages[0]?.reason).toBe('not_found');
  });

  it('`on_mismatch: continue` → **继续往下跑**', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          {
            id: 'check',
            kind: 'assert',
            readback: { kind: 'file_equals', role: 'target', path: '/tmp/x', expect: '1' },
            on_mismatch: 'continue',
          },
          { id: 'after', kind: 'exec', role: 'build', cmd: 'echo after' },
        ],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps, { approved: true });
    expect(result.stages).toHaveLength(2);
    expect(h.byId('guest')?.commands).toEqual(['echo after']);
    // **整体仍然不算成功**（那一步确实没成 ✓）
    expect(result.ok).toBe(false);
  });
});
