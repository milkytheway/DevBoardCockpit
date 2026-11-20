import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { parseWorkflow, type WorkflowPack } from '../../../src/main/workflows/format';

/**
 * The validator for the workflow pack format (a host-level format that is
 * deliberately **not part of `docs/spec/`**).
 *
 * Why the validator is this strict:
 *
 * A workflow pack is a **declaration** of how a task is done, not a script.
 * If a misspelled field name were **silently ignored**, the workflow would
 * still run — it would just do one thing less, or do it on the wrong target.
 * Therefore **an unknown field is always reported**, the same rule as for the
 * board pack and the card manifest.
 *
 * Three closed sets:
 *
 * | What is closed | Why |
 * |---|---|
 * | step kind (6 of them) | nine would be redundant, and `exec_script` does not even keep a slot open |
 * | input type (6 of them) | the closed type table of `spec/02` §4.3, not a second one |
 * | the placement vocabulary | a misspelled `kernel-module` is **reported**, it may not silently fall back to another meaning |
 */
const MINIMAL = {
  apiVersion: 'devboard/v1',
  kind: 'Workflow',
  id: 'demo.run',
  name: 'demo workflow',
  version: '1.0.0',
  inputs: {},
  roles: {
    build: { purpose: 'the build host', profile: 'ubuntu-ssh' },
    target: { purpose: 'the board', profile: 'board-adb' },
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
  expect(threw, `this pack should have been rejected: ${JSON.stringify(raw)}`).toBe(true);
}

describe('workflow pack · parsing', () => {
  it('a complete minimal pack parses', () => {
    const pack = parseWorkflow(MINIMAL, 'demo.yaml');
    expect(pack.id).toBe('demo.run');
    expect(pack.steps).toHaveLength(1);
    expect(pack.roles['build']?.profile).toBe('ubuntu-ssh');
  });

  it('**fields other than description and version are not accepted** (closed schema)', () => {
    expectInvalid({ ...MINIMAL, extra: 1 }, /Unknown field/);
  });

  it('apiVersion accepts only devboard/v1 (**the same vocabulary as the board pack and the card manifest**)', () => {
    expectInvalid({ ...MINIMAL, apiVersion: 'devboard/v2' }, /apiVersion/);
  });

  it('**the example in the contract must pass the validator** (the YAML of the contract is fed in verbatim and may not report an error)', () => {
    // **The YAML of the contract `docs/spec/05` §1, verbatim** (not one character different)
    const text = readFileSync(join(__dirname, '../../../docs/spec/05-workflow-pack.md'), 'utf8');
    const block = text.match(/```yaml\n([\s\S]*?)\n```/);
    expect(block).not.toBeNull();
    const example = yaml.load(block?.[1] ?? '') as unknown;
    expect(() => parseWorkflow(example, 'spec/05-example.yaml')).not.toThrow();
  });

  it('kind must be Workflow', () => {
    expectInvalid({ ...MINIMAL, kind: 'Board' }, /kind/);
  });

  it('id / name / version must be non-empty strings', () => {
    expectInvalid({ ...MINIMAL, id: '' }, /id/);
    expectInvalid({ ...MINIMAL, name: 42 }, /name/);
  });

  it('**the id must be "name.name"** (contract `05` §9 rule 4 — **two segments · lowercase letters and digits · a segment may contain hyphens**)', () => {
    expectInvalid({ ...MINIMAL, id: 'nodot' }, /id/);
    expectInvalid({ ...MINIMAL, id: 'demo.' }, /id/);
    expectInvalid({ ...MINIMAL, id: '.run' }, /id/);
    expectInvalid({ ...MINIMAL, id: 'a.b.c' }, /id/);
    expectInvalid({ ...MINIMAL, id: 'Demo.Run' }, /id/);
    expectInvalid({ ...MINIMAL, id: 'demo_run' }, /id/);
  });

  it('**steps may not be empty** (a workflow pack without steps has no meaning)', () => {
    expectInvalid({ ...MINIMAL, steps: [] }, /steps/);
  });

  it('the id of a step must be unique', () => {
    expectInvalid(
      {
        ...MINIMAL,
        steps: [
          { id: 'a', kind: 'exec', role: 'build', cmd: 'echo 1' },
          { id: 'a', kind: 'exec', role: 'build', cmd: 'echo 2' },
        ],
      },
      /is a duplicate/,
    );
  });
});

describe('workflow pack · the closed type table for inputs', () => {
  it('all six types pass', () => {
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

  it('a type outside the table is reported', () => {
    expectInvalid({ ...MINIMAL, inputs: { x: { type: 'text' } } }, /type/);
  });

  it('**an enum must provide values**', () => {
    expectInvalid({ ...MINIMAL, inputs: { x: { type: 'enum' } } }, /values/);
  });

  it('**a string or a path must provide maxLength** (otherwise it is open-ended)', () => {
    expectInvalid({ ...MINIMAL, inputs: { x: { type: 'string' } } }, /maxLength/);
    expectInvalid({ ...MINIMAL, inputs: { x: { type: 'path' } } }, /maxLength/);
  });

  it('**`default` and `pattern` are allowed** (as in spec/02 §4.3)', () => {
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

  it('**an invalid regular expression is reported** (it must not explode at runtime only)', () => {
    expectInvalid(
      { ...MINIMAL, inputs: { x: { type: 'string', maxLength: 10, pattern: '[' } } },
      /is not a valid regular expression/,
    );
  });

  it('**the `default` itself must be valid** (the host may not prefill an invalid value)', () => {
    // The default of a number is outside the range
    expectInvalid({ ...MINIMAL, inputs: { x: { type: 'integer', min: 0, max: 10, default: 99 } } }, /is above max/);
    // The default of an enum is not in the values
    expectInvalid({ ...MINIMAL, inputs: { x: { type: 'enum', values: ['a'], default: 'b' } } }, /one of the values/);
    // The default of a string is beyond the maxLength
    expectInvalid(
      { ...MINIMAL, inputs: { x: { type: 'string', maxLength: 3, default: 'toolong' } } },
      /exceeds maxLength/,
    );
    // The type is wrong
    expectInvalid({ ...MINIMAL, inputs: { x: { type: 'integer', default: 'abc' } } }, /must be a number/);
  });

  it('an unknown field inside an input is not accepted either', () => {
    expectInvalid({ ...MINIMAL, inputs: { x: { type: 'string', maxLength: 4, foo: 1 } } }, /Unknown field/);
  });
});

describe('workflow pack · roles', () => {
  it('a role must declare purpose and profile', () => {
    expectInvalid({ ...MINIMAL, roles: { build: { purpose: 'x' } } }, /profile/);
    expectInvalid({ ...MINIMAL, roles: { build: { profile: 'ubuntu-ssh' } } }, /purpose/);
  });

  it('**a profile may only reference an existing profile id, it may not override fields**', () => {
    expectInvalid(
      { ...MINIMAL, roles: { build: { purpose: 'x', profile: 'ubuntu-ssh', options: {} } } },
      /Unknown field/,
    );
  });

  it('a role referenced by a step must have been declared', () => {
    expectInvalid(
      { ...MINIMAL, steps: [{ id: 'a', kind: 'exec', role: 'nobody', cmd: 'echo 1' }] },
      /role/,
    );
  });
});

describe('workflow pack · rule 11 (contract §9)', () => {
  it('**a destructive step may not use `readback.kind: none`** (an irreversible action may not skip verification)', () => {
    // ⚠️ The I-4 of the independent review 40 — contract §9 rule 11 wrote that long ago,
    // and **the board packs have the same check** (rule 15 of `tags/validator.ts`),
    // → the workflow packs **let it through silently** → an irreversible step may declare "no verification"
    expectInvalid(
      {
        ...MINIMAL,
        steps: [
          {
            id: 'wipe',
            kind: 'exec',
            role: 'build',
            cmd: 'rm -rf /tmp/x',
            danger: 'destructive',
            readback: { kind: 'none', consequence: 'no state to read back' },
          },
        ],
      },
      /none/,
    );
  });

  it('**a reversible step may use `none`** (a valid case must not be blocked)', () => {
    const pack = parseWorkflow(
      {
        ...MINIMAL,
        steps: [
          {
            id: 'ok',
            kind: 'exec',
            role: 'build',
            cmd: 'echo hi',
            readback: { kind: 'none', consequence: 'no state to read back' },
          },
        ],
      },
      'demo.yaml',
    );
    expect(pack.steps).toHaveLength(1);
  });
});

describe('workflow pack · the from of file.transfer (contract §4.4)', () => {
  it('**a from without a path is reported by the validator** (it must not be left to explode at runtime)', () => {
    expectInvalid(
      {
        ...MINIMAL,
        steps: [
          {
            id: 'deliver',
            kind: 'file.transfer',
            // ⚠️ **A from without a path** — contract §4.4 says it is mandatory
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

describe('workflow pack · the six kinds of step', () => {
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

  it('one of each of the six kinds passes', () => {
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

  it('**an unknown kind is reported** (`exec_script` is not accepted either)', () => {
    expectInvalid({ ...MINIMAL, steps: [{ id: 'a', kind: 'exec_script', role: 'build' }] }, /kind/);
    expectInvalid({ ...MINIMAL, steps: [{ id: 'a', kind: 'launch', role: 'build' }] }, /kind/);
  });

  it('an exec step requires role and cmd', () => {
    expectInvalid({ ...MINIMAL, steps: [{ id: 'a', kind: 'exec', cmd: 'make' }] }, /role/);
    expectInvalid({ ...MINIMAL, steps: [{ id: 'a', kind: 'exec', role: 'build' }] }, /cmd/);
  });

  it('a discover step requires pattern and out (**the artefact name is not hard-coded**)', () => {
    expectInvalid({ ...MINIMAL, steps: [{ id: 'a', kind: 'discover', role: 'build', out: 'x' }] }, /pattern/);
    expectInvalid({ ...MINIMAL, steps: [{ id: 'a', kind: 'discover', role: 'build', pattern: '*.ko' }] }, /out/);
  });

  it('a file.transfer step requires from / to / cmd', () => {
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

  it('**placement must be in the closed vocabulary** (a misspelling is reported, it may not silently fall back)', () => {
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

  it('an action step must name an action id', () => {
    expectInvalid({ ...MINIMAL, steps: [{ id: 'a', kind: 'action', role: 'target' }] }, /action/);
  });

  it('an await or assert step requires a readback', () => {
    expectInvalid({ ...MINIMAL, steps: [{ id: 'a', kind: 'await' }] }, /readback/);
    expectInvalid({ ...MINIMAL, steps: [{ id: 'a', kind: 'assert' }] }, /readback/);
  });
});

describe('workflow pack · the criteria (the five forms, plus the role they are read on)', () => {
  it('all five forms pass', () => {
    const pack = parseWorkflow(
      {
        ...MINIMAL,
        steps: [
          { id: 'a', kind: 'await', role: 'target', readback: { kind: 'file_equals', path: '/tmp/x', expect: '1' } },
          { id: 'b', kind: 'await', role: 'target', readback: { kind: 'command_ok' } },
          { id: 'c', kind: 'await', role: 'target', readback: { kind: 'verify', command: 'test -e /tmp/x' } },
          { id: 'd', kind: 'await', role: 'target', readback: { kind: 'none', consequence: 'lights the LED' } },
        ],
      },
      'demo.yaml',
    );
    expect(pack.steps).toHaveLength(4);
  });

  it('**form 1 (tag) is not supported at the workflow layer** (a tag belongs to the core vocabulary of the board pack, so the workflow layer cannot resolve it)', () => {
    expectInvalid(
      { ...MINIMAL, steps: [{ id: 'a', kind: 'await', role: 'target', readback: { tag: 'cpu.usage' } }] },
      /do not support form 1/,
    );
  });

  it('`await` / `assert` **must state the role they are read on**', () => {
    expectInvalid({ ...MINIMAL, steps: [{ id: 'a', kind: 'await', readback: { kind: 'command_ok' } }] }, /role/);
  });

  it('**a criterion may name a role** (cross-target verification depends on it)', () => {
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

  it('a criterion that names a role **nobody declared** is reported', () => {
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

  it('**a criterion whose kind is not one of the five forms is reported** (there is no sixth form)', () => {
    expectInvalid({ ...MINIMAL, steps: [{ id: 'a', kind: 'await', readback: { kind: 'sha256' } }] }, /kind/);
  });

  it('`file_equals` requires path and expect; `verify` requires command; `none` requires consequence', () => {
    expectInvalid({ ...MINIMAL, steps: [{ id: 'a', kind: 'await', readback: { kind: 'file_equals' } }] }, /path/);
    expectInvalid({ ...MINIMAL, steps: [{ id: 'a', kind: 'await', readback: { kind: 'verify' } }] }, /command/);
    expectInvalid({ ...MINIMAL, steps: [{ id: 'a', kind: 'await', readback: { kind: 'none' } }] }, /consequence/);
  });
});

describe('workflow pack · placeholders', () => {
  it('**an undeclared input name is reported** (a misspelling that only explodes at runtime is the worst kind)', () => {
    expectInvalid(
      {
        ...MINIMAL,
        inputs: { project: { type: 'string', maxLength: 20 } },
        steps: [{ id: 'a', kind: 'exec', role: 'build', cmd: 'make {input:projet}' }],
      },
      /input/,
    );
  });

  it('**an undeclared role is reported**', () => {
    expectInvalid(
      { ...MINIMAL, steps: [{ id: 'a', kind: 'exec', role: 'build', cmd: 'scp x {role:targt.host}' }] },
      /role/,
    );
  });

  it('**an undeclared output slot is reported**', () => {
    expectInvalid(
      { ...MINIMAL, steps: [{ id: 'a', kind: 'exec', role: 'build', cmd: 'ls {output:artifacts}' }] },
      /output/,
    );
  });

  it('`{output:slot.name}` = the file name without its extension (`hello.ko` → `hello`)', () => {
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

  it('an output slot must be produced by **an earlier step**', () => {
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

describe('workflow pack · export', () => {
  it('the type is WorkflowPack', () => {
    const pack: WorkflowPack = parseWorkflow(MINIMAL, 'demo.yaml');
    expect(pack.kind).toBe('Workflow');
  });
});

describe('workflow pack · golden samples', () => {
  const DIR = join(__dirname, '../../../profiles/workflows');

  /**
   * Why the samples have to be run as tests:
   *
   * The samples are the **live documentation of the format**: if one of them
   * is wrong (a misspelled field name, a placeholder that points at
   * something that does not exist), the documentation looks right and the
   * fault only shows when the workflow runs. → **The samples have to be
   * parsable by the validator**.
   */
  for (const name of ['hello-kernel.build-run', 'meminfo-user.build-run']) {
    it(`${name} parses`, () => {
      const raw = yaml.load(readFileSync(join(DIR, `${name}.yaml`), 'utf8'));
      const pack = parseWorkflow(raw, `${name}.yaml`);
      expect(pack.id).toBe(name);
      expect(pack.steps.length).toBeGreaterThan(0);
    });
  }

  /**
   * **Every pack in the directory has to be parsable**
   *
   * Why there is no list of names:
   *
   * With a list of names, **a pack that was added later is in nobody's book**
   * → a broken one is only noticed when it runs. → **The directory is
   * scanned**, so a new pack is watched by this test as soon as it lands.
   */
  it('**every workflow pack in the directory parses** (a new pack is checked as soon as it lands)', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.yaml'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const raw = yaml.load(readFileSync(join(DIR, file), 'utf8'));
      const pack = parseWorkflow(raw, file);
      expect(pack.id, `the id of ${file} does not match the file name`).toBe(file.replace(/\.yaml$/, ''));
      expect(pack.steps.length, `${file} has no steps`).toBeGreaterThan(0);
    }
  });

  it('the kernel module one is **loaded by name, not by path** (never insmod)', () => {
    const raw = yaml.load(readFileSync(join(DIR, 'hello-kernel.build-run.yaml'), 'utf8'));
    const pack = parseWorkflow(raw, 'hello-kernel.build-run.yaml');
    const commands = pack.steps.map((s) => s.cmd ?? '').join('\n');
    expect(commands).not.toContain('insmod');
    expect(commands).toContain('modprobe');
    // The placement is **semantics**, not a hard-coded path
    expect(pack.steps.find((s) => s.kind === 'file.transfer')?.to?.placement).toBe('kernel-module');
  });

  it('the criterion of a transfer step **names the target role** (cross-target verification)', () => {
    const raw = yaml.load(readFileSync(join(DIR, 'hello-kernel.build-run.yaml'), 'utf8'));
    const pack = parseWorkflow(raw, 'hello-kernel.build-run.yaml');
    const transfer = pack.steps.find((s) => s.kind === 'file.transfer');
    expect(transfer?.readback?.role).toBe('target');
  });
});
