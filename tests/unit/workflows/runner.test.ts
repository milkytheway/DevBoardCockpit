import { describe, it, expect } from 'vitest';
import { runWorkflow, type WorkflowRunDeps } from '../../../src/main/workflows/runner';
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
 * | **危险等级只是信息**（**不再问人** ✓ —— ADR-D48 ✓） | —— **闸在设置里的统一权限区** ✓（ADR-D47 ✓） |
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

function harness(
  opts: {
    files?: Record<string, FileEntry[]>;
    onExec?: (command: string) => void;
    /** 命中这些片段的命令**返回非 0** ✓（模拟传输失败 ✓） */
    failCommands?: string[];
    /** 这个 profile 的目标**连不上** ✓（板子没插 ✓） */
    failProfile?: string;
  } = {},
) {
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
          // **这个目标连不上** ✓（板子没插 ✓ / ssh 认证失败 ✓）
          if (opts.failProfile === profile.id) {
            throw new Error(`连不上目标 ${profile.id}`);
          }
          target.commands.push(command);
          // **测试可以在这里叫停** ✓（「在飞的那一步被取消」✓）
          opts.onExec?.(command);
          // **某些命令要失败** ✓（模拟传输没成 ✓）
          // **传输会在目标上留下那个文件** ✓
          // （真的 scp **边传边写** ✓ —— 成功是完整文件 ✓，失败是**半截** ✓；
          //   尖兵 §三·F2 的现象就是它 ✓）
          if (command.startsWith('scp ')) {
            // **路径在命令里是带引号的** ✓（命令模式 ✓）→ 取出来要把引号剥掉 ✓
            // （shell 会剥 ✓ —— 真的 scp 写的是**没引号**的那个路径 ✓）
            const dest = command.slice(command.lastIndexOf(':') + 1).replace(/^'|'$/g, '');
            const board = byId('board');
            if (board !== undefined) {
              board.files = [
                ...board.files,
                {
                  name: dest.slice(dest.lastIndexOf('/') + 1),
                  path: dest,
                  isDirectory: false,
                  sizeBytes: 3,
                  modifiedAt: null,
                },
              ];
            }
          }
          if (opts.failCommands?.some((frag) => command.includes(frag)) === true) {
            return { exitCode: 1, stdout: '', stderr: '传输失败', durationMs: 1, timedOut: false };
          }
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
  const deps: WorkflowRunDeps = {
    targets: registry,
    profileFor: (id: string) => byId(id)?.profile,
    audit: (row: AuditRow): string => {
      audits.push(row);
      return `audit-${audits.length}`;
    },
    now: () => 1_700_000_000_000,
    // **`action` 步要的动作定义** ✓（`actionDef` 是可选的 ✓ —— 没有它就调不动动作 ✓）
    actionDef: undefined,
  };
  return { targets, byId, target, audits, deps };
}

const ROLES = {
  build: { purpose: '客机', profile: 'guest' },
  target: { purpose: '板子', profile: 'board' },
};

