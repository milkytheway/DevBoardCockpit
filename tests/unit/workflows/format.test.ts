import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { parseWorkflow, type WorkflowPack } from '../../../src/main/workflows/format';

/**
 * 流程包格式的校验器（宿主层格式，**不进 `docs/spec/`**——ADR-D31 R1）。
 *
 * ── 为什么校验器要这么严 ──
 *
 * 流程包是**声明**（「这件事怎么做」），不是脚本。
 * 一个拼错的字段名如果被**静默忽略**，流程就会**照跑**——
 * 只是少做了一件事，或者做在了别的目标上。
 * → **未知字段一律报错**（与板型包、卡片 manifest 同一规矩）。
 *
 * ── 封闭的三处 ──
 *
 * | 封闭什么 | 为什么 |
 * |---|---|
 * | step kind（6 个） | ADR-D31 R11：9 个是冗余；`exec_script` 连「留位置」都不留 |
 * | input 类型（6 种） | 照 `spec/02` §4.3 的封闭类型表（不另造一套） |
 * | placement 词表 | 拼错 `kernel-module` → **报错**，不能默默回落到别的语义 |
 */
const MINIMAL = {
  apiVersion: 'devboard/v1',
  kind: 'Workflow',
  id: 'demo.run',
  name: '演示流程',
  version: '1.0.0',
  inputs: {},
  roles: {
    build: { purpose: '编译所在', profile: 'ubuntu-ssh' },
    target: { purpose: '板子', profile: 'board-adb' },
  },
  steps: [{ id: 'hello', kind: 'exec', role: 'build', cmd: 'echo hi' }],
};

function expectInvalid(raw: unknown, pattern: RegExp): void {
  let threw = false;
  try {
    parseWorkflow(raw, 'demo.yaml');
  } catch (err) {
    threw = true;
    expect(err instanceof Error ? err.message : String(err)).toMatch(pattern);
  }
  expect(threw, `这份包本该被拒：${JSON.stringify(raw)}`).toBe(true);
}

describe('流程包 · 解析', () => {
  it('一份完整的最小包能解析', () => {
    const pack = parseWorkflow(MINIMAL, 'demo.yaml');
    expect(pack.id).toBe('demo.run');
    expect(pack.steps).toHaveLength(1);
    expect(pack.roles['build']?.profile).toBe('ubuntu-ssh');
  });

  it('**description / version 之外的字段一律不认**（封闭 schema）', () => {
    expectInvalid({ ...MINIMAL, extra: 1 }, /未知字段/);
  });

  it('apiVersion 只认 devboard/v1（**与板型包、卡片 manifest 同一套词汇** ✓）', () => {
    expectInvalid({ ...MINIMAL, apiVersion: 'devboard/v2' }, /apiVersion/);
  });

  it('**契约里的示例必须能过校验器**（评审 38 的 C1 ✓ —— 契约的 YAML 原样喂进来不许报错）', () => {
    // **契约 `docs/spec/05` §一 那段 YAML 原样**（一字不差 ✓）
    const text = readFileSync(join(__dirname, '../../../docs/spec/05-workflow-pack.md'), 'utf8');
    const block = text.match(/```yaml\n([\s\S]*?)\n```/);
    expect(block).not.toBeNull();
    const example = yaml.load(block?.[1] ?? '') as unknown;
    expect(() => parseWorkflow(example, 'spec/05-示例.yaml')).not.toThrow();
  });

  it('kind 必须是 Workflow', () => {
    expectInvalid({ ...MINIMAL, kind: 'Board' }, /kind/);
  });

  it('id / name / version 必须是非空字符串', () => {
    expectInvalid({ ...MINIMAL, id: '' }, /id/);
    expectInvalid({ ...MINIMAL, name: 42 }, /name/);
  });

  it('**steps 不能是空的**（没有步骤的流程包没有意义）', () => {
    expectInvalid({ ...MINIMAL, steps: [] }, /steps/);
  });

  it('step 的 id 必须唯一', () => {
    expectInvalid(
      {
        ...MINIMAL,
        steps: [
          { id: 'a', kind: 'exec', role: 'build', cmd: 'echo 1' },
          { id: 'a', kind: 'exec', role: 'build', cmd: 'echo 2' },
        ],
      },
      /重复/,
    );
  });
});

