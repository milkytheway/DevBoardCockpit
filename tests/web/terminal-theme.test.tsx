import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 主题 token 的形状检查。
 *
 * xterm 用 canvas 画字，**canvas 不解析 CSS 变量**——
 * 直接把 `var(--cockpit-bg)` 传给 xterm 会静默失效，终端落在默认色上。
 * 所以实现里必须用 getComputedStyle 取解析后的值。
 *
 * 这个测试锁住两件事：
 * 1. tokens.css 里定义了契约要求的那几个 token（`docs/04` §6.5）
 * 2. 实现没有把 `var(--...)` 直接塞进 xterm 的 theme
 */
describe('终端主题', () => {
  const css = readFileSync(join(process.cwd(), 'src/renderer/theme/tokens.css'), 'utf8');
  const view = readFileSync(
    join(process.cwd(), 'src/renderer/terminal/TerminalView.tsx'),
    'utf8',
  );

  it('tokens.css 定义了契约要求的 token', () => {
    for (const token of [
      '--cockpit-bg',
      '--cockpit-bg-elevated',
      '--cockpit-text',
      '--cockpit-accent',
      '--cockpit-font-mono',
      '--cockpit-ok',
      '--cockpit-warn',
      '--cockpit-danger',
      '--cockpit-unavailable',
    ]) {
      expect(css).toContain(`${token}:`);
    }
  });

  it('xterm 的 theme 没有直接用 var(--...)（canvas 不解析 CSS 变量）', () => {
    const themeBlock = view.slice(view.indexOf('theme: {'), view.indexOf('theme: {') + 400);
    expect(themeBlock).not.toMatch(/'var\(/);
    expect(themeBlock).toContain('readToken(');
  });

  it('readToken 走 getComputedStyle 取解析后的值', () => {
    expect(view).toContain('getComputedStyle');
  });
});
