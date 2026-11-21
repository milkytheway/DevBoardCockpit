import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowRegistry, digestOf } from '../../../src/main/workflows/registry';

/**
 * The **registry of the workflow packs** — the ledger of "which workflows can
 * be run".
 *
 * The rules as they are now (**changed on 2026-11-16**):
 *
 * ① **It knows the id, not the path** — a card and an agent **cannot hand in
 *    a path**;
 * ② **There is no approved ledger any more** — **the existence of the
 *    workflow pack is the statement** (the gate is the unified permission area
 *    in the settings);
 * ③ A broken pack **does not drag the others down** (the same rule as the
 *    loader of the profiles);
 * ④ **The digest of the content is still there** — **it changes when the
 *    content changes** (it is meant to show a person "whether it changed").
 */
let dir: string;
let builtinDir: string;
let userDir: string;

const PACK = {
  apiVersion: 'devboard/v1',
  kind: 'Workflow',
  id: 'demo.run',
  name: 'demo workflow',
  version: '1.0.0',
  inputs: {},
  roles: { build: { purpose: 'the guest', profile: 'ubuntu-ssh' } },
  steps: [{ id: 'hello', kind: 'exec', role: 'build', cmd: 'echo hi' }],
};

function write(dirName: string, file: string, content: unknown): void {
  mkdirSync(dirName, { recursive: true });
  writeFileSync(join(dirName, file), typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
}

function yamlOf(pack: unknown): string {
  // **A YAML is written by hand** (no yaml library → the dependency surface of the test stays smaller)
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

describe('the registry of the workflow packs — it scans the directory', () => {
  it('it scans a pack and registers the id / the digest', () => {
    write(builtinDir, 'demo.yaml', yamlOf(PACK));
    const reg = registry();
    reg.scan();
    const list = reg.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('demo.run');
    expect(list[0]?.digest).toHaveLength(16);
  });

  it('**a broken pack does not drag the others down** (it is skipped and one warning is recorded)', () => {
    write(builtinDir, 'demo.yaml', yamlOf(PACK));
    write(builtinDir, 'broken.yaml', 'apiVersion: devboard/v1\nkind: does not exist\n');
    const warnings: string[] = [];
    const reg = registry((m) => warnings.push(m));
    reg.scan();
    expect(reg.list().map((w) => w.id)).toEqual(['demo.run']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('broken.yaml');
  });

  it('**with the same id the user directory wins** (the same rule as for the cards and the profiles)', () => {
    write(builtinDir, 'demo.yaml', yamlOf(PACK));
    write(userDir, 'demo.yaml', yamlOf({ ...PACK, name: 'the one of the user' }));
    const reg = registry();
    reg.scan();
    expect(reg.list()).toHaveLength(1);
    expect(reg.list()[0]?.name).toBe('the one of the user');
  });
});

describe('the registry of the workflow packs — it takes a pack', () => {
  it('**putting a file into the directory is enough to run it** (**the existence is the statement**)', () => {
    write(userDir, 'demo.yaml', yamlOf(PACK));
    const reg = registry();
    reg.scan();
    // **There is no "was it approved" question any more**
    expect(reg.require('demo.run').id).toBe('demo.run');
  });

  it('**there is no such pack** → it reports an error (and says which kind it is)', () => {
    const reg = registry();
    reg.scan();
    expect(() => reg.require('nobody')).toThrow(/no such workflow pack/);
  });

  it('**the list holds all of them** (**the unapproved ones are not filtered out any more** — the operator has to see them)', () => {
    write(userDir, 'demo.yaml', yamlOf(PACK));
    write(userDir, 'other.yaml', yamlOf({ ...PACK, id: 'other.run' }));
    const reg = registry();
    reg.scan();
    expect(reg.list().map((w) => w.id)).toEqual(['demo.run', 'other.run']);
  });

  it('**the digest of the content** (16 hexadecimal digits) — **it changes when the content changes**', () => {
    write(userDir, 'demo.yaml', yamlOf(PACK));
    const reg = registry();
    reg.scan();
    const before = reg.get('demo.run')?.digest;
    expect(before).toHaveLength(16);

    // **The content was changed** (the command changed)
    write(userDir, 'demo.yaml', yamlOf({ ...PACK, steps: [{ ...PACK.steps[0], cmd: 'echo bye' }] }));
    reg.scan();
    expect(reg.get('demo.run')?.digest).not.toBe(before);
    expect(reg.get('demo.run')?.digest).toBe(
      digestOf(readFileSync(join(userDir, 'demo.yaml'), 'utf8')),
    );
  });

  it('**what this pack would do** (`planOf` — it is meant for a person to look at)', () => {
    write(userDir, 'demo.yaml', yamlOf(PACK));
    const reg = registry();
    reg.scan();
    const plan = reg.planOf('demo.run');
    expect(plan?.id).toBe('demo.run');
    expect(plan?.roles.map((r) => r.role)).toEqual(['build']);
    expect(plan?.steps.map((s) => s.id)).toEqual(['hello']);
  });

  it('**there is no such pack → `planOf` gives undefined** (**it does not throw**)', () => {
    const reg = registry();
    reg.scan();
    expect(reg.planOf('nobody')).toBeUndefined();
  });
});

/**
 * **The registry notices a change** ✓ (found on 2026-11-21 ✓).
 *
 * → The registry was scanned **once at the start** ✓ → a workflow pack that
 *   is added while the application runs was invisible ✓ (it was not in the
 *   permission area ✓ and `validate_card` did not know it ✓).
 */
describe('the registry of the workflow packs — it notices a change', () => {
  it('**a pack that is added while the application runs is found** ✓', () => {
    write(builtinDir, 'demo.yaml', yamlOf(PACK));
    const reg = registry();
    reg.scan();
    expect(reg.list()).toHaveLength(1);

    // → **A new pack appears** ✓ → the next list sees it ✓.
    write(userDir, 'second.yaml', yamlOf({ ...PACK, id: 'second.run', name: 'second' }));
    expect(reg.list().map((p) => p.id).sort()).toEqual(['demo.run', 'second.run']);
    expect(reg.get('second.run')).toBeDefined();
  });

  it('**a pack that is removed while the application runs is gone** ✓', () => {
    write(builtinDir, 'demo.yaml', yamlOf(PACK));
    const reg = registry();
    reg.scan();
    expect(reg.list()).toHaveLength(1);

    rmSync(join(builtinDir, 'demo.yaml'), { force: true });
    expect(reg.list()).toHaveLength(0);
    expect(reg.get('demo.run')).toBeUndefined();
  });
});