describe('流程包 · inputs 的封闭类型表', () => {
  it('六种类型都能过', () => {
    const pack = parseWorkflow(
      {
        ...MINIMAL,
        inputs: {
          s: { type: 'string', required: true, maxLength: 20 },
          i: { type: 'integer', min: 0, max: 10 },
          n: { type: 'number' },
          b: { type: 'boolean' },
          e: { type: 'enum', values: ['a', 'b'] },
          p: { type: 'path', maxLength: 200 },
        },
      },
      'demo.yaml',
    );
    expect(Object.keys(pack.inputs)).toHaveLength(6);
  });

  it('类型不在表里 → 报错', () => {
    expectInvalid({ ...MINIMAL, inputs: { x: { type: 'text' } } }, /type/);
  });

  it('**enum 必须给 values**', () => {
    expectInvalid({ ...MINIMAL, inputs: { x: { type: 'enum' } } }, /values/);
  });

  it('**string / path 必须给 maxLength**（不然是开口的）', () => {
    expectInvalid({ ...MINIMAL, inputs: { x: { type: 'string' } } }, /maxLength/);
    expectInvalid({ ...MINIMAL, inputs: { x: { type: 'path' } } }, /maxLength/);
  });

  it('**`default` 与 `pattern` 是允许的**（照 spec/02 §4.3 ✓ —— 评审 38 的 I1 ✓）', () => {
    const pack = parseWorkflow(
      {
        ...MINIMAL,
        inputs: {
          project: { type: 'string', maxLength: 50, default: '01-hello', pattern: '^[a-z0-9-]+$' },
          count: { type: 'integer', min: 1, max: 9, default: 3 },
        },
      },
      'demo.yaml',
    );
    expect(pack.inputs['project']?.default).toBe('01-hello');
    expect(pack.inputs['project']?.pattern).toBe('^[a-z0-9-]+$');
    expect(pack.inputs['count']?.default).toBe(3);
  });

  it('**非法的正则 → 报错**（不是运行时才炸 ✓）', () => {
    expectInvalid(
      { ...MINIMAL, inputs: { x: { type: 'string', maxLength: 10, pattern: '[' } } },
      /不是合法的正则/,
    );
  });

  it('**`default` 自己也要合法**（宿主不能预填一个非法值 ✓）', () => {
    // 数字的 default 落在域外
    expectInvalid({ ...MINIMAL, inputs: { x: { type: 'integer', min: 0, max: 10, default: 99 } } }, /高于 max/);
    // 枚举的 default 不在 values 里
    expectInvalid({ ...MINIMAL, inputs: { x: { type: 'enum', values: ['a'], default: 'b' } } }, /values 里的某一项/);
    // 字符串的 default 超过 maxLength
    expectInvalid(
      { ...MINIMAL, inputs: { x: { type: 'string', maxLength: 3, default: 'toolong' } } },
      /超过 maxLength/,
    );
    // 类型不对
    expectInvalid({ ...MINIMAL, inputs: { x: { type: 'integer', default: 'abc' } } }, /必须是数字/);
  });

  it('unknown 字段在 input 里也不认', () => {
    expectInvalid({ ...MINIMAL, inputs: { x: { type: 'string', maxLength: 4, foo: 1 } } }, /未知字段/);
  });
});

describe('流程包 · roles', () => {
  it('role 必须声明 purpose 与 profile', () => {
    expectInvalid({ ...MINIMAL, roles: { build: { purpose: 'x' } } }, /profile/);
    expectInvalid({ ...MINIMAL, roles: { build: { profile: 'ubuntu-ssh' } } }, /purpose/);
  });

  it('**profile 只能引用已有的 profile id，不许覆写字段**', () => {
    expectInvalid(
      { ...MINIMAL, roles: { build: { purpose: 'x', profile: 'ubuntu-ssh', options: {} } } },
      /未知字段/,
    );
  });

  it('step 引用的 role 必须声明过', () => {
    expectInvalid(
      { ...MINIMAL, steps: [{ id: 'a', kind: 'exec', role: 'nobody', cmd: 'echo 1' }] },
      /role/,
    );
  });
});

