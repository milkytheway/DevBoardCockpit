import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { outcomesOf } from '../../src/main/wizard/probe-adapter';
import { loadBoardPack } from '../../src/main/tags/pack';
import { validatePack, errorsOf } from '../../src/main/tags/validator';
import { instantiatePack } from '../../src/main/wizard/instantiate';
import type { ProbeReaderReport } from '../../src/main/tags/probe';

/**
 * **探针报告 → 实例化** ✓ —— 2026-11-19 加 ✓。
 *
 * ── 它是「真探针」与「实例化」之间**唯一**的桥 ✓ ──
 *
 * → **形状不一样** ✓ → **中间这一层是隔离带** ✓
 *   → **实例化不依赖探针** ✓（它是个纯函数 ✓）→ **探针改形状时它不动** ✓。
 */
const REPO_ROOT = resolve(process.cwd());
const GENERIC_DIR = join(REPO_ROOT, 'profiles', 'boards', 'generic-linux');

function report(readerId: string, ok: boolean, problems: string[] = []): ProbeReaderReport {
  return { readerId, kind: 'file_read', tags: [], problems, ok };
}

describe('探针 → 实例化 · **那座桥** ✓', () => {
  it('**绿/红原样过去** ✓', () => {
    const outcomes = outcomesOf([report('cpu', true), report('led', false, ['读不到'])]);
    expect(outcomes.map((o) => [o.readerId, o.ok])).toEqual([
      ['cpu', true],
      ['led', false],
    ]);
  });

  it('**「为什么红」合成一句话** ✓（**探针给的是一组问题** ✓）', () => {
    const one = outcomesOf([report('led', false, ['路径不对'])])[0];
    expect(one?.detail).toBe('路径不对');
    const many = outcomesOf([report('led', false, ['甲', '乙', '丙'])])[0];
    expect(many?.detail).toContain('3 problems');
    expect(many?.detail).toContain('甲');
  });

  it('**真探针的报告能直接喂进实例化** ✓（**端到端** ✓）', () => {
    // → **真的跑一遍探针的判定** ✓ —— 不手造报告 ✓
    const generic = loadBoardPack(GENERIC_DIR);
    const readerIds = [...generic.readers, ...generic.custom].map((r) => r.id);
    const reports = readerIds.map((id) => report(id, true));
    const result = instantiatePack({
      source: generic,
      targetId: 'atk-01',
      targetName: '我的板子',
      outcomes: outcomesOf(reports),
    });
    expect(
      errorsOf(validatePack(result.pack)).map((e) => `规则 ${e.rule} · ${e.path}：${e.message}`),
      '**真探针的报告喂进去 → 产物仍然过校验** ✓',
    ).toEqual([]);
  });
});
