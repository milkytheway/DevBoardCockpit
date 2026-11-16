import { describe, it, expect } from 'vitest';
import { projectRunStatus, workflowReasonOf } from '../../../src/main/cards/workflow-view';
import type { WorkflowRunStatus } from '../../../src/main/workflows/service';

/**
 * 卡片侧看到的流程状态（**缩减投影** ✓）。
 *
 * ── 这一层在防什么（V3-M7 ✓）──
 *
 * 宿主侧的状态**很全** ✓：`outputs`（**路径** ✓）· `inputs`（**参数值** ✓）·
 * 每一步的 `role`（**哪台机器** ✓）· `detail`（**人话解释** ✓）· `value`（**文件内容** ✓）。
 *
 * → 卡片是 **AI 写的任意网页** ✓ → 给它的东西**越少越安全** ✓。
 * → `docs/37` 的 **V3-M7** 早就点了这一条 ✓（「按最自然的实现 → **全泄**」✓）。
 *
 * → 所以判据是：**投影之后那些字段一个都不许在** ✓。
 */
function fullStatus(): WorkflowRunStatus {
  return {
    runId: 'wf-abc12345',
    workflowId: 'demo.run',
    state: 'failed',
    stages: [
      {
        stepId: 'compile',
        kind: 'exec',
        role: 'build',
        ok: false,
        verified: false,
        reason: 'readback_mismatch',
        detail: '命令返回非零（客机目录 /home/alientek/build）',
        value: '整段输出',
        audit_id: 'audit-1',
        at: 1000,
        durationMs: 12,
      },
    ],
    current: { stepId: 'compile', kind: 'exec', at: 1000 },
    outputs: { artifacts: '/home/alientek/build/01-hello/hello.ko' },
    inputs: { build_dir: '/home/alientek/build' },
    ok: false,
    reason: 'readback_mismatch',
    startedAt: 900,
  };
}

describe('流程状态给卡片的那一份（V3-M7）', () => {
  it('**每一步只留契约说的那几个字段** ✓', () => {
    const view = projectRunStatus(fullStatus());
    const stage = view.stages[0] as unknown as Record<string, unknown>;
    expect(Object.keys(stage).sort()).toEqual(['kind', 'ok', 'reason', 'stepId', 'verified']);
  });

  it('**路径 / 输出值 / 角色 / 明细 / 审计号一个都不给** ✓', () => {
    const view = projectRunStatus(fullStatus()) as unknown as Record<string, unknown>;
    const serialized = JSON.stringify(view);
    // **路径** ✓
    expect(serialized).not.toContain('/home/alientek');
    // **角色的机器名** ✓
    expect(serialized).not.toContain('build');
    // **审计号** ✓
    expect(serialized).not.toContain('audit-1');
    // **顶层也不给 outputs / inputs** ✓
    expect(view['outputs']).toBeUndefined();
    expect(view['inputs']).toBeUndefined();
  });

  it('**`current` 也不给角色** ✓（那是拓扑 ✓）', () => {
    const view = projectRunStatus(fullStatus());
    expect(Object.keys(view.current ?? {}).sort()).toEqual(['at', 'kind', 'stepId']);
  });

  it('**该给的都给了** ✓（run id · 状态 · 时间线）', () => {
    const view = projectRunStatus(fullStatus());
    expect(view.runId).toBe('wf-abc12345');
    expect(view.workflowId).toBe('demo.run');
    expect(view.state).toBe('failed');
    expect(view.stages).toHaveLength(1);
    expect(view.stages[0]?.reason).toBe('readback_mismatch');
    expect(view.stages[0]?.ok).toBe(false);
  });
});

describe('卡片侧流程失败的理由码（**封闭** ✓）', () => {
  it('**没授权 → denied** ✓', () => {
    expect(workflowReasonOf(new Error('这张卡没有被授权跑流程「demo.run」'))).toBe('denied');
  });

  it('**「没批准」那一档没了** ✓（**2026-11-16 改** ✓ · ADR-D48 ✓ —— **流程包存在即说明** ✓）', () => {
    // **不再有 `not_approved` 这个码** ✓ → **一律当 `failed`** ✓
    // （**不许把原话泄给卡片** ✓ —— **也不许凭空造一个码** ✓）
    expect(workflowReasonOf(new Error('这个流程包还没有被批准'))).toBe('failed');
  });

  it('**没有这个包 → not_found** ✓', () => {
    expect(workflowReasonOf(new Error('没有这个流程包：demo.run'))).toBe('not_found');
  });

  it('**正在跑 → busy** ✓', () => {
    expect(workflowReasonOf(new Error('流程「demo.run」正在跑'))).toBe('busy');
  });

  it('**别的一律 failed** ✓（**不许把原话泄给卡片** ✓）', () => {
    expect(workflowReasonOf(new Error('路径 /etc/passwd 打不开'))).toBe('failed');
    expect(workflowReasonOf(new Error('路径 /etc/passwd 打不开'))).not.toContain('/etc');
  });

  it('**理由码是封闭的** ✓（**就那几个** ✓ —— **不许多出 `not_approved`** ✓）', () => {
    const codes = new Set<string>();
    for (const message of [
      '这张卡没有被授权跑流程「demo.run」',
      '这个流程包还没有被批准',
      '没有这个流程包：demo.run',
      '流程「demo.run」正在跑',
      '参数不对',
      '路径 /etc/passwd 打不开',
    ]) {
      codes.add(workflowReasonOf(new Error(message)));
    }
    expect([...codes].sort()).toEqual([
      'busy',
      'denied',
      'failed',
      'invalid_params',
      'not_found',
    ]);
  });
});