describe('流程包 · file.transfer 的 from（契约 §4.4）', () => {
  it('**from 缺 path → 校验就报错**（别留到运行时才炸 ✓ —— 独立评审 40 的 I-2 ✓）', () => {
    expectInvalid(
      {
        ...MINIMAL,
        steps: [
          {
            id: 'deliver',
            kind: 'file.transfer',
            // ⚠️ **from 缺 path** ✓ —— 契约 §4.4 说它是必填 ✓
            from: { role: 'build' },
            to: { role: 'target', placement: 'kernel-module' },
            cmd: 'scp {from.path} root@{role:target.host}:{to.path}',
          },
        ],
      },
      /from/,
    );
  });
});

describe('流程包 · step 的六种 kind', () => {
  const kinds = [
    { id: 'a', kind: 'exec', role: 'build', cmd: 'make' },
    { id: 'b', kind: 'discover', role: 'build', pattern: '*.ko', out: 'artifacts' },
    {
      id: 'c',
      kind: 'file.transfer',
      from: { role: 'build', path: '{output:artifacts}' },
      to: { role: 'target', placement: 'kernel-module' },
      cmd: 'scp {from.path} root@{role:target.host}:{to.path}',
    },
    { id: 'd', kind: 'action', role: 'target', action: 'backlight.set', params: { value: '{input:level}' } },
    { id: 'e', kind: 'await', role: 'target', readback: { kind: 'command_ok' } },
    {
      id: 'f',
      kind: 'assert',
      readback: { kind: 'file_equals', role: 'target', path: '/tmp/x', expect: '1' },
      on_mismatch: 'fail',
    },
  ];

  it('六种 kind 各一个都能过', () => {
    const pack = parseWorkflow(
      { ...MINIMAL, inputs: { level: { type: 'integer', min: 0, max: 255 } }, steps: kinds },
      'demo.yaml',
    );
    expect(pack.steps.map((s) => s.kind)).toEqual([
      'exec',
      'discover',
      'file.transfer',
      'action',
      'await',
      'assert',
    ]);
  });

  it('**未知 kind → 报错**（`exec_script` 也不认）', () => {
    expectInvalid({ ...MINIMAL, steps: [{ id: 'a', kind: 'exec_script', role: 'build' }] }, /kind/);
    expectInvalid({ ...MINIMAL, steps: [{ id: 'a', kind: 'launch', role: 'build' }] }, /kind/);
  });

  it('exec 必须有 role 与 cmd', () => {
    expectInvalid({ ...MINIMAL, steps: [{ id: 'a', kind: 'exec', cmd: 'make' }] }, /role/);
    expectInvalid({ ...MINIMAL, steps: [{ id: 'a', kind: 'exec', role: 'build' }] }, /cmd/);
  });

  it('discover 必须有 pattern 与 out（**产物不写死文件名**）', () => {
    expectInvalid({ ...MINIMAL, steps: [{ id: 'a', kind: 'discover', role: 'build', out: 'x' }] }, /pattern/);
    expectInvalid({ ...MINIMAL, steps: [{ id: 'a', kind: 'discover', role: 'build', pattern: '*.ko' }] }, /out/);
  });

  it('file.transfer 必须有 from / to / cmd', () => {
    expectInvalid(
      { ...MINIMAL, steps: [{ id: 'a', kind: 'file.transfer', from: { role: 'build', path: 'x' } }] },
      /to/,
    );
    expectInvalid(
      {
        ...MINIMAL,
        steps: [
          {
            id: 'a',
            kind: 'file.transfer',
            from: { role: 'build', path: 'x' },
            to: { role: 'target', placement: 'kernel-module' },
          },
        ],
      },
      /cmd/,
    );
  });

  it('**placement 必须在封闭词表里**（拼错 → 报错，不许默默回落）', () => {
    expectInvalid(
      {
        ...MINIMAL,
        steps: [
          {
            id: 'a',
            kind: 'file.transfer',
            from: { role: 'build', path: 'x' },
            to: { role: 'target', placement: 'kernel_modle' },
            cmd: 'scp x y',
          },
        ],
      },
      /placement/,
    );
  });

  it('action 必须指名动作 id', () => {
    expectInvalid({ ...MINIMAL, steps: [{ id: 'a', kind: 'action', role: 'target' }] }, /action/);
  });

  it('await / assert 必须有 readback', () => {
    expectInvalid({ ...MINIMAL, steps: [{ id: 'a', kind: 'await' }] }, /readback/);
    expectInvalid({ ...MINIMAL, steps: [{ id: 'a', kind: 'assert' }] }, /readback/);
  });
});

