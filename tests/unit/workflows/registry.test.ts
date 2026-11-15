import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowRegistry, digestOf } from '../../../src/main/workflows/registry';

/**
 * 流程包**注册表** —— 「哪些流程可以跑」这本账。
 *
 * ── 这几条在防什么（两份独立评审的同一条 Critical）──
 *
 * **「agent 可以自写一个流程包然后跑它」** ✓——
 * 因为一个流程包就是「一组要在用户机器上执行的命令」，
 * 而当时**只认路径、不认人** ✗。
 *
 * → 现在的规矩：
 * ① **放一个文件进目录 ≠ 批准它** ✓；
 * ② **批准绑内容摘要** → 改了内容要**重新批准** ✓；
 * ③ **跑之前查批准账** ✓（`requireApproved` ✓）；
 * ④ 坏包**不拖垮其余** ✓（与 profile 加载器同规矩 ✓）。
 */
let dir: string;
let builtinDir: string;
let userDir: string;
let approvalFile: string;

const PACK = {
  formatVersion: 1,
  kind: 'Workflow',
  id: 'demo.run',
  name: '演示流程',
  version: '1.0.0',
  inputs: {},
  roles: { build: { purpose: '客机', profile: 'ubuntu-ssh' } },
  steps: [{ id: 'hello', kind: 'exec', role: 'build', cmd: 'echo hi' }],
};

function write(dirName: string, file: string, content: unknown): void {
  mkdirSync(dirName, { recursive: true });
  writeFileSync(join(dirName, file), typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
}

function yamlOf(pack: unknown): string {
  // **手写一份 YAML**（不引 yaml 库 → 测试的依赖面更小 ✓）
  const p = pack as typeof PACK;
  const roles = Object.entries(p.roles)
    .map(([name, r]) => `  ${name}: { purpose: ${r.purpose}, profile: ${r.profile} }`)
    .join('\n');
  const steps = p.steps
    .map((s) => `  - id: ${s.id}\n    kind: ${s.kind}\n    role: ${s.role}\n    cmd: ${s.cmd}`)
    .join('\n');
  return [
    'formatVersion: 1',
    'kind: Workflow',
    `id: ${p.id}`,
    `name: ${p.name}`,
    `version: ${p.version}`,
    'inputs: {}',
    'roles:',
    roles,
    'steps:',
    steps,
    '',
  ].join('\n');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cockpit-registry-'));
  builtinDir = join(dir, 'builtin');
  userDir = join(dir, 'user');
  approvalFile = join(dir, 'workflows-approved.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function registry(warn?: (m: string) => void): WorkflowRegistry {
  return new WorkflowRegistry({
    dirs: [builtinDir, userDir],
    approvalFile,
    ...(warn === undefined ? {} : { warn }),
  });
}

describe('流程包注册表 · 扫目录', () => {
  it('扫到包，登记 id / 摘要 / 未批准', () => {
    write(builtinDir, 'demo.yaml', yamlOf(PACK));
    const reg = registry();
    reg.scan();
    const list = reg.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('demo.run');
    expect(list[0]?.approved).toBe(false);
    expect(list[0]?.digest).toHaveLength(16);
  });

  it('**坏包不拖垮其余**（跳过 + 一条警告 ✓）', () => {
    write(builtinDir, 'demo.yaml', yamlOf(PACK));
    write(builtinDir, 'broken.yaml', 'formatVersion: 1\nkind: 不存在的\n');
    const warnings: string[] = [];
    const reg = registry((m) => warnings.push(m));
    reg.scan();
    expect(reg.list().map((w) => w.id)).toEqual(['demo.run']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('broken.yaml');
  });

  it('**同 id 时用户目录优先**（与卡片/profile 同规矩 ✓）', () => {
    write(builtinDir, 'demo.yaml', yamlOf(PACK));
    write(userDir, 'demo.yaml', yamlOf({ ...PACK, name: '用户那一份' }));
    const reg = registry();
    reg.scan();
    expect(reg.list()).toHaveLength(1);
    expect(reg.list()[0]?.name).toBe('用户那一份');
  });
});

describe('流程包注册表 · 批准', () => {
  it('**放一个文件进目录 ≠ 批准它**', () => {
    write(userDir, 'demo.yaml', yamlOf(PACK));
    const reg = registry();
    reg.scan();
    expect(reg.get('demo.run')?.approved).toBe(false);
    expect(() => reg.requireApproved('demo.run')).toThrow(/还没有被批准/);
  });

  it('批准之后就能跑（**那就是「点头」那一下** ✓）', () => {
    write(userDir, 'demo.yaml', yamlOf(PACK));
    const reg = registry();
    reg.scan();
    reg.approve('demo.run');
    expect(reg.requireApproved('demo.run').approved).toBe(true);
  });

  it('**批准绑内容摘要** → 改了内容要重新批准', () => {
    write(userDir, 'demo.yaml', yamlOf(PACK));
    const reg = registry();
    reg.scan();
    reg.approve('demo.run');
    expect(reg.get('demo.run')?.approved).toBe(true);

    // **改了内容**（命令变了 ✓）
    write(userDir, 'demo.yaml', yamlOf({ ...PACK, steps: [{ ...PACK.steps[0], cmd: 'echo bye' }] }));
    reg.scan();
    expect(reg.get('demo.run')?.approved).toBe(false);
    expect(() => reg.requireApproved('demo.run')).toThrow(/还没有被批准/);
  });

  it('批准账**读不出来就当没批过**（默认拒绝 ✓）', () => {
    write(userDir, 'demo.yaml', yamlOf(PACK));
    mkdirSync(dir, { recursive: true });
    writeFileSync(approvalFile, '{ 这不是 JSON', 'utf8');
    const reg = registry();
    reg.scan();
    expect(reg.get('demo.run')?.approved).toBe(false);
  });

  it('批准账**是原子写**（改名 ✓ —— 断电不会留下半个文件 ✓）', () => {
    write(userDir, 'demo.yaml', yamlOf(PACK));
    const reg = registry();
    reg.scan();
    reg.approve('demo.run');
    const parsed = JSON.parse(readFileSync(approvalFile, 'utf8')) as {
      workflows: Record<string, { digest: string; at: number }>;
    };
    expect(parsed.workflows['demo.run']?.digest).toBe(digestOf(readFileSync(join(userDir, 'demo.yaml'), 'utf8')));
    expect(existsSync(`${approvalFile}.tmp`)).toBe(false);
  });

  it('收回批准 → 又不能跑了', () => {
    write(userDir, 'demo.yaml', yamlOf(PACK));
    const reg = registry();
    reg.scan();
    reg.approve('demo.run');
    reg.revoke('demo.run');
    expect(reg.get('demo.run')?.approved).toBe(false);
  });

  it('**没有这个包** → 报错（说清楚是哪一种 ✓）', () => {
    const reg = registry();
    reg.scan();
    expect(() => reg.requireApproved('nobody')).toThrow(/没有这个流程包/);
    expect(() => reg.approve('nobody')).toThrow(/没有这个流程包/);
  });
});
