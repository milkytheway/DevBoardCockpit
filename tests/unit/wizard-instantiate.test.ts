import { describe, it, expect } from 'vitest';
import { join, resolve } from 'node:path';
import { loadBoardPack } from '../../src/main/tags/pack';
import { validatePack, errorsOf } from '../../src/main/tags/validator';
import { instantiatePack, type ProbeOutcome } from '../../src/main/wizard/instantiate';

/**
 * **实例化**：通用包（配方）→ 一块板的初版包 ✓ —— 2026-11-19 加 ✓。
 *
 * ── 它是什么 ──
 *
 * → **通用包在一块板子上试出来的结果** ✓ → **变成那块板的包** ✓。
 * → **打破了「先有包才能连板」的鸡生蛋** ✓（`docs/探索/02` §一·1.2 第③条 ✓）。
 *
 * ── ⚠️ **它必须改写 `custom.` 前缀**（**这是最容易漏的一步** ✓）──
 *
 * → **规则 1** ✓：`tag` 必须落在核心词表**或 `custom.<本包 id>.` 下** ✓
 *   （`isCustomTag(name, packId)` → `custom.${packId}.*` ✓）。
 * → 通用包的 id 是 `generic-linux` ✓ → **它的 tag 必然是 `custom.generic-linux.*`** ✓。
 * → **实例化出来的包 id 是 `atk-01`** ✓ → **那些 tag 原样带过去 → 规则 1 立刻拦** ⚠️
 *   → **落盘的包天生是非法的** ⚠️ → **向导的产物落地即废** ⚠️。
 * → **所以：实例化必须重写前缀** ✓ —— `custom.generic-linux.*` → `custom.atk-01.*` ✓。
 *
 * ── 它与现有包**同形** ✓ ──
 *
 * → `rk3588-atk` 那份包里的 `custom.rk3588-atk.*` ✓ → **同一个形状** ✓
 * → **所以产物白拿校验器** ✓ → **判据就是「它必须过真校验器」** ✓。
 */
const REPO_ROOT = resolve(process.cwd());
const GENERIC_DIR = join(REPO_ROOT, 'profiles', 'boards', 'generic-linux');

/** 一条探针结果 */
function outcome(
  readerId: string,
  ok: boolean,
  detail = '',
): ProbeOutcome {
  return { readerId, ok, detail, tags: ok ? [] : [] };
}

/** 通用包探出来的结果（**模拟**：大部分绿 ✓） */
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

