import { describe, it, expect } from 'vitest';
import { compareCards } from '../../scripts/check-package';

/**
 * **打包产物自检里那道「内置卡」的判据** ✓。
 *
 * ── 为什么它必须能测 ──
 *
 * → 原判据是「**asar 里至少有一张卡**」✓ —— **它检不出陈旧的 asar** ✓
 *   （今天 `cards/` 有 10 张 ✓ · 旧 asar 里 6 张 ✓ → 「有卡」✓ **照样通过** ✗）。
 * → 而「装好的应用少了几张卡」**在开发期完全看不出来** ✓
 *   （`npm run build` 绿 ✓ · 测试全绿 ✓ · **只有装上才炸** ✓）。
 * → 所以判据必须是「**asar 里的卡与 `cards/` 一模一样**」✓ —— **这是能自动化的** ✓。
 *
 * ── 纯函数 ──
 *
 * → 比较本身与 asar 无关 ✓ → 单独拎出来 ✓ → **好测** ✓
 *   （`gen-vocabulary.ts` 同一个规矩 ✓ —— CLI 的逻辑与可测的逻辑分开 ✓）。
 */
describe('打包自检 · 内置卡', () => {
  it('**两边一模一样 → 通过** ✓', () => {
    const r = compareCards(['a', 'b'], ['a', 'b']);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.extra).toEqual([]);
  });

  it('**asar 少一张 → 不过** ✓（**陈旧的 asar** ✓ —— 这正是要抓的那一种 ✓）', () => {
    const r = compareCards(['a', 'b', 'c'], ['a', 'b']);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['c']);
    expect(r.extra).toEqual([]);
  });

  it('**asar 多一张 → 不过** ✓（**陈旧的 asar（老卡没删掉）** ✓）', () => {
    const r = compareCards(['a'], ['a', 'b']);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([]);
    expect(r.extra).toEqual(['b']);
  });

  it('**`cards/` 一张都没有 → 不过** ✓（**不是「0 张也算过」** ✓）', () => {
    expect(compareCards([], []).ok).toBe(false);
  });

  it('**顺序不同也算对** ✓（**比的是集合，不是顺序** ✓）', () => {
    expect(compareCards(['a', 'b'], ['b', 'a']).ok).toBe(true);
  });
});
