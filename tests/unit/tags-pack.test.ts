import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBoardPack, loadBoardPack } from '../../src/main/tags/pack';

/**
 * The loader of a board pack.
 *
 * Why there is a loader at all: the contract says that an unknown field must
 * be reported (rules 10 / 24) — a field that is silently ignored is a
 * misspelled field. The core duty of this module is therefore not "read the
 * YAML" but **the field-by-field check**.
 *
 * The real packs test that a real pack loads, the synthetic packs test that
 * a broken pack is stopped: **the real packs stay faithful, the synthetic
 * packs cover the rules** (the same pattern as the validator).
 */

const REPO = join(__dirname, '../..');
const REAL_PACK_DIR = join(REPO, 'profiles/boards/rk3588-atk');

/** A minimal valid pack (the synthetic packs are derived from it) */
const MINIMAL = `
apiVersion: devboard/v1
kind: BoardPack
id: tiny
name: minimal pack
version: 1.0.0
requires:
  transports: [adb]
  capabilities: [exec]
  min_contract: devboard/v1
poll_groups:
  - id: fast
    interval_ms: 1000
    readers: [cpu]
readers:
  - id: cpu
    kind: proc_stat
    args:
      stat_path: /proc/stat
      cpuinfo_path: /proc/cpuinfo
    provides:
      - tag: cpu.usage
        sample: usage
custom: []
actions: []
`;

