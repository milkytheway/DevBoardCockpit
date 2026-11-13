import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchPack, resolvePack } from '../../src/main/tags/binding';
import type { BoardPack } from '../../src/main/tags/schema';

/**
 * 板型包 ↔ 连接的绑定（契约 `docs/spec/02-board-pack.md` §十）。
 *
 * ── 契约要的两件事 ──
 *
 * | 契约 | 这里 |
 * |---|---|
 * | 「**连接里指名 + 自动识别兜底**」 | `boardPackId` 非空 → 用它；否则读型号自动识别 |
 * | 「认不出来怎么办：**不猜**。报『这块板没有板型包』」 | 零个或多个匹配 → `source: 'none'` + reason |
 *
 * ── 为什么「不猜」这么要紧 ──
 *
 * 契约 §十：「这条很重要：**板型包是增强，不是前提。**」而猜错的后果是
 * 「把 \`gpu.usage\` 绑到一块没有 GPU 的板上——**一个恒为 0 的仪表**」。
 *
 * **恒为 0 的仪表比没有仪表更危险**（事实 G2 的同一条道理）：
 * 它看起来是真的。
 */

/** 一个最小但合法的板型包 */
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

/** 造一个装着几个包的临时目录 */
function makePacksDir(packs: { dir: string; id: string; models: string[] }[]): string {
  const root = mkdtempSync(join(tmpdir(), 'packs-'));
  for (const p of packs) {
    const dir = join(root, p.dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'board.yaml'), packYaml(p.id, p.models), 'utf8');
  }
  return root;
}

/** 一个假的连接（只记命令，不真跑） */
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

describe('matchPack · 契约 §十 的 match 规则', () => {
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

  it('exact：**完全相等**才算', () => {
    const p = pack('exact', ['ATK-DLRK3588']);
    expect(matchPack(p, 'ATK-DLRK3588')).toBe(true);
    expect(matchPack(p, 'ATK-DLRK3588 Board')).toBe(false);
  });

  it('substring：**包含**任一 models 就算', () => {
    const p = pack('substring', ['ATK-DLRK3588']);
    expect(matchPack(p, 'ATK-DLRK3588 Board')).toBe(true);
    expect(matchPack(p, 'something else')).toBe(false);
  });

  it('没有 match 声明 → 不匹配', () => {
    const p = pack('substring', ['X']);
    delete p.match;
    expect(matchPack(p, 'X')).toBe(false);
  });

  it('models 是空列表 → 不匹配（不猜）', () => {
    expect(matchPack(pack('substring', []), 'anything')).toBe(false);
  });
});

describe('resolvePack · 连接指名 + 自动识别兜底', () => {
  it('连接指名了包 → 用它，**且不去读型号**', async () => {
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

  it('连接没指名 → **读一次型号**，唯一命中 → 自动识别', async () => {
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

  it('默认的读型号方式：走连接的 exec（读 /proc/device-tree/model）', async () => {
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

  it('**没有包匹配** → 不猜：source none + reason 非空', async () => {
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
      expect(binding.reason).toContain('板型包');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('**多个包都匹配** → 同样不猜，reason 说明有多个候选', async () => {
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
      expect(binding.reason).toContain('多个');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('连接指名了一个**不存在的**包 → 不猜（source none + reason）', async () => {
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
