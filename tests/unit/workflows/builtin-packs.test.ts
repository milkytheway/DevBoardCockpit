import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { parseWorkflow } from '../../../src/main/workflows/format';

/**
 * The **golden criteria of the built-in workflow packs** (2026-11-19, found
 * while the installed build was being accepted).
 *
 * Why the built-in packs need guards:
 *
 * → A built-in pack is **part of the product** — if it is broken, the operator
 *   runs into it on the first click.
 * → And it is a **live sample of the format of a workflow pack** — an agent
 *   learns how to write one by it, so **if it is wrong, the agent copies the
 *   mistake**.
 *
 * What this batch guards (three rules, all found on a real board):
 *
 * | # | Rule | Why |
 * |---|---|---|
 * | 1 | **the default of `build_dir` has to be the directory that really exists on the board** | a wrong one → the card "compile and flash" **fails for sure** on a click (measured on 2026-11-19) |
 * | 2 | **`inputs.default` may not contradict "another pack on the same machine"** | two packs pointing at different guest directories → the operator has to guess |
 * | 3 | **a pack that has a write action must declare the inputs it uses** | a missing declaration → the caller cannot pass it in → the step does not run |
 */
const REPO_ROOT = resolve(__dirname, '../../..');
const PACK_DIR = join(REPO_ROOT, 'profiles', 'workflows');

/** Reads one built-in pack (**through the real parser** — not by reading the YAML text) */
function loadPack(file: string): ReturnType<typeof parseWorkflow> {
  const raw = yaml.load(readFileSync(join(PACK_DIR, file), 'utf8'));
  return parseWorkflow(raw, file);
}

/** The project root that **really exists** on the guest (measured on a real board on 2026-11-19) */
const REAL_BUILD_DIR = '/home/alientek/build';

describe('the built-in workflow packs · the golden criteria (measured on a real board on 2026-11-19)', () => {
  it('**every built-in pack parses** (the format layer guards itself first)', () => {
    for (const file of readdirSync(PACK_DIR)) {
      if (!file.endsWith('.yaml')) continue;
      expect(() => loadPack(file)).not.toThrow();
    }
  });

  it('**the default of `build_dir` points at a directory that really exists on the board** (a wrong one → the card "compile and flash" fails for sure on a click)', () => {
    // **Measured on a real board (2026-11-19, on the guest)**: `/home/alientek/build/01-hello` is there
    // → while `/home/alientek/kernel-build` **does not exist** → running with that default is bound to fail
    for (const file of ['hello-kernel.compile.yaml', 'hello-kernel.upload.yaml']) {
      const pack = loadPack(file);
      const def = pack.inputs['build_dir'];
      expect(def, `${file} should have a build_dir input`).toBeDefined();
      expect(
        def?.default,
        `the default of build_dir of ${file} has to be ${REAL_BUILD_DIR} on the real board (measured on 2026-11-19)`,
      ).toBe(REAL_BUILD_DIR);
    }
  });

  it('**the placeholder of the card "compile and flash" agrees with the default of the pack** (what the operator sees and what really runs are the same)', () => {
    const html = readFileSync(join(REPO_ROOT, 'cards', 'build-deploy', 'index.html'), 'utf8');
    expect(html).toContain(REAL_BUILD_DIR);
    expect(html).not.toContain('/home/alientek/kernel-build');
  });

  it('**every pack that writes to the board declares `build_dir`** (a missing declaration → the caller cannot pass it in)', () => {
    for (const file of ['hello-kernel.compile.yaml', 'hello-kernel.upload.yaml']) {
      const pack = loadPack(file);
      expect(Object.keys(pack.inputs)).toContain('build_dir');
    }
  });
});