describe('流程 · action 步（引用板型包里的动作）', () => {
  /**
   * ── 这条在防什么 ──
   *
   * **流程里的参数值只能是字符串** ✓（流程包形状封闭 ✓ —— `spec/05` §4.2 ✓），
   * 而**动作的参数带类型** ✓（`integer` / `number` / `boolean` / `enum` ✓ ——
   * `spec/02` §4.3 ✓）。**两边对不上** ✗ →
   * 带类型的动作**在流程里调不动** ✗（实测 2026-11-16：
   * `invalid_params：参数「value」要 integer` ✓）。
   *
   * → 流程层**按动作自己声明的类型转一遍** ✓。
   */
  it('**整型参数按动作声明的类型转**（`"1"` → `1` ✓）', async () => {
    const h = harness();
    h.deps.actionDef = () => ({
      id: 'led.set',
      danger: 'reversible',
      params: { value: { type: 'integer' } },
      command: 'echo {value} > /sys/class/leds/work/brightness',
      readback: { kind: 'command_ok' },
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
          { id: 'led', kind: 'action', role: 'target', action: 'led.set', params: { value: '1' } },
        ],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps, { approved: true });
    expect(result.ok).toBe(true);
    // **命令里是 `1`，不是 `'1'`** ✓ —— 编码器按**数字**处理 ✓（不引号 ✓）
    expect(h.byId('board')?.commands).toEqual(['echo 1 > /sys/class/leds/work/brightness']);
  });

  it('**布尔参数也转**（`"true"` → `true` ✓）', async () => {
    const h = harness();
    h.deps.actionDef = () => ({
      id: 'x.set',
      danger: 'reversible',
      params: { on: { type: 'boolean' } },
      command: 'toggle {on}',
      readback: { kind: 'command_ok' },
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
        steps: [{ id: 'x', kind: 'action', role: 'target', action: 'x.set', params: { on: 'true' } }],
      },
      'w.yaml',
    );
    await runWorkflow(pack, {}, h.deps, { approved: true });
    expect(h.byId('board')?.commands).toEqual(['toggle true']);
  });

  it('**转不成就不转**（`"abc"` 不是整数 → 原样留着 → 授权层去报错 ✓ —— **不在这儿编** ✓）', async () => {
    const h = harness();
    h.deps.actionDef = () => ({
      id: 'x.set',
      danger: 'reversible',
      params: { n: { type: 'integer' } },
      command: 'set {n}',
      readback: { kind: 'command_ok' },
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
        steps: [{ id: 'x', kind: 'action', role: 'target', action: 'x.set', params: { n: 'abc' } }],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps, { approved: true });
    // **动作失败了** ✓（授权层说「要 integer」✓）—— **流程层没有悄悄把它变成 0** ✓
    expect(result.ok).toBe(false);
  });
});

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

  it('**命中危险地板 → 不再拦**（**危险等级只是信息** ✓ —— **闸在设置里的统一权限区** ✓）', async () => {
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
    expect(result.ok).toBe(true);
    // **命令跑了** ✓（**不再卡在「等人点头」那一步** ✓）
    expect(h.byId('board')?.commands).toContain('reboot');
    // **后面的步也跑了** ✓（**不再停在半路** ✓）
    expect(h.byId('board')?.commands).toContain('echo after');
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
  it('**声明 destructive 的步 → 直接执行**（**不再问人** ✓ —— ADR-D48 ✓）', async () => {
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
    expect(result.ok).toBe(true);
    // **命令真的跑了** ✓（**危险等级只是信息** ✓ —— **闸在设置里的统一权限区** ✓）
    expect(h.byId('board')?.commands).toContain('cat >> /root/.ssh/authorized_keys');
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

describe('流程 · 传输失败后的清理（不留半截文件）', () => {
  const TRANSFER_PACK = {
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
  };

  it('传输没成 → **清掉那个半截文件**（不留残留 ✓）', async () => {
    const h = harness({
      failCommands: ['scp '],
      files: {
        guest: [{ name: 'hello.ko', path: 'build/hello.ko', isDirectory: false, sizeBytes: 10, modifiedAt: null }],
      },
    });
    const pack = parseWorkflow(TRANSFER_PACK, 'w.yaml');
    const result = await runWorkflow(pack, {}, h.deps, { approved: true });
    expect(result.ok).toBe(false);

    // **板子上那条 `rm -f` 跑了** ✓
    const rm = h.byId('board')?.commands.filter((c) => c.includes('rm -f')) ?? [];
    expect(rm.length).toBe(1);
    // **清的是那个路径** ✓
    expect(rm[0]).toContain('hello.ko');
    // **清理也记一行审计** ✓（谁删的、删的哪个路径 ✓）
    const cleanup = h.audits.filter((a) => a.actionId.endsWith(':cleanup'));
    expect(cleanup).toHaveLength(1);
  });

  it('**传了，但没验成** → **不清**（那不是「没传成」✓）+ 说清楚 ✓', async () => {
    const h = harness({
      // **判据失败** ✓（传输成功 ✓）
      failCommands: ['test -f'],
      files: {
        guest: [{ name: 'hello.ko', path: 'build/hello.ko', isDirectory: false, sizeBytes: 10, modifiedAt: null }],
      },
    });
    const pack = parseWorkflow(
      {
        ...TRANSFER_PACK,
        steps: [
          TRANSFER_PACK.steps[0],
          {
            ...TRANSFER_PACK.steps[1],
            // **判据的超时调短** ✓（verify 形式默认 5 秒 ✓ → 会把测试拖死 ✓）
            readback: { kind: 'verify', role: 'target', command: 'test -f {to.path}', timeout_ms: 200 },
          },
        ],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps, { approved: true });
    expect(result.ok).toBe(false);

    // **一条 `rm -f` 都不许有** ✓（文件可能是好的 ✓ —— 删掉它比留半截更坏 ✓）
    expect(h.byId('board')?.commands.some((c) => c.includes('rm -f'))).toBe(false);
    // **说清楚「传了，未验成」** ✓（尖兵 Q3 的原型 ✓ —— 板子上现在是什么状态要看得见 ✓）
    const stage = result.stages.find((s) => s.stepId === 'deliver');
    expect(stage?.detail).toContain('传了');
  });

  it('**清理路径必须编码**（`to.path` 是包给的 ✓ —— 不编码就是一条注入面 ✓）', async () => {
    const h = harness({
      failCommands: ['scp '],
      files: {
        guest: [{ name: 'hello.ko', path: 'build/hello.ko', isDirectory: false, sizeBytes: 10, modifiedAt: null }],
      },
    });
    const pack = parseWorkflow(
      {
        ...TRANSFER_PACK,
        steps: [
          TRANSFER_PACK.steps[0],
          {
            ...TRANSFER_PACK.steps[1],
            // **目的地路径里带一条命令** ✓（包给的 ✓ → 宿主拼命令时必须编码 ✓）
            to: { role: 'target', path: '/opt/x; reboot' },
          },
        ],
      },
      'w.yaml',
    );
    await runWorkflow(pack, {}, h.deps, { approved: true });
    const rm = h.byId('board')?.commands.filter((c) => c.includes('rm -f')) ?? [];
    expect(rm).toHaveLength(1);
    // **路径被包在引号里** ✓（`; reboot` 不是第二条命令 ✓）
    expect(rm[0]).toContain("'/opt/x; reboot'");
  });

  it('目的地**原本就有**那个文件 → **不许删**（别删用户的东西 ✓）', async () => {
    const h = harness({
      failCommands: ['scp '],
      files: {
        guest: [{ name: 'hello.ko', path: 'build/hello.ko', isDirectory: false, sizeBytes: 10, modifiedAt: null }],
        board: [
          {
            name: 'hello.ko',
            path: '/usr/lib/modules/6.1.141/extra/hello.ko',
            isDirectory: false,
            sizeBytes: 99,
            modifiedAt: null,
          },
        ],
      },
    });
    const pack = parseWorkflow(TRANSFER_PACK, 'w.yaml');
    await runWorkflow(pack, {}, h.deps, { approved: true });
    // **一条 `rm -f` 都不许有** ✓（那是用户自己的文件 ✓）
    expect(h.byId('board')?.commands.some((c) => c.includes('rm -f'))).toBe(false);
  });
});

describe('流程 · inputs.default（契约 §二）', () => {
  it('**值模式也要拿到默认值**（回读的 expect 走值模式 ✓ —— 独立评审 40 的 I-3 ✓）', async () => {
    const h = harness();
    h.target('board').catAnswers['/tmp/x'] = '5';
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w',
        name: 'w',
        version: '1.0.0',
        // **调用方不给 count** ✓ → 用默认值 ✓
        inputs: { count: { type: 'integer', default: 5 } },
        roles: ROLES,
        steps: [
          {
            id: 'write',
            kind: 'exec',
            role: 'build',
            cmd: 'echo {input:count}',
            // ⚠️ **值模式** ✓ —— 比的是**值** ✓，不是 shell 片段 ✓
            readback: { kind: 'file_equals', role: 'target', path: '/tmp/x', expect: '{input:count}' },
          },
        ],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps, { approved: true });
    // **回读对上了** ✓（默认值真的进了值模式 ✓）
    expect(result.ok).toBe(true);
    expect(result.stages[0]?.verified).toBe(true);
  });
});

describe('流程 · 步出错了也要有那一行（独立评审 40 的 I-2 ✓）', () => {
  it('**目标连不上 → 时间线上有一行**（不是整个运行抛出去 ✓）', async () => {
    // **板子没插** ✓ → 问它内核版本时炸了 ✓
    const h = harness({ failProfile: 'board' });
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
            id: 'deliver',
            kind: 'file.transfer',
            from: { role: 'build', path: 'build/hello.ko' },
            to: { role: 'target', placement: 'kernel-module' },
            cmd: 'scp {from.path} {role:target.user}@{role:target.host}:{to.path}',
          },
        ],
      },
      'w.yaml',
    );
    // **不该整个抛出去** ✓（抛出去 → 时间线上一行都没有 ✗ → 用户看不出是哪一步 ✗）
    const result = await runWorkflow(pack, {}, h.deps, { approved: true });
    expect(result.ok).toBe(false);
    // **时间线上有那一行** ✓
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]?.stepId).toBe('deliver');
    expect(result.stages[0]?.ok).toBe(false);
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
