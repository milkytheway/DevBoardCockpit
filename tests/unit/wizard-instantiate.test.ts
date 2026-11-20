import { describe, it, expect } from 'vitest';
import { join, resolve } from 'node:path';
import { loadBoardPack } from '../../src/main/tags/pack';
import { validatePack, errorsOf } from '../../src/main/tags/validator';
import { instantiatePack, type ProbeOutcome } from '../../src/main/wizard/instantiate';

/**
 * The **instantiation**: the generic pack (the recipe) → the first pack of one
 * board, added on 2026-11-19.
 *
 * What it is:
 *
 * → **The result of trying the generic pack on a board** becomes **the pack of
 *   that board**. This breaks the chicken-and-egg problem of "a pack has to
 *   exist before a board can be connected".
 *
 * → It **has to rewrite the `custom.` prefix** (this is the step that is
 *   easiest to miss):
 *
 * → **Rule 1**: a `tag` has to be in the core vocabulary **or under
 *   `custom.<pack id>.`** (`isCustomTag(name, packId)` → `custom.${packId}.*`).
 * → The id of the generic pack is `generic-linux`, so **its tags are
 *   necessarily `custom.generic-linux.*`**.
 * → **The id of the instantiated pack is `atk-01`**, so **those tags carried
 *   over unchanged are stopped by rule 1 at once**, and **the pack on disk is
 *   illegal from the start** — the product of the wizard would be dead on
 *   arrival.
 * → Therefore **the instantiation has to rewrite the prefix**:
 *   `custom.generic-linux.*` → `custom.atk-01.*`.
 *
 * It has the **same shape** as the existing packs:
 *
 * → The pack of `rk3588-atk` holds `custom.rk3588-atk.*` — the same shape, so
 *   the product gets the validator for free and **the criterion is "it has to
 *   pass the real validator"**.
 */
const REPO_ROOT = resolve(process.cwd());
const GENERIC_DIR = join(REPO_ROOT, 'profiles', 'boards', 'generic-linux');

/** One result of the probe */
function outcome(
  readerId: string,
  ok: boolean,
  detail = '',
): ProbeOutcome {
  return { readerId, ok, detail, tags: ok ? [] : [] };
}

/** The results the generic pack found (**simulated**: mostly green) */
const ALL_GREEN: ProbeOutcome[] = [
  outcome('cpu', true),
  outcome('mem', true),
  outcome('loadavg1', true),
  outcome('loadavg5', true),
  outcome('loadavg15', true),
  outcome('model', true),
  outcome('osrelease', true),
  outcome('kernel', true),
  outcome('uptime', true),
  outcome('thermal', true),
  outcome('backlight', true),
  outcome('led', true),
  outcome('net', true),
];

