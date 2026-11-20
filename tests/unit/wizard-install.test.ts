import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadBoardPack } from '../../src/main/tags/pack';
import { validatePack, errorsOf } from '../../src/main/tags/validator';
import { instantiatePack, type ProbeOutcome } from '../../src/main/wizard/instantiate';
import { installInstantiatedPack, packToYamlShape } from '../../src/main/wizard/install';

/**
 * The **writing to disk** — the instantiated pack has to **really be read
 * back** — added on 2026-11-19.
 *
 * Why this has to be tested:
 *
 * → **"Writing to disk" is I/O**, and that is where **the mistake "what was
 *   written cannot be read back"** lives (**is the shape of the YAML right**
 *   · **are the names of the fields right** · **does the closed schema carry
 *   one too many**).
 * → And **a pack that cannot be read back is dead on arrival** → **the wizard
 *   did it for nothing**.
 */
const REPO_ROOT = resolve(process.cwd());
const GENERIC_DIR = join(REPO_ROOT, 'profiles', 'boards', 'generic-linux');

function outcome(readerId: string, ok: boolean): ProbeOutcome {
  return { readerId, ok, detail: ok ? '' : 'it cannot be read', tags: [] };
}

const ALL_GREEN: ProbeOutcome[] = [
  'cpu', 'mem', 'loadavg1', 'loadavg5', 'loadavg15', 'model', 'osrelease',
  'kernel', 'uptime', 'thermal', 'backlight', 'led', 'net',
].map((id) => outcome(id, true));

function instance(targetId = 'atk-01') {
  return instantiatePack({
    source: loadBoardPack(GENERIC_DIR),
    targetId,
    targetName: 'my board',
    outcomes: ALL_GREEN,
  });
}

describe('the writing to disk · **what was written has to be read back**', () => {
  it('**the pack on disk can be read back by the loader** (**dead on arrival = the wizard did it for nothing**)', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiz-'));
    try {
      const { pack, provenance } = instance();
      installInstantiatedPack({ pack, provenance, boardsRoot: root });
      const back = loadBoardPack(join(root, 'atk-01'));
      expect(back.id).toBe('atk-01');
      expect(back.readers.length).toBe(pack.readers.length);
      expect(
        errorsOf(validatePack(back)).map((e) => `rule ${e.rule} · ${e.path}: ${e.message}`),
        '**the pack that was read back still has to pass the validation** — otherwise the runtime reports "the pack is broken" when it reads it',
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('**`provenance.json` was written as well** (**"it was guessed" has to leave a trace**)', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiz-'));
    try {
      const { pack, provenance } = instance();
      installInstantiatedPack({ pack, provenance, boardsRoot: root });
      const raw = readFileSync(join(root, 'atk-01', 'provenance.json'), 'utf8');
      const parsed = JSON.parse(raw) as typeof provenance;
      expect(parsed.source).toBe('generic-linux');
      expect(parsed.targetId).toBe('atk-01');
      expect(parsed.guessed.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('**the YAML does not carry a field too many** (**the closed schema rejects an unknown field** — rule 10)', () => {
    const shape = packToYamlShape(instance().pack);
    expect(Object.keys(shape).sort()).toEqual([
      'actions',
      'apiVersion',
      'custom',
      'danger_floor_version',
      'description',
      'id',
      'kind',
      'name',
      'poll_groups',
      'readers',
      'requires',
      'version',
    ]);
  });

  it('**the YAML carries no `match`** (**it does not take part in the automatic recognition** — the model is for the operator to decide)', () => {
    const shape = packToYamlShape(instance().pack);
    expect(shape['match'], 'writing a match would let it fight another pack for this board').toBeUndefined();
  });

  it('**it already exists → it is not silently overwritten** (**the data of the operator may not be swallowed**)', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiz-'));
    try {
      const first = instance();
      installInstantiatedPack({ pack: first.pack, provenance: first.provenance, boardsRoot: root });
      const second = instance();
      let threw = false;
      try {
        installInstantiatedPack({ pack: second.pack, provenance: second.provenance, boardsRoot: root });
      } catch {
        threw = true;
      }
      expect(threw, 'the second write to disk has to be refused').toBe(true);
      // **It says explicitly that it overwrites → it overwrites**
      installInstantiatedPack({
        pack: second.pack,
        provenance: second.provenance,
        boardsRoot: root,
        overwrite: true,
      });
      expect(existsSync(join(root, 'atk-01', 'board.yaml'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
