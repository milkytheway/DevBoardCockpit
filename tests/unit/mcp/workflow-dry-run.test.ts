import { describe, it, expect } from 'vitest';
import { dryRunWorkflow } from '../../../src/main/mcp/workflow-dry-run';
import { parseWorkflow, type WorkflowPack } from '../../../src/main/workflows/format';

/**
 * The dry_run of a workflow (contract `spec/04` §2.4,
 * `run_workflow(id, inputs, dry_run)`).
 *
 * Why it exists:
 *
 * A workflow **changes other people's machines** (it compiles, it writes
 * authorized_keys, it installs modules), so the agent **should be able to see
 * what it is about to do** before it runs.
 *
 * Three bottom lines:
 *
 * | # | Bottom line | Why |
 * |---|---|---|
 * | 1 | **no step is executed** | it is a **preview** |
 * | 2 | **no audit row is written** | the audit records "every attempt", and a preview is **not even an attempt** |
 * | 3 | **no run_id is produced** | no run → no run id |
 */
const PACK = {
  apiVersion: 'devboard/v1',
  kind: 'Workflow',
  id: 'demo.run',
  name: 'demo workflow',
  version: '1.0.0',
  inputs: {
    project: { type: 'string', required: true, maxLength: 50 },
  },
  roles: {
    build: { purpose: 'the guest', profile: 'guest' },
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

describe('MCP · the dry_run of run_workflow', () => {
  it('**every step is listed** (**step id / kind / role / what it does**)', () => {
    const result = dryRunWorkflow(pack(), { project: 'x' });
    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.steps?.[0]?.id).toBe('compile');
    expect(result.steps?.[0]?.kind).toBe('exec');
    expect(result.steps?.[0]?.role).toBe('build');
    // **a string input is encoded by the rules of the shell → it is quoted** (as in
// `actions/encoder`)
    expect(result.steps?.[0]?.command).toContain("make -C projects/'x'");
  });

  it('**no step is executed** (**it is a preview**)', () => {
    // **no connection** — the fact that it can answer shows that it did not reach
// any machine
    const result = dryRunWorkflow(pack(), { project: 'x' });
    expect(result.ok).toBe(true);
    // **no run_id** (no run → no run id)
    expect(result.run_id).toBeUndefined();
  });

  it('**the placeholders are substituted from the inputs** (**what is shown is the real command**)', () => {
    const result = dryRunWorkflow(pack(), { project: 'myapp' });
    expect(result.steps?.[0]?.command).toContain("projects/'myapp'");
  });

  it('**the danger level is given** (**the agent has to know which step destroys things**)', () => {
    const result = dryRunWorkflow(pack(), { project: 'x' });
    // **the default is reversible**
    expect(result.steps?.[0]?.danger).toBe('reversible');
  });

  it('**the destructive steps are marked**', () => {
    const destructive = parseWorkflow(
      {
        ...PACK,
        // **both steps are there** (**leaving one out would break the index of the
// assertion**)
        steps: [
          PACK.steps[0] as object,
          { ...(PACK.steps[1] as object), danger: 'destructive' },
        ],
      },
      'demo.yaml',
    );
    const result = dryRunWorkflow(destructive, { project: 'x' });
    expect(result.steps?.[1]?.danger).toBe('destructive');
  });

  it('**a missing required input → `invalid_params`** (**it does not guess a default**)', () => {
    const result = dryRunWorkflow(pack(), {});
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_params');
  });

  it('**it connects to no machine** (**so it does not check whether the profile exists** — what cannot be checked is not guessed)', () => {
    // **whether the profile of a role exists cannot be answered by dry_run** (**it
// connects to nothing**) → **it does not report an error**
    const result = dryRunWorkflow(pack(), { project: 'x' });
    expect(result.ok).toBe(true);
    // **the role name is given** (**the agent sees on which machine this step
// runs**)
    expect(result.steps?.[0]?.role).toBe('build');
  });
});