describe('the instantiation · **the pack on disk has to pass the real validator**', () => {
  it('**all green → the instantiated pack has 0 errors** (**this is the criterion itself**)', () => {
    const result = instantiatePack({
      source: loadBoardPack(GENERIC_DIR),
      targetId: 'atk-01',
      targetName: 'my board',
      outcomes: ALL_GREEN,
    });
    expect(
      errorsOf(validatePack(result.pack)).map((e) => `rule ${e.rule} · ${e.path}: ${e.message}`),
      '**the instantiated pack has to pass the validation** — otherwise the product of the wizard is dead on arrival',
    ).toEqual([]);
  });

  it('**the `custom.` prefix is rewritten to the id of the new pack** (**an unavoidable requirement of rule 1**)', () => {
    const result = instantiatePack({
      source: loadBoardPack(GENERIC_DIR),
      targetId: 'atk-01',
      targetName: 'my board',
      outcomes: ALL_GREEN,
    });
    for (const reader of [...result.pack.readers, ...result.pack.custom]) {
      for (const p of reader.provides) {
        if (p.tag.startsWith('custom.')) {
          expect(
            p.tag,
            `the tag "${p.tag}" is still in the namespace of the generic pack → **rule 1 stops it**` +
              `(the id of the new pack is atk-01 → it should be custom.atk-01.*)`,
          ).toMatch(/^custom\.atk-01\./);
        }
      }
    }
  });

  it('**a tag of the core vocabulary does not move** (**`cpu.usage` is not in the custom namespace**)', () => {
    const result = instantiatePack({
      source: loadBoardPack(GENERIC_DIR),
      targetId: 'atk-01',
      targetName: 'my board',
      outcomes: ALL_GREEN,
    });
    const tags = result.pack.readers.flatMap((r) => r.provides.map((p) => p.tag));
    expect(tags).toContain('cpu.usage');
    expect(tags).toContain('mem.total_bytes');
  });

  it('**a red reader is removed** (**the green ones stay, the red ones go**)', () => {
    const result = instantiatePack({
      source: loadBoardPack(GENERIC_DIR),
      targetId: 'atk-01',
      targetName: 'my board',
      outcomes: ALL_GREEN.map((o) => (o.readerId === 'led' ? outcome('led', false) : o)),
    });
    const ids = [...result.pack.readers, ...result.pack.custom].map((r) => r.id);
    expect(ids, 'a red reader may not stay').not.toContain('led');
    expect(ids).toContain('cpu');
  });

  it('**a removed reader may not stay in the poll group either** (**rule 17 would stop it**)', () => {
    const result = instantiatePack({
      source: loadBoardPack(GENERIC_DIR),
      targetId: 'atk-01',
      targetName: 'my board',
      outcomes: ALL_GREEN.map((o) => (o.readerId === 'led' ? outcome('led', false) : o)),
    });
    for (const group of result.pack.poll_groups) {
      for (const rid of group.readers) {
        expect(ids(result)).toContain(rid);
      }
    }
  });

  it('**the group became empty → the whole group is dropped** (**an empty group is a broken pack**)', () => {
    const result = instantiatePack({
      source: loadBoardPack(GENERIC_DIR),
      targetId: 'atk-01',
      targetName: 'my board',
      outcomes: ALL_GREEN.map((o) => (o.readerId === 'led' ? outcome('led', false) : o)),
    });
    const ledGroups = result.pack.poll_groups.filter((g) => g.readers.includes('led'));
    expect(ledGroups, 'only a red light is left in the group → the group is gone').toEqual([]);
  });
});

describe('the instantiation · **it has to leave a trace** (**"this pack is a guess"**)', () => {
  it('**`provenance.json` states where it came from**', () => {
    const result = instantiatePack({
      source: loadBoardPack(GENERIC_DIR),
      targetId: 'atk-01',
      targetName: 'my board',
      outcomes: ALL_GREEN,
      connection: { transport: 'serial', port: 'COM3', baudrate: 1500000 },
    });
    expect(result.provenance.source).toBe('generic-linux');
    expect(result.provenance.targetId).toBe('atk-01');
    expect(result.provenance.probedAt).toBeTruthy();
    expect(result.provenance.connection).toEqual({
      transport: 'serial',
      port: 'COM3',
      baudrate: 1500000,
    });
  });

  it('**the guessed entries are marked** (**the type_map of `thermal` is a guess**)', () => {
    const result = instantiatePack({
      source: loadBoardPack(GENERIC_DIR),
      targetId: 'atk-01',
      targetName: 'my board',
      outcomes: ALL_GREEN,
    });
    const guessed = result.provenance.guessed;
    expect(guessed.length, 'at least the entry "merging the thermal zones" is a guess').toBeGreaterThan(0);
    expect(guessed.every((g) => g.why.length > 0), 'every entry has to say why it is a guess').toBe(true);
  });

  it('**a red reader is recorded as well** (**"this board does not have it" is a fact as well**)', () => {
    const result = instantiatePack({
      source: loadBoardPack(GENERIC_DIR),
      targetId: 'atk-01',
      targetName: 'my board',
      outcomes: ALL_GREEN.map((o) => (o.readerId === 'led' ? outcome('led', false) : o)),
    });
    expect(result.provenance.missing.map((m) => m.readerId)).toContain('led');
  });
});

function ids(result: ReturnType<typeof instantiatePack>): string[] {
  return [...result.pack.readers, ...result.pack.custom].map((r) => r.id);
}