describe('流程包 · 判据（复用 M6 的五形式 + 「在哪个 role 上读」）', () => {
  it('五形式都能过', () => {
    const pack = parseWorkflow(
      {
        ...MINIMAL,
        steps: [
          { id: 'a', kind: 'await', role: 'target', readback: { kind: 'file_equals', path: '/tmp/x', expect: '1' } },
          { id: 'b', kind: 'await', role: 'target', readback: { kind: 'command_ok' } },
          { id: 'c', kind: 'await', role: 'target', readback: { kind: 'verify', command: 'test -e /tmp/x' } },
          { id: 'd', kind: 'await', role: 'target', readback: { kind: 'none', consequence: '点亮 LED' } },
        ],
      },
      'demo.yaml',
    );
    expect(pack.steps).toHaveLength(4);
  });

  it('**形式 1（tag）在流程层不支持**（tag 属于板型包的核心词表 → 流程层查不了）', () => {
    expectInvalid(
      { ...MINIMAL, steps: [{ id: 'a', kind: 'await', role: 'target', readback: { tag: 'cpu.usage' } }] },
      /暂不支持形式 1/,
    );
  });

  it('`await` / `assert` **必须说得出在哪个角色上读**', () => {
    expectInvalid({ ...MINIMAL, steps: [{ id: 'a', kind: 'await', readback: { kind: 'command_ok' } }] }, /角色/);
  });

  it('**判据可以指名 role**（跨目标的验证就靠它）', () => {
    const pack = parseWorkflow(
      {
        ...MINIMAL,
        steps: [
          {
            id: 'a',
            kind: 'await',
            readback: { kind: 'verify', role: 'target', command: 'test -f /usr/lib/modules/x/extra/a.ko' },
          },
        ],
      },
      'demo.yaml',
    );
    expect(pack.steps[0]?.readback?.role).toBe('target');
  });

  it('判据指名了**没人声明过的 role** → 报错', () => {
    expectInvalid(
      {
        ...MINIMAL,
        steps: [
          { id: 'a', kind: 'await', readback: { kind: 'verify', role: 'nobody', command: 'test -e /x' } },
        ],
      },
      /role/,
    );
  });

  it('**判据的 kind 不在五形式里 → 报错**（不新增第六种）', () => {
    expectInvalid({ ...MINIMAL, steps: [{ id: 'a', kind: 'await', readback: { kind: 'sha256' } }] }, /kind/);
  });

  it('`file_equals` 必须有 path 与 expect；`verify` 必须有 command；`none` 必须有 consequence', () => {
    expectInvalid({ ...MINIMAL, steps: [{ id: 'a', kind: 'await', readback: { kind: 'file_equals' } }] }, /path/);
    expectInvalid({ ...MINIMAL, steps: [{ id: 'a', kind: 'await', readback: { kind: 'verify' } }] }, /command/);
    expectInvalid({ ...MINIMAL, steps: [{ id: 'a', kind: 'await', readback: { kind: 'none' } }] }, /consequence/);
  });
});

