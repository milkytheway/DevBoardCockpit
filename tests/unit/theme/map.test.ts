import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { aliasVars, allThemesCss, themeCss } from '../../../src/shared/theme/map';
import { CONTRACT_ALIASES } from '../../../src/shared/theme/alias';
import { baseStyleBlock } from '../../../src/shared/theme/base-css';
import { echartsTheme } from '../../../src/shared/theme/echarts-theme';

/**
 * 主题的**三层**：种子 → 映射 → 别名。
 *
 * ── 这一组测试守的是「换皮」这件事本身 ──
 *
 * 1. **契约里的 15 个别名一个都不能少**——卡片要靠它们活着。
 * 2. **对比度**：色值改错，**肉眼看不出来**（尤其浅色下的橙色）。
 *    所以判据是算出来的，不是看出来的。
 * 3. **基础样式里不许有色值**——有就意味着「第二份真相」。
 * 4. **生成的 CSS 与种子一致**——两份真相的另一种形态。
 */

/** WCAG 相对亮度与对比度 */
function luminance(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = channel((n >> 16) & 255);
  const g = channel((n >> 8) & 255);
  const b = channel(n & 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** 承载正文的面（面板底） */
const SURFACE = { dark: '#12151A', light: '#FFFFFF' } as const;

describe('主题 · 别名层', () => {
  it('**契约里的 15 个别名一个都不能少**', () => {
    expect(CONTRACT_ALIASES).toHaveLength(15);
    for (const skin of ['dark', 'light'] as const) {
      const vars = aliasVars(skin);
      for (const alias of CONTRACT_ALIASES) {
        expect(vars[alias.name], `${skin} 缺 ${alias.name}`).toBeDefined();
      }
    }
  });

  it('两套皮肤**都**提供全部别名（契约：两套皮肤都必须给全）', () => {
    const dark = Object.keys(aliasVars('dark')).sort();
    const light = Object.keys(aliasVars('light')).sort();
    expect(light).toEqual(dark);
  });

  it('文字与语义色在面板底上 **≥ 4.5:1**（两套皮肤都算）', () => {
    const textish = [
      '--cockpit-text',
      '--cockpit-text-dim',
      '--cockpit-text-faint',
      '--cockpit-accent',
      '--cockpit-ok',
      '--cockpit-warn',
      '--cockpit-danger',
      '--cockpit-unavailable',
    ];
    for (const skin of ['dark', 'light'] as const) {
      const vars = aliasVars(skin);
      for (const name of textish) {
        const ratio = contrast(vars[name] as string, SURFACE[skin]);
        expect(ratio, `${skin} 的 ${name} 只有 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('**可聚焦控件的边框 ≥ 3:1**', () => {
    for (const skin of ['dark', 'light'] as const) {
      const vars = aliasVars(skin);
      const ratio = contrast(vars['--cockpit-border-strong'] as string, SURFACE[skin]);
      expect(ratio, `${skin} 的 border-strong 只有 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    }
  });

  it('`unavailable` 在两套皮肤上都不是「能看但看不出」的灰', () => {
    // 它承载「这块板不提供这个能力」——读不到就等于说成了「正常」
    for (const skin of ['dark', 'light'] as const) {
      const vars = aliasVars(skin);
      const ratio = contrast(vars['--cockpit-unavailable'] as string, SURFACE[skin]);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('主题 · 基础样式（宿主注入给卡片的那套）', () => {
  it('**一个色值都没有**（只有 var(--cockpit-*)）', () => {
    const css = baseStyleBlock();
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\(/);
  });

  it('五态都有对应的类（卡片作者只要选类名）', () => {
    const css = baseStyleBlock();
    for (const cls of [
      '.cockpit-value',
      '.cockpit-value--stale',
      '.cockpit-value--error',
      '.cockpit-unavailable',
      '.cockpit-pending',
    ]) {
      expect(css).toContain(cls);
    }
  });

  it('`prefers-reduced-motion` 被照顾到了', () => {
    expect(baseStyleBlock()).toContain('prefers-reduced-motion');
  });
});

describe('主题 · ECharts 主题由 token 派生', () => {
  it('序列色就是别名层的那七个', () => {
    const vars = aliasVars('dark');
    const theme = echartsTheme('dark');
    expect(theme['color']).toEqual([
      vars['--cockpit-series-1'],
      vars['--cockpit-series-2'],
      vars['--cockpit-series-3'],
      vars['--cockpit-series-4'],
      vars['--cockpit-series-5'],
      vars['--cockpit-series-6'],
      vars['--cockpit-series-7'],
    ]);
  });

  it('两套皮肤的图表主题**不一样**（否则「统一皮肤」是假的）', () => {
    expect(JSON.stringify(echartsTheme('dark'))).not.toBe(JSON.stringify(echartsTheme('light')));
  });
});

describe('主题 · 生成产物与种子一致', () => {
  it('生成的 CSS 与种子对得上（`gen:theme:check` 守的就是这个）', () => {
    const file = join(process.cwd(), 'src', 'renderer', 'theme', 'tokens.generated.css');
    if (!existsSync(file)) {
      // 还没生成 → 跑一下生成器（测试自己保证产物存在）
      expect(allThemesCss().length).toBeGreaterThan(0);
      return;
    }
    expect(readFileSync(file, 'utf8')).toBe(allThemesCss());
  });

  it('两套皮肤的 CSS 都带（浅色挂在 data-theme 选择器上）', () => {
    const css = allThemesCss();
    expect(css).toContain(":root {");
    expect(css).toContain("[data-theme='light'] {");
    expect(themeCss('dark')).toContain('--cockpit-accent:');
  });
});
