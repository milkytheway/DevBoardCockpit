import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePack, listPacksIn } from '../../src/main/tags/binding';

/**
 * **The two directories of the board packs** (built-in + user) — added on
 * 2026-11-19.
 *
 * Why this had to be added (**it is a hole that already existed and that
 * nobody mentioned**):
 *
 * → **The state of things**: the runtime **reads only one directory** —
 *   `src/main/index.ts:210`, `packsDir: join(app.getAppPath(), 'profiles',
 *   'boards')` — and that is **always the one inside the asar**, so **nobody
 *   reads the board packs in the user data directory**.
 * → **The consequence**: **the pack the wizard instantiates is dead on
 *   arrival** (and its existence is the premise of the product of the wizard).
 * → And this is **not only a matter of the wizard**: **today** the operator
 *   could put a pack into the user data directory and **the runtime still
 *   would not read it** — a hole that already existed and that nobody
 *   mentioned.
 *
 * Which rule to follow (**of the three merging logics, the cleanest one**):
 *
 * | Thing | How it is merged | Source |
 * |---|---|---|
 * | **the connection profiles** | the built-in one first, the user one after — with the same id the user one overrides | `profiles/loader.ts` |
 * | **the workflow packs** | the one scanned later overrides the one scanned before (the user directory comes after) | `workflows/registry.ts` |
 * | **the cards** | `roots: CardRoot[]` (the built-in one first, the user one after) | `cards/wiring.ts` |
 * | **the board packs** | only the built-in one — **this is what has to be added** | —— |
 *
 * → **It is written like `profiles/loader.ts`** — that one is the cleanest
 *   (one `Map` and one `collect`).
 */
function packYaml(id: string, models: string[], extra = ''): string {
  return [
    'apiVersion: devboard/v1',
    'kind: BoardPack',
    `id: ${id}`,
    `name: ${id}`,
    'version: 1.0.0',
    'requires:',
    '  transports: [adb]',
    '  capabilities: [exec]',
    '  min_contract: devboard/v1',
    ...(models.length > 0
      ? ['match:', '  mode: substring', `  models: [${models.join(', ')}]`]
      : []),
    'poll_groups: []',
    'readers: []',
    'custom: []',
    'actions: []',
    extra,
    '',
  ].join('\n');
}

/** Builds a temporary directory with a few packs in it */
function makePacksDir(packs: { dir: string; id: string; models: string[]; extra?: string }[]): string {
  const root = mkdtempSync(join(tmpdir(), 'packs2-'));
  for (const p of packs) {
    const dir = join(root, p.dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'board.yaml'), packYaml(p.id, p.models, p.extra ?? ''), 'utf8');
  }
  return root;
}

/** A fake connection */
function fakeConnection(stdout = '') {
  return {
    exec: async () => ({
      exitCode: 0,
      stdout,
      stderr: '',
      durationMs: 1,
      timedOut: false,
    }),
  };
}

describe('the board packs · **the built-in and the user directory** (added on 2026-11-19)', () => {
  it('**a pack in the user directory can be fetched by name** (**the premise of a product of the wizard that is usable right away**)', async () => {
    const builtin = makePacksDir([{ dir: 'rk3588-atk', id: 'rk3588-atk', models: ['ATK'] }]);
    const user = makePacksDir([{ dir: 'atk-01', id: 'atk-01', models: ['ATK'] }]);
    try {
      const binding = await resolvePack({
        connection: fakeConnection('ATK-DLRK3588 Board'),
        boardPackId: 'atk-01',
        packsDir: builtin,
        userPacksDir: user,
      });
      expect(binding.source, 'naming a pack of the user directory').toBe('profile');
      expect(binding.pack?.id).toBe('atk-01');
    } finally {
      rmSync(builtin, { recursive: true, force: true });
      rmSync(user, { recursive: true, force: true });
    }
  });

  it('**a pack in the user directory is found by the automatic recognition as well** (**the route that reads the model**)', async () => {
    // **The built-in one does not match this model** — otherwise both would hit → **it does not guess** (that is contract §10)
    const builtin = makePacksDir([{ dir: 'rk3588-atk', id: 'rk3588-atk', models: ['OTHER-BOARD'] }]);
    const user = makePacksDir([{ dir: 'atk-01', id: 'atk-01', models: ['ATK-01'] }]);
    try {
      const binding = await resolvePack({
        connection: fakeConnection('ATK-01 Board'),
        boardPackId: null,
        packsDir: builtin,
        userPacksDir: user,
      });
      expect(binding.source).toBe('auto');
      expect(binding.pack?.id).toBe('atk-01');
    } finally {
      rmSync(builtin, { recursive: true, force: true });
      rmSync(user, { recursive: true, force: true });
    }
  });

  it('**with the same id the user one overrides the built-in one** (the same as in `profiles/loader.ts`)', async () => {
    const builtin = makePacksDir([{ dir: 'dup', id: 'dup', models: ['DUP'] }]);
    const user = makePacksDir([{ dir: 'dup', id: 'dup', models: ['DUP'] }]);
    try {
      const list = listPacksIn([builtin, user]);
      expect(list.filter((p) => p.id === 'dup').length, '**with the same id only one is kept**').toBe(1);
    } finally {
      rmSync(builtin, { recursive: true, force: true });
      rmSync(user, { recursive: true, force: true });
    }
  });

  it('**a pack without a match does not take part in the automatic recognition** (**the generic pack is like that**)', async () => {
    const builtin = makePacksDir([{ dir: 'generic-linux', id: 'generic-linux', models: [] }]);
    try {
      const binding = await resolvePack({
        connection: fakeConnection('ANY MODEL'),
        boardPackId: null,
        packsDir: builtin,
      });
      expect(binding.source, 'no match → it may not be claimed automatically').toBe('none');
    } finally {
      rmSync(builtin, { recursive: true, force: true });
    }
  });

  it('**naming a pack that does not exist → it says so** (**it does not guess**)', async () => {
    const builtin = makePacksDir([{ dir: 'rk3588-atk', id: 'rk3588-atk', models: ['ATK'] }]);
    try {
      const binding = await resolvePack({
        connection: fakeConnection('ATK'),
        boardPackId: 'nobody',
        packsDir: builtin,
      });
      expect(binding.source).toBe('none');
      expect(binding.reason).toContain('nobody');
    } finally {
      rmSync(builtin, { recursive: true, force: true });
    }
  });

  it('**the user directory does not exist → the built-in packs are unaffected** (**that is how it is on the first run**)', async () => {
    const builtin = makePacksDir([{ dir: 'rk3588-atk', id: 'rk3588-atk', models: ['ATK'] }]);
    try {
      const binding = await resolvePack({
        connection: fakeConnection('ATK-DLRK3588 Board'),
        boardPackId: null,
        packsDir: builtin,
        userPacksDir: join(tmpdir(), 'definitely-not-there-xyz'),
      });
      expect(binding.source).toBe('auto');
      expect(binding.pack?.id).toBe('rk3588-atk');
    } finally {
      rmSync(builtin, { recursive: true, force: true });
    }
  });

  it('**a broken pack does not drag the others down** (**one broken pack only skips one** — the same as the loader of the profiles)', () => {
    const builtin = makePacksDir([{ dir: 'good', id: 'good', models: ['G'] }]);
    const broken = join(builtin, 'broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'board.yaml'), 'this is: [not: valid: yaml', 'utf8');
    try {
      const list = listPacksIn([builtin]);
      expect(list.map((p) => p.id)).toEqual(['good']);
    } finally {
      rmSync(builtin, { recursive: true, force: true });
    }
  });
});
