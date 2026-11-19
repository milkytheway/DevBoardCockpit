import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowRegistry, digestOf } from '../../../src/main/workflows/registry';

/**
 * 流程包**注册表** —— 「哪些流程可以跑」这本账。
 *
 * ── 现在的规矩（**2026-11-16 改完** ✓ · ADR-D48 ✓）──
 *
 * ① **只认 id，不认路径** ✓ —— 卡片与 agent **给不了路径** ✓；
 * ② **不再有批准账** ✓ —— **流程包的存在本身就是说明** ✓
 *    （**闸在设置里的统一权限区** ✓ —— ADR-D47 ✓）；
 * ③ 坏包**不拖垮其余** ✓（与 profile 加载器同规矩 ✓）；
 * ④ **内容摘要还在** ✓ —— **改了内容摘要就变** ✓（**给人看「变没变」用** ✓）。
 */
let dir: string;
let builtinDir: string;
let userDir: string;

const PACK = {
  apiVersion: 'devboard/v1',
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
    'apiVersion: devboard/v1',
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
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function registry(warn?: (m: string) => void): WorkflowRegistry {
  return new WorkflowRegistry({
    dirs: [builtinDir, userDir],
    ...(warn === undefined ? {} : { warn }),
  });
}

describe('流程包注册表 · 扫目录', () => {
  it('扫到包，登记 id / 摘要', () => {
    write(builtinDir, 'demo.yaml', yamlOf(PACK));
    const reg = registry();
    reg.scan();
    const list = reg.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('demo.run');
    expect(list[0]?.digest).toHaveLength(16);
  });

  it('**坏包不拖垮其余**（跳过 + 一条警告 ✓）', () => {
    write(builtinDir, 'demo.yaml', yamlOf(PACK));
    write(builtinDir, 'broken.yaml', 'apiVersion: devboard/v1\nkind: 不存在的\n');
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

describe('流程包注册表 · 取包', () => {
  it('**放一个文件进目录 → 就能跑** ✓（**存在即说明** ✓ —— ADR-D48 ✓）', () => {
    write(userDir, 'demo.yaml', yamlOf(PACK));
    const reg = registry();
    reg.scan();
    // **不再有「有没有被批准」那一问** ✓
    expect(reg.require('demo.run').id).toBe('demo.run');
  });

  it('**没有这个包** → 报错（说清楚是哪一种 ✓）', () => {
    const reg = registry();
    reg.scan();
    expect(() => reg.require('nobody')).toThrow(/no such workflow pack/);
  });

  it('**列表里列出全部** ✓（**不再过滤「没批过的」** ✓ —— 用户要看得见）', () => {
    write(userDir, 'demo.yaml', yamlOf(PACK));
    write(userDir, 'other.yaml', yamlOf({ ...PACK, id: 'other.run' }));
    const reg = registry();
    reg.scan();
    expect(reg.list().map((w) => w.id)).toEqual(['demo.run', 'other.run']);
  });

  it('**内容摘要**（16 位十六进制 ✓）—— **改了内容摘要就变** ✓', () => {
    write(userDir, 'demo.yaml', yamlOf(PACK));
    const reg = registry();
    reg.scan();
    const before = reg.get('demo.run')?.digest;
    expect(before).toHaveLength(16);

    // **改了内容**（命令变了 ✓）
    write(userDir, 'demo.yaml', yamlOf({ ...PACK, steps: [{ ...PACK.steps[0], cmd: 'echo bye' }] }));
    reg.scan();
    expect(reg.get('demo.run')?.digest).not.toBe(before);
    expect(reg.get('demo.run')?.digest).toBe(
      digestOf(readFileSync(join(userDir, 'demo.yaml'), 'utf8')),
    );
  });

  it('**这个包会干什么**（`planOf` ✓ —— 人过目用的 ✓）', () => {
    write(userDir, 'demo.yaml', yamlOf(PACK));
    const reg = registry();
    reg.scan();
    const plan = reg.planOf('demo.run');
    expect(plan?.id).toBe('demo.run');
    expect(plan?.roles.map((r) => r.role)).toEqual(['build']);
    expect(plan?.steps.map((s) => s.id)).toEqual(['hello']);
  });

  it('**没有这个包 → `planOf` 给 undefined** ✓（**不抛** ✓）', () => {
    const reg = registry();
    reg.scan();
    expect(reg.planOf('nobody')).toBeUndefined();
  });
});