describe('流程包 · 占位符', () => {
  it('**未声明的输入名 → 报错**（拼错到运行时才炸是最坏的一种）', () => {
    expectInvalid(
      {
        ...MINIMAL,
        inputs: { project: { type: 'string', maxLength: 20 } },
        steps: [{ id: 'a', kind: 'exec', role: 'build', cmd: 'make {input:projet}' }],
      },
      /input/,
    );
  });

  it('**未声明的 role → 报错**', () => {
    expectInvalid(
      { ...MINIMAL, steps: [{ id: 'a', kind: 'exec', role: 'build', cmd: 'scp x {role:targt.host}' }] },
      /role/,
    );
  });

  it('**未声明的输出槽 → 报错**', () => {
    expectInvalid(
      { ...MINIMAL, steps: [{ id: 'a', kind: 'exec', role: 'build', cmd: 'ls {output:artifacts}' }] },
      /output/,
    );
  });

  it('`{output:槽.name}` = 文件名去掉扩展名（`hello.ko` → `hello`）', () => {
    const pack = parseWorkflow(
      {
        ...MINIMAL,
        steps: [
          { id: 'a', kind: 'discover', role: 'build', pattern: '*.ko', out: 'artifacts' },
          { id: 'b', kind: 'exec', role: 'build', cmd: 'modprobe {output:artifacts.name}' },
        ],
      },
      'demo.yaml',
    );
    expect(pack.steps[1]?.cmd).toBe('modprobe {output:artifacts.name}');
  });

  it('输出槽必须由**前面的某一步**产出', () => {
    expectInvalid(
      {
        ...MINIMAL,
        steps: [
          { id: 'a', kind: 'exec', role: 'build', cmd: 'ls {output:artifacts}' },
          { id: 'b', kind: 'discover', role: 'build', pattern: '*.ko', out: 'artifacts' },
        ],
      },
      /output/,
    );
  });
});

describe('流程包 · 导出', () => {
  it('类型是 WorkflowPack', () => {
    const pack: WorkflowPack = parseWorkflow(MINIMAL, 'demo.yaml');
    expect(pack.kind).toBe('Workflow');
  });
});

describe('流程包 · 黄金样本', () => {
  const DIR = join(__dirname, '../../../profiles/workflows');

  /**
   * ── 为什么样本要当测试跑 ──
   *
   * 样本是**格式的活文档**：写错了（字段名拼错、占位符指向不存在的东西），
   * 文档看着对，流程跑起来才发现 ✗。
   * → **样本必须能被校验器解析** ✓。
   */
  for (const name of ['hello-kernel.build-run', 'meminfo-user.build-run']) {
    it(`${name} 能解析`, () => {
      const raw = yaml.load(readFileSync(join(DIR, `${name}.yaml`), 'utf8'));
      const pack = parseWorkflow(raw, `${name}.yaml`);
      expect(pack.id).toBe(name);
      expect(pack.steps.length).toBeGreaterThan(0);
    });
  }

  it('内核模块那份**按名字加载，不按路径**（绝不 insmod）', () => {
    const raw = yaml.load(readFileSync(join(DIR, 'hello-kernel.build-run.yaml'), 'utf8'));
    const pack = parseWorkflow(raw, 'hello-kernel.build-run.yaml');
    const commands = pack.steps.map((s) => s.cmd ?? '').join('\n');
    expect(commands).not.toContain('insmod');
    expect(commands).toContain('modprobe');
    // 落位是**语义**，不是写死的路径
    expect(pack.steps.find((s) => s.kind === 'file.transfer')?.to?.placement).toBe('kernel-module');
  });

  it('传输步的判据**指名目标 role**（跨目标的验证）', () => {
    const raw = yaml.load(readFileSync(join(DIR, 'hello-kernel.build-run.yaml'), 'utf8'));
    const pack = parseWorkflow(raw, 'hello-kernel.build-run.yaml');
    const transfer = pack.steps.find((s) => s.kind === 'file.transfer');
    expect(transfer?.readback?.role).toBe('target');
  });
});