describe('实例化 · **落盘的包必须过真校验器** ✓', () => {
  it('**全绿 → 实例化出的包 0 错误** ✓（**这是判据的本体** ✓）', () => {
    const result = instantiatePack({
      source: loadBoardPack(GENERIC_DIR),
      targetId: 'atk-01',
      targetName: '我的板子',
      outcomes: ALL_GREEN,
    });
    expect(
      errorsOf(validatePack(result.pack)).map((e) => `规则 ${e.rule} · ${e.path}：${e.message}`),
      '**实例化出的包必须过校验** ✓ —— 否则向导的产物落地即废 ⚠️',
    ).toEqual([]);
  });

  it('**`custom.` 前缀被改写成新包的 id** ✓（**规则 1 的必然要求** ✓）', () => {
    const result = instantiatePack({
      source: loadBoardPack(GENERIC_DIR),
      targetId: 'atk-01',
      targetName: '我的板子',
      outcomes: ALL_GREEN,
    });
    for (const reader of [...result.pack.readers, ...result.pack.custom]) {
      for (const p of reader.provides) {
        if (p.tag.startsWith('custom.')) {
          expect(
            p.tag,
            `tag「${p.tag}」还是通用包的命名空间 ✓ → **规则 1 会拦** ⚠️` +
              `（新包的 id 是 atk-01 ✓ → 应该是 custom.atk-01.* ✓）`,
          ).toMatch(/^custom\.atk-01\./);
        }
      }
    }
  });

  it('**核心词表里的 tag 不动** ✓（**`cpu.usage` 不是 custom 命名空间** ✓）', () => {
    const result = instantiatePack({
      source: loadBoardPack(GENERIC_DIR),
      targetId: 'atk-01',
      targetName: '我的板子',
      outcomes: ALL_GREEN,
    });
    const tags = result.pack.readers.flatMap((r) => r.provides.map((p) => p.tag));
    expect(tags).toContain('cpu.usage');
    expect(tags).toContain('mem.total_bytes');
  });

  it('**红的 reader 被删掉** ✓（**「绿的留、红的删」** ✓ —— `docs/探索/02` §四.1 ✓）', () => {
    const result = instantiatePack({
      source: loadBoardPack(GENERIC_DIR),
      targetId: 'atk-01',
      targetName: '我的板子',
      outcomes: ALL_GREEN.map((o) => (o.readerId === 'led' ? outcome('led', false) : o)),
    });
    const ids = [...result.pack.readers, ...result.pack.custom].map((r) => r.id);
    expect(ids, '红的 reader 不该留下 ✓').not.toContain('led');
    expect(ids).toContain('cpu');
  });

  it('**被删掉的 reader 也不该留在轮询组里** ✓（**规则 17 会拦** ✓）', () => {
    const result = instantiatePack({
      source: loadBoardPack(GENERIC_DIR),
      targetId: 'atk-01',
      targetName: '我的板子',
      outcomes: ALL_GREEN.map((o) => (o.readerId === 'led' ? outcome('led', false) : o)),
    });
    for (const group of result.pack.poll_groups) {
      for (const rid of group.readers) {
        expect(ids(result)).toContain(rid);
      }
    }
  });

  it('**组里空了 → 那个组整个去掉** ✓（**空组是坏包** ✓）', () => {
    const result = instantiatePack({
      source: loadBoardPack(GENERIC_DIR),
      targetId: 'atk-01',
      targetName: '我的板子',
      outcomes: ALL_GREEN.map((o) => (o.readerId === 'led' ? outcome('led', false) : o)),
    });
    const ledGroups = result.pack.poll_groups.filter((g) => g.readers.includes('led'));
    expect(ledGroups, '组里只剩红灯 → 那个组没了 ✓').toEqual([]);
  });
});

describe('实例化 · **它要留痕**（**「这份包是猜的」** ✓）', () => {
  it('**`provenance.json` 说得出它是怎么来的** ✓', () => {
    const result = instantiatePack({
      source: loadBoardPack(GENERIC_DIR),
      targetId: 'atk-01',
      targetName: '我的板子',
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

  it('**「猜的」那几条要标出来** ✓（**`thermal` 的 type_map 是猜的** ✓）', () => {
    const result = instantiatePack({
      source: loadBoardPack(GENERIC_DIR),
      targetId: 'atk-01',
      targetName: '我的板子',
      outcomes: ALL_GREEN,
    });
    const guessed = result.provenance.guessed;
    expect(guessed.length, '至少有「温区归并」这一条是猜的 ✓').toBeGreaterThan(0);
    expect(guessed.every((g) => g.why.length > 0), '每条都要说清为什么猜 ✓').toBe(true);
  });

  it('**红的 reader 也记一笔** ✓（**「这板没有」也是事实** ✓）', () => {
    const result = instantiatePack({
      source: loadBoardPack(GENERIC_DIR),
      targetId: 'atk-01',
      targetName: '我的板子',
      outcomes: ALL_GREEN.map((o) => (o.readerId === 'led' ? outcome('led', false) : o)),
    });
    expect(result.provenance.missing.map((m) => m.readerId)).toContain('led');
  });
});

function ids(result: ReturnType<typeof instantiatePack>): string[] {
  return [...result.pack.readers, ...result.pack.custom].map((r) => r.id);
}
