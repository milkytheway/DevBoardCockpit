import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchPack, resolvePack } from '../../src/main/tags/binding';
import type { BoardPack } from '../../src/main/tags/schema';

/**
 * The binding between a board pack and a connection (contract
 * `docs/spec/02-board-pack.md` §10).
 *
 * The two things the contract asks for:
 *
 * | Contract | Here |
 * |---|---|
 * | "**the connection names a pack and the automatic recognition is the fallback**" | `boardPackId` is not empty → it is used; otherwise the model is read and the recognition decides |
 * | what if it cannot be recognised: **it does not guess**. It reports "this board has no board pack" | zero or several matches → `source: 'none'` + a reason |
 *
 * Why "it does not guess" matters so much:
 *
 * Contract §10: "this is important: **a board pack is an enhancement, not a
 * precondition.**" And a wrong guess means "binding `gpu.usage` to a board
 * without a GPU — **a gauge that is always 0**".
 *
 * **A gauge that is always 0 is more dangerous than no gauge** (the same
 * argument as fact G2): it looks real.
 */

/** A minimal but valid board pack */
function packYaml(id: string, models: string[]): string {
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
    'match:',
    '  mode: substring',
    `  models: [${models.join(', ')}]`,
    'poll_groups: []',
    'readers: []',
    'custom: []',
    'actions: []',
    '',
  ].join('\n');
}

/** Builds a temporary directory with a few packs in it */
function makePacksDir(packs: { dir: string; id: string; models: string[] }[]): string {
  const root = mkdtempSync(join(tmpdir(), 'packs-'));
  for (const p of packs) {
    const dir = join(root, p.dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'board.yaml'), packYaml(p.id, p.models), 'utf8');
  }
  return root;
}

/** A fake connection (it only records the commands, it does not run them) */
function fakeConnection(stdout = '') {
  const calls: string[] = [];
  return {
    calls,
    exec: async (command: string): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number; timedOut: boolean }> => {
      calls.push(command);
      return { exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false };
    },
  };
}

describe('matchPack · the match rules of contract §10', () => {
  const pack = (mode: 'exact' | 'substring', models: string[]): BoardPack => ({
    apiVersion: 'devboard/v1',
    kind: 'BoardPack',
    id: 'p',
    name: 'p',
    version: '1.0.0',
    requires: { transports: ['adb'], capabilities: ['exec'] },
    match: { mode, models },
    poll_groups: [],
    readers: [],
    custom: [],
    actions: [],
  });

  it('exact: **only a complete equality** counts', () => {
    const p = pack('exact', ['ATK-DLRK3588']);
    expect(matchPack(p, 'ATK-DLRK3588')).toBe(true);
    expect(matchPack(p, 'ATK-DLRK3588 Board')).toBe(false);
  });

  it('substring: **containing** any of the models counts', () => {
    const p = pack('substring', ['ATK-DLRK3588']);
    expect(matchPack(p, 'ATK-DLRK3588 Board')).toBe(true);
    expect(matchPack(p, 'something else')).toBe(false);
  });

  it('no match declared → no match', () => {
    const p = pack('substring', ['X']);
    delete p.match;
    expect(matchPack(p, 'X')).toBe(false);
  });

  it('the models are an empty list → no match (it does not guess)', () => {
    expect(matchPack(pack('substring', []), 'anything')).toBe(false);
  });
});

describe('resolvePack · the connection names a pack and the automatic recognition is the fallback', () => {
  it('the connection names a pack → it is used, **and the model is not read**', async () => {
    const dir = makePacksDir([{ dir: 'tiny', id: 'tiny', models: ['TINY'] }]);
    try {
      const conn = fakeConnection('SOME MODEL');
      let readModelCalled = false;

      const binding = await resolvePack({
        connection: conn,
        boardPackId: 'tiny',
        packsDir: dir,
        readModel: async () => {
          readModelCalled = true;
          return 'SOME MODEL';
        },
      });

      expect(binding.source).toBe('profile');
      expect(binding.pack?.id).toBe('tiny');
      expect(readModelCalled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the connection names none → **the model is read once**, a unique hit → the automatic recognition', async () => {
    const dir = makePacksDir([
      { dir: 'a', id: 'a', models: ['ATK-A'] },
      { dir: 'b', id: 'b', models: ['ATK-B'] },
    ]);
    try {
      let reads = 0;
      const binding = await resolvePack({
        connection: fakeConnection(),
        boardPackId: null,
        packsDir: dir,
        readModel: async () => {
          reads += 1;
          return 'ATK-A Board';
        },
      });

      expect(binding.source).toBe('auto');
      expect(binding.pack?.id).toBe('a');
      expect(reads).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the default way of reading the model: over the exec of the connection (it reads /proc/device-tree/model)', async () => {
    const dir = makePacksDir([{ dir: 'a', id: 'a', models: ['ATK-A'] }]);
    try {
      const conn = fakeConnection('ATK-A Board\n');
      const binding = await resolvePack({
        connection: conn,
        boardPackId: null,
        packsDir: dir,
      });

      expect(binding.source).toBe('auto');
      expect(binding.pack?.id).toBe('a');
      expect(conn.calls.length).toBe(1);
      expect(conn.calls[0]).toContain('/proc/device-tree/model');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('**no pack matches** → it does not guess: source none + a reason that is not empty', async () => {
    const dir = makePacksDir([{ dir: 'a', id: 'a', models: ['ATK-A'] }]);
    try {
      const binding = await resolvePack({
        connection: fakeConnection(),
        boardPackId: null,
        packsDir: dir,
        readModel: async () => 'SOMETHING ELSE',
      });

      expect(binding.source).toBe('none');
      expect(binding.pack).toBeNull();
      expect(binding.reason).toBeTruthy();
      expect(binding.reason).toContain('board pack');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('**several packs match** → it does not guess either, the reason says there are several candidates', async () => {
    const dir = makePacksDir([
      { dir: 'a', id: 'a', models: ['ATK'] },
      { dir: 'b', id: 'b', models: ['ATK'] },
    ]);
    try {
      const binding = await resolvePack({
        connection: fakeConnection(),
        boardPackId: null,
        packsDir: dir,
        readModel: async () => 'ATK-A Board',
      });

      expect(binding.source).toBe('none');
      expect(binding.pack).toBeNull();
      expect(binding.reason).toContain('several');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the connection names a pack that **does not exist** → it does not guess (source none + a reason)', async () => {
    const dir = makePacksDir([{ dir: 'a', id: 'a', models: ['ATK-A'] }]);
    try {
      const binding = await resolvePack({
        connection: fakeConnection(),
        boardPackId: 'nosuchpack',
        packsDir: dir,
      });

      expect(binding.source).toBe('none');
      expect(binding.reason).toContain('nosuchpack');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
