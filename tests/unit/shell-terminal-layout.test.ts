import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 外壳的**布局契约**：绝对定位的面板必须被**页面自己**框住。
 *
 * ── 这条为什么要有测试 ──
 *
 * 2026-11-14 的独立评审判出一条 Critical：
 * `.terminal__pane` 用 `position: absolute; inset: 0`，
 * 而它的祖先链里**一个定位祖先都没有** →
 * 包含块回落成**视口** → 终端面板**铺满整个窗口**，
 * 把状态栏、rail 与二级侧边栏全盖住 → **rail 点不动了**。
 *
 * **实测（Linux Electron + Xvfb）**：
 * 窗口 1200×773，而面板量出来是 **1200×773 @ (0,0)**，
 * 而它应该在页面区里（**866×705 @ (314,48)**）。
 *
 * jsdom **不算布局**，所以这里守的是**声明本身**：
 * 「终端页必须是定位祖先」——这一条没了，面板就会飞出去。
 */

const REPO = join(__dirname, '../..');
const CSS = readFileSync(join(REPO, 'src/renderer/shell/shell.css'), 'utf8');

/**
 * 取某个选择器的声明块。
 *
 * @returns 声明原文（`{ … }` 里的内容），没有就回空串。
 */
function declarationsFor(selector: string): string {
  // 找 `selector {` 到它的 `}`（CSS 里没有嵌套，花括号配平即可）
  const start = CSS.indexOf(`${selector} {`);
  if (start < 0) return '';
  const open = CSS.indexOf('{', start);
  const close = CSS.indexOf('}', open);
  if (close < 0) return '';
  return CSS.slice(open + 1, close);
}

describe('外壳 · 终端页的定位祖先', () => {
  it('终端页自己就是定位祖先（否则绝对定位的面板会铺满视口）', () => {
    const declarations = declarationsFor('.page--terminal');
    expect(declarations).not.toBe('');
    expect(declarations).toMatch(/position:\s*relative/);
  });

  it('终端面板是绝对定位的 —— 所以它**需要**一个定位祖先', () => {
    // 这条是前提：如果哪天面板不再绝对定位了，上面那条就可以放松
    const pane = declarationsFor('.terminal__pane');
    expect(pane).toMatch(/position:\s*absolute/);
    expect(pane).toMatch(/inset:\s*0/);
  });
});
