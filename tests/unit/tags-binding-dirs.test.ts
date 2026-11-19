import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePack, listPacksIn } from '../../src/main/tags/binding';

/**
 * **板型包的两个目录**（内置 + 用户）✓ —— 2026-11-19 加 ✓。
 *
 * ── 为什么这条要加（**它是一个已经存在、没人提的洞** ✓）──
 *
 * → **现状**：运行时**只读一个目录** ✓ —— `src/main/index.ts:210` ✓
 *   `packsDir: join(app.getAppPath(), 'profiles', 'boards')` ✓
 *   → **永远是 asar 里那个** ✓ → **用户数据目录里的板型包没有任何人读** ✗。
 * → **后果**：**向导实例化出来的包落地即废** ✗（向导产物的存在前提 ✓）。
 * → 而且这**不只是向导的事** ✓ —— **现在**用户自己往用户数据目录放一份包 ✓
 *   **运行时也读不到** ✓ → **一个已经存在、没人提的洞** ✓。
 *
 * ── 规矩照谁（**三套合并逻辑，挑最干净的那套** ✓）──
 *
 * | 东西 | 合并方式 | 出处 |
 * |---|---|---|
 * | **连接 profile** | ✅ **先内置，后用户 —— 同 id 时用户覆盖内置** ✓ | `profiles/loader.ts` ✓ |
 * | **流程包** | ✅ **后扫的覆盖先扫的** ✓（用户目录放后面 ✓） | `workflows/registry.ts` ✓ |
 * | **卡片** | ✅ `roots: CardRoot[]` ✓（内置在前 ✓ · 用户在后 ✓） | `cards/wiring.ts` ✓ |
 * | **板型包** | ⚠️ **只有内置** ✗ —— **本条要补上** ✓ | —— |
 *
 * → **照 `profiles/loader.ts` 那套写** ✓ —— 它最干净 ✓（一个 `Map` + 一个 `collect` ✓）。
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

/** 造一个装着几个包的临时目录 */
function makePacksDir(packs: { dir: string; id: string; models: string[]; extra?: string }[]): string {
  const root = mkdtempSync(join(tmpdir(), 'packs2-'));
  for (const p of packs) {
    const dir = join(root, p.dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'board.yaml'), packYaml(p.id, p.models, p.extra ?? ''), 'utf8');
  }
  return root;
}

/** 一个假的连接 */
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

describe('板型包 · **内置 + 用户两个目录**（2026-11-19 加 ✓）', () => {
  it('**用户目录里的包能被指名取到** ✓（**向导产物落地即用的前提** ✓）', async () => {
    const builtin = makePacksDir([{ dir: 'rk3588-atk', id: 'rk3588-atk', models: ['ATK'] }]);
    const user = makePacksDir([{ dir: 'atk-01', id: 'atk-01', models: ['ATK'] }]);
    try {
      const binding = await resolvePack({
        connection: fakeConnection('ATK-DLRK3588 Board'),
        boardPackId: 'atk-01',
        packsDir: builtin,
        userPacksDir: user,
      });
      expect(binding.source, '指名取用户目录里的包 ✓').toBe('profile');
      expect(binding.pack?.id).toBe('atk-01');
    } finally {
      rmSync(builtin, { recursive: true, force: true });
      rmSync(user, { recursive: true, force: true });
    }
  });

  it('**用户目录里的包能被自动识别到** ✓（**读型号那条路** ✓）', async () => {
    // **内置那份不匹配这个型号** ✓ —— 否则两个都命中 → **不猜** ✓（那是契约 §十 ✓）
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

  it('**同 id 时用户覆盖内置** ✓（与 `profiles/loader.ts` 同款 ✓）', async () => {
    const builtin = makePacksDir([{ dir: 'dup', id: 'dup', models: ['DUP'] }]);
    const user = makePacksDir([{ dir: 'dup', id: 'dup', models: ['DUP'] }]);
    try {
      const list = listPacksIn([builtin, user]);
      expect(list.filter((p) => p.id === 'dup').length, '**同 id 只留一个** ✓').toBe(1);
    } finally {
      rmSync(builtin, { recursive: true, force: true });
      rmSync(user, { recursive: true, force: true });
    }
  });

  it('**不写 match 的包不参与自动识别** ✓（**通用包就是这样** ✓）', async () => {
    const builtin = makePacksDir([{ dir: 'generic-linux', id: 'generic-linux', models: [] }]);
    try {
      const binding = await resolvePack({
        connection: fakeConnection('ANY MODEL'),
        boardPackId: null,
        packsDir: builtin,
      });
      expect(binding.source, '没有 match → 不该被自动认领 ✓').toBe('none');
    } finally {
      rmSync(builtin, { recursive: true, force: true });
    }
  });

  it('**指名不存在的包 → 说清楚** ✓（**不猜** ✓）', async () => {
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

  it('**用户目录不存在 → 不影响内置包** ✓（**第一次运行时就是这样** ✓）', async () => {
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

  it('**坏包不拖垮其余** ✓（**一个写坏的包只跳过一个** ✓ —— 与 profile 加载器同款 ✓）', () => {
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
