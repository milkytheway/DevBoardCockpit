import { describe, it, expect } from 'vitest';
import { projectRunStatus, workflowReasonOf } from '../../../src/main/cards/workflow-view';
import type { WorkflowRunStatus } from '../../../src/main/workflows/service';

/**
 * The workflow state as the card sees it (**a reduced projection**).
 *
 * What this layer defends against (V3-M7):
 *
 * The state on the host side is **very complete**: `outputs` (**the paths**),
 * `inputs` (**the argument values**), the `role` of every step (**which
 * machine**), the `detail` (**an explanation in words**), the `value` (**the
 * content of the file**).
 *
 * → A card is **an arbitrary web page written by an AI**, so **the less it
 *   gets, the safer it is**.
 *
 * → Therefore the criterion is: **not one of those fields may be there after
 *   the projection**.
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
        detail: 'the command returned a non-zero code (the guest directory /home/alientek/build)',
        value: 'the whole output',
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

describe('the workflow state as it is given to a card (V3-M7)', () => {
  it('**every step keeps only the few fields the contract names**', () => {
    const view = projectRunStatus(fullStatus());
    const stage = view.stages[0] as unknown as Record<string, unknown>;
    expect(Object.keys(stage).sort()).toEqual(['kind', 'ok', 'reason', 'stepId', 'verified']);
  });

  it('**not a single path / output value / role / detail / audit id is given**', () => {
    const view = projectRunStatus(fullStatus()) as unknown as Record<string, unknown>;
    const serialized = JSON.stringify(view);
    // **the path**
    expect(serialized).not.toContain('/home/alientek');
    // **the machine of the role**
    expect(serialized).not.toContain('build');
    // **the audit id**
    expect(serialized).not.toContain('audit-1');
    // **the top level does not give outputs / inputs either**
    expect(view['outputs']).toBeUndefined();
    expect(view['inputs']).toBeUndefined();
  });

  it('**`current` does not carry a role either** (that is the topology)', () => {
    const view = projectRunStatus(fullStatus());
    expect(Object.keys(view.current ?? {}).sort()).toEqual(['at', 'kind', 'stepId']);
  });

  it('**everything that has to be given is given** (the run id, the state, the timeline)', () => {
    const view = projectRunStatus(fullStatus());
    expect(view.runId).toBe('wf-abc12345');
    expect(view.workflowId).toBe('demo.run');
    expect(view.state).toBe('failed');
    expect(view.stages).toHaveLength(1);
    expect(view.stages[0]?.reason).toBe('readback_mismatch');
    expect(view.stages[0]?.ok).toBe(false);
  });
});

describe('the reason codes of a failed workflow on the card side (**closed**)', () => {
  it('**not permitted → denied**', () => {
    expect(workflowReasonOf(new Error('this card is not authorized to run the workflow "demo.run"'))).toBe('denied');
  });

  it('**the "not approved" outcome is gone** (**the existence of the workflow pack is the statement**)', () => {
    // **there is no `not_approved` code any more** → **everything is `failed`**
    // (**the original wording may not leak to the card** — **and no code may be invented either**)
    expect(workflowReasonOf(new Error('this workflow pack has not been approved'))).toBe('failed');
  });

  it('**there is no such pack → not_found**', () => {
    expect(workflowReasonOf(new Error('no such workflow pack: demo.run'))).toBe('not_found');
  });

  it('**it is running → busy**', () => {
    expect(workflowReasonOf(new Error('workflow "demo.run" is running'))).toBe('busy');
  });

  it('**everything else is failed** (**the original wording may not leak to the card**)', () => {
    expect(workflowReasonOf(new Error('the path /etc/passwd cannot be opened'))).toBe('failed');
    expect(workflowReasonOf(new Error('the path /etc/passwd cannot be opened'))).not.toContain('/etc');
  });

  it('**the reason codes are closed** (**just those** — **there may be no `not_approved`**)', () => {
    const codes = new Set<string>();
    for (const message of [
      'this card is not authorized to run the workflow "demo.run"',
      'this workflow pack has not been approved',
      'no such workflow pack: demo.run',
      'workflow "demo.run" is running',
      'the parameter is wrong',
      'the path /etc/passwd cannot be opened',
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
