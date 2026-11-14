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

function harness(opts: { files?: Record<string, FileEntry[]> } = {}) {
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
        formatVersion: 1,
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
        formatVersion: 1,
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
        formatVersion: 1,
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

  it('**每步一行审计**，时间线上的 audit_id 指得到', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        formatVersion: 1,
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
        formatVersion: 1,
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
        formatVersion: 1,
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
        formatVersion: 1,
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
        formatVersion: 1,
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

describe('流程 · assert 步', () => {
  it('判据不符 → **失败**（assert 的默认）', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        formatVersion: 1,
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
        formatVersion: 1,
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
