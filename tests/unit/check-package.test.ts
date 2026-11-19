/**
 * **打包产物自检里那道「包里的代码是不是最新的」的判据** ✓（2026-11-19 加 ✓）。
 *
 * ── 它防的是哪类 bug（**这一条是被真机事件打出来的** ✓）──
 *
 * → **2026-11-19**：用户把安装包装上了 ✓ → 我去看 ✓ → **包里跑的是修复之前的代码** ⚠️
 *   （安装包 **00:55** ✓ · 修复 **21:38** 提交的 ✓ → **包比修复早 21 小时** ⚠️）。
 * → **后果**：装机版里「凡是能写板子的卡」**永久显示「降级」** ⚠️
 *   → 而**开发期与沙箱里全绿** ✓ → **只有装上才看得见** ✓。
 * → **`check:package` 原来验不出这个** ⚠️ → 它验「卡在不在」✓
 *   → **验不出「代码是不是最新的」** ⚠️。
 *
 * ── 判据怎么定 ──
 *
 * → **asar 里的 `out/main/index.js` 与磁盘上的 `out/main/index.js` 逐字节相等** ✓
 *   （`npm run dist` 先 `electron-vite build` ✓ → **`out/` 是刚构建的** ✓
 *   → **两处不等 = 包是陈旧的** ✓）。
 * → **比的是字节** ✓ —— 不比时间戳 ✓（**时间戳会被 `cp` 改** ✓ → 不可靠 ✓）。
 */
import { describe, it, expect } from 'vitest';
import { compareCards, compareBundle } from '../../scripts/check-package';

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

describe('打包自检 · **包里的代码是不是最新的**（2026-11-19 加 ✓）', () => {
  it('**两边逐字节相等 → 通过** ✓', () => {
    const r = compareBundle(Buffer.from('same bytes'), Buffer.from('same bytes'));
    expect(r.ok).toBe(true);
  });

  it('**字节不同 → 不过** ✓（**包是陈旧的** ✓ —— 这正是 2026-11-19 装机版踩的那一个 ✓）', () => {
    const r = compareBundle(Buffer.from('old code'), Buffer.from('new code'));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('陈旧');
  });

  it('**磁盘上那份没有 → 不过** ✓（**不是「没有就跳过」** ✓ —— 那样等于没这条判据 ✓）', () => {
    const r = compareBundle(Buffer.from('code'), undefined);
    expect(r.ok).toBe(false);
  });

  it('**asar 里那份没有 → 不过** ✓（**包没带 main 产物** ✓）', () => {
    const r = compareBundle(undefined, Buffer.from('code'));
    expect(r.ok).toBe(false);
  });

  it('**两边都没有 → 不过** ✓（**不许「都缺 = 算了」** ✓）', () => {
    const r = compareBundle(undefined, undefined);
    expect(r.ok).toBe(false);
  });
});
