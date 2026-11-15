import { describe, it, expect } from 'vitest';
import { dryRunWorkflow } from '../../../src/main/mcp/workflow-dry-run';
import { parseWorkflow, type WorkflowPack } from '../../../src/main/workflows/format';

/**
 * **流程的 dry_run**（契约 `spec/04` §2.4 的 `run_workflow(id, inputs, dry_run)` ✓）。
 *
 * ── 为什么要有 ──
 *
 * **流程会改别人的机器** ✓（编译 ✓ · 写 authorized_keys ✓ · 装模块 ✓）→
 * agent 在跑之前**应该能看见它要干什么** ✓。
 *
 * ── 三条底线 ──
 *
 * | # | 底线 | 为什么 |
 * |---|---|---|
 * | 1 | **不执行任何一步** ✓ | 它是**预览** ✓ |
 * | 2 | **不写审计** ✓ | 审计记的是「每一次尝试」✓ —— 预览**连尝试都不是** ✓ |
 * | 3 | **不产生 run_id** ✓ | 没有运行 → 没有运行 id ✓ |
 */
const PACK = {
  apiVersion: 'devboard/v1',
  kind: 'Workflow',
  id: 'demo.run',
  name: '演示流程',
  version: '1.0.0',
  inputs: {
    project: { type: 'string', required: true, maxLength: 50 },
  },
  roles: {
    build: { purpose: '客机', profile: 'guest' },
  },
  steps: [
    { id: 'compile', kind: 'exec', role: 'build', cmd: 'make -C projects/{input:project}' },
    {
      id: 'discover',
      kind: 'discover',
      role: 'build',
      dir: 'projects/{input:project}',
      pattern: '*.ko',
      out: 'artifact',
    },
  ],
};

function pack(): WorkflowPack {
  return parseWorkflow(PACK, 'demo.yaml');
}

describe('MCP · run_workflow 的 dry_run', () => {
  it('**列出每一步** ✓（**step id / kind / 角色 / 做什么** ✓）', () => {
    const result = dryRunWorkflow(pack(), { project: 'x' });
    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]?.id).toBe('compile');
    expect(result.steps[0]?.kind).toBe('exec');
    expect(result.steps[0]?.role).toBe('build');
    // **字符串输入按 shell 规矩编码 → 带引号** ✓（同 `actions/encoder` ✓）
    expect(result.steps[0]?.command).toContain("make -C projects/'x'");
  });

  it('**不执行任何一步** ✓（**它是预览** ✓）', () => {
    // **没有连接** ✓ —— 能返回就说明它没去连任何机器 ✓
    const result = dryRunWorkflow(pack(), { project: 'x' });
    expect(result.ok).toBe(true);
    // **没有 run_id** ✓（没有运行 → 没有运行 id ✓）
    expect(result.run_id).toBeUndefined();
  });

  it('**占位符按输入替换** ✓（**看到的是真命令** ✓）', () => {
    const result = dryRunWorkflow(pack(), { project: 'myapp' });
    expect(result.steps[0]?.command).toContain("projects/'myapp'");
  });

  it('**危险等级要给** ✓（**agent 要知道哪一步会毁东西** ✓）', () => {
    const result = dryRunWorkflow(pack(), { project: 'x' });
    // **默认是 reversible** ✓
    expect(result.steps[0]?.danger).toBe('reversible');
  });

  it('**destructive 的步要标出来** ✓', () => {
    const destructive = parseWorkflow(
      {
        ...PACK,
        // **两步都在** ✓（**只留一步 → 断言的索引就错了** ✗）
        steps: [
          PACK.steps[0] as object,
          { ...(PACK.steps[1] as object), danger: 'destructive' },
        ],
      },
      'demo.yaml',
    );
    const result = dryRunWorkflow(destructive, { project: 'x' });
    expect(result.steps[1]?.danger).toBe('destructive');
  });

  it('**缺必填输入 → `invalid_params`** ✓（**不猜默认值** ✓）', () => {
    const result = dryRunWorkflow(pack(), {});
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_params');
  });

  it('**不连任何机器** ✓（**所以不验 profile 存不存在** ✓ —— **验不了就不猜** ✓）', () => {
    // **角色绑的 profile 在不在，dry_run 答不了** ✓（**没连** ✓）→ **不报错** ✓
    const result = dryRunWorkflow(pack(), { project: 'x' });
    expect(result.ok).toBe(true);
    // **角色名要给** ✓（**agent 看得见这一步在哪台机器上** ✓）
    expect(result.steps[0]?.role).toBe('build');
  });
});
