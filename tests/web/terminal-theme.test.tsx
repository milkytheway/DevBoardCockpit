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
  const css = readFileSync(join(process.cwd(), 'src/renderer/theme/tokens.generated.css'), 'utf8');
  const view = readFileSync(
    join(process.cwd(), 'src/renderer/terminal/TerminalView.tsx'),
    'utf8',
  );
  // **主题值由外壳算好传进来**（`shell/theme.ts` 读 CSS 变量 → 解析后的具体色）
  const theme = readFileSync(join(process.cwd(), 'src/renderer/shell/theme.ts'), 'utf8');

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
    // **主题值的产出方**（外壳的 theme.ts）里不许出现 var(--…)
    expect(theme).not.toMatch(/var\(--/);
    // 终端组件只**接收**算好的颜色
    expect(view).toContain('theme');
    expect(view).toContain('options.theme');
  });

  it('主题值走 getComputedStyle 取解析后的值（**不是** token 名）', () => {
    expect(theme).toContain('getComputedStyle');
    // 终端组件自己也留了一份兜底（没传 theme 时）
    expect(view).toContain('getComputedStyle');
  });

  it('**换色是原地改 options.theme**，不重建终端（否则 scrollback 会丢）', () => {
    expect(view).toContain('options.theme');
  });
});