describe('loadBoardPack · a real pack', () => {
  it('it loads the rk3588-atk pack of the repository', () => {
    const pack = loadBoardPack(REAL_PACK_DIR);
    expect(pack.id).toBe('rk3588-atk');
    expect(pack.apiVersion).toBe('devboard/v1');
    expect(pack.kind).toBe('BoardPack');
    expect(pack.readers).toHaveLength(7);
    expect(pack.custom).toHaveLength(4);
    // **The number of actions grows** (12 were added on 2026-11-16) →
    // **Do not hard-code the number** (adding one action makes this test fail — and
// a failure does not say where the problem is).
    // → The criterion is a **property** instead ("every one has a readback", "the
// ids are unique") — that is what the contract asks for.
    expect(pack.actions.length).toBeGreaterThanOrEqual(3);
  });

  it('**every action has a readback** (rule 27 — without it the loop breaks silently)', () => {
    const pack = loadBoardPack(REAL_PACK_DIR);
    for (const action of pack.actions) {
      expect(action.readback, `${action.id} has no readback`).toBeDefined();
      // **A `none` has to carry a consequence** (rule 27)
      if (action.readback?.kind === 'none') {
        expect(action.readback.consequence, `the none of ${action.id} has no consequence`).toBeTruthy();
      }
    }
  });

  it('the ids of the actions are unique (a duplicate means two switches with the same name in the permission area)', () => {
    const pack = loadBoardPack(REAL_PACK_DIR);
    const ids = pack.actions.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('**every parameter of an action is used** (rule 14: a dead parameter is an authorisation surface written for nothing)', () => {
    const pack = loadBoardPack(REAL_PACK_DIR);
    for (const action of pack.actions) {
      const names = Object.keys(action.params ?? {});
      const blob = [
        action.command,
        action.readback?.path ?? '',
        action.readback?.expect === undefined ? '' : String(action.readback.expect),
        action.readback?.command ?? '',
      ].join(' ');
      for (const name of names) {
        expect(blob, `the parameter ${name} of ${action.id} is not used anywhere`).toContain(`{${name}}`);
      }
    }
  });

  it('requires.capabilities does not contain stream (rule 26: it cannot be offered even if it is declared)', () => {
    const pack = loadBoardPack(REAL_PACK_DIR);
    expect(pack.requires.capabilities).toEqual(['shell', 'exec', 'files']);
    expect(pack.requires.capabilities).not.toContain('stream');
  });

  it('readers and custom are two lists (§9)', () => {
    const pack = loadBoardPack(REAL_PACK_DIR);
    expect(pack.custom.map((r) => r.id)).toEqual([
      'backlight',
      'backlight1',
      'npu_devfreq',
      'npu_freq',
    ]);
  });

  it('the poll_groups cover every reader (the premise of rule 17)', () => {
    const pack = loadBoardPack(REAL_PACK_DIR);
    const grouped = pack.poll_groups.flatMap((g) => g.readers);
    const all = [...pack.readers, ...pack.custom].map((r) => r.id);
    expect(grouped.sort()).toEqual(all.sort());
  });
});

describe('parseBoardPack · an unknown field must be reported (rules 10 / 24)', () => {
  it('an unknown top-level field is reported, the message names the field', () => {
    const yaml = MINIMAL.replace('requires:', 'requirez:');
    expect(() => parseBoardPack(yaml, 'tiny/board.yaml')).toThrow(/requirez/);
  });

  it('an unknown field of a reader is reported', () => {
    const yaml = MINIMAL.replace('    kind: proc_stat\n', '    kind: proc_stat\n    argz: {}\n');
    expect(() => parseBoardPack(yaml, 'tiny/board.yaml')).toThrow(/argz/);
  });

  it('an unknown field of an action is reported', () => {
    const yaml = MINIMAL.replace(
      'actions: []',
      'actions:\n  - id: a\n    danger: reversible\n    commnd: "echo 1"',
    );
    expect(() => parseBoardPack(yaml, 'tiny/board.yaml')).toThrow(/commnd/);
  });

  it('an unknown field of provides is reported', () => {
    const yaml = MINIMAL.replace('        sample: usage', '        sample: usage\n        targ: cpu.usage');
    expect(() => parseBoardPack(yaml, 'tiny/board.yaml')).toThrow(/targ/);
  });

  it('the message says "it may be a misspelling" — it is a hint for a person', () => {
    const yaml = MINIMAL.replace('requires:', 'requirez:');
    expect(() => parseBoardPack(yaml, 'tiny/board.yaml')).toThrow(/misspelled/);
  });

  it('the message carries the path (something like readers[0])', () => {
    const yaml = MINIMAL.replace('    kind: proc_stat\n', '    kind: proc_stat\n    argz: {}\n');
    expect(() => parseBoardPack(yaml, 'tiny/board.yaml')).toThrow(/readers\[0\]/);
  });

  it('the parameter names in args are **not** stopped by the loader — that is the business of rule 8 (the validator)', () => {
    // **The division of the work**: the loader only handles the **structure** (which section this field belongs to);
    // whether the name of the parameter is right is a question for the schema of the kind (rule 8) — that is the business of the validator.
    // If the two were mixed together, the loader would have to depend on the registry of the kinds and the test could no longer tell who stopped it.
    const yaml = MINIMAL.replace('      stat_path: /proc/stat', '      stat_pathh: /proc/stat');
    expect(() => parseBoardPack(yaml, 'tiny/board.yaml')).not.toThrow();
  });
});

describe('parseBoardPack · a missing field and a wrong type', () => {
  it('a missing apiVersion is reported, the message names the field', () => {
    const yaml = MINIMAL.replace('apiVersion: devboard/v1\n', '');
    expect(() => parseBoardPack(yaml, 'tiny/board.yaml')).toThrow(/missing required field apiVersion/);
  });

  it('a missing id is reported', () => {
    const yaml = MINIMAL.replace('id: tiny\n', '');
    expect(() => parseBoardPack(yaml, 'tiny/board.yaml')).toThrow(/missing required field id/);
  });

  it('a missing poll_groups is reported', () => {
    const yaml = MINIMAL.replace(/poll_groups:[\s\S]*?readers: \[cpu\]\n/, '');
    expect(() => parseBoardPack(yaml, 'tiny/board.yaml')).toThrow(/missing required field poll_groups/);
  });

  it('an interval_ms that is a string is reported (a wrong type may not be taken for 0)', () => {
    const yaml = MINIMAL.replace('interval_ms: 1000', 'interval_ms: "soon"');
    expect(() => parseBoardPack(yaml, 'tiny/board.yaml')).toThrow(/interval_ms/);
  });

  it('a broken YAML is reported (not an empty pack)', () => {
    expect(() => parseBoardPack('apiVersion: [unclosed\n', 'tiny/board.yaml')).toThrow();
  });

  it('an empty file is reported', () => {
    expect(() => parseBoardPack('', 'tiny/board.yaml')).toThrow();
  });
});

describe('loadBoardPack · the file does not exist', () => {
  it('a directory without board.yaml is reported', () => {
    const dir = mkdtempSync(join(tmpdir(), 'empty-'));
    try {
      expect(() => loadBoardPack(dir)).toThrow(/board\.yaml/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
