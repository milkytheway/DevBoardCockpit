import { describe, it, expect } from 'vitest';
import { aliasVars } from '../../src/shared/theme/map';
import { xtermThemeFromVars } from '../../src/renderer/shell/theme';

/**
 * 「一处映射，四处产出」：应用 CSS / 卡片 theme.css / ECharts / xterm 必须
 * 说同一套颜色。xterm 画在 canvas 上、不解析 CSS 变量，所以这里是唯一
 * 容易悄悄漂移的一处。
 */

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
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

describe('主题 · 终端与别名层同源', () => {
  it('xterm 的背景/正文/强调/语义色直接取自别名层（两套皮肤）', () => {
    for (const skin of ['dark', 'light'] as const) {
      const vars = aliasVars(skin);
      const theme = xtermThemeFromVars(vars);
      expect(theme.background).toBe(vars['--cockpit-bg']);
      expect(theme.foreground).toBe(vars['--cockpit-text']);
      expect(theme.cursor).toBe(vars['--cockpit-accent']);
      expect(theme.green).toBe(vars['--cockpit-ok']);
      expect(theme.yellow).toBe(vars['--cockpit-warn']);
      expect(theme.red).toBe(vars['--cockpit-danger']);
      expect(theme.magenta).toBe(vars['--cockpit-accent-2']);
    }
  });

  it('两套皮肤的终端主题不一样（否则「换肤」在终端里是假的）', () => {
    const dark = xtermThemeFromVars(aliasVars('dark'));
    const light = xtermThemeFromVars(aliasVars('light'));
    expect(JSON.stringify(dark)).not.toBe(JSON.stringify(light));
  });
});

describe('主题 · 外壳视觉判据', () => {
  it('卡片内可聚焦控件的边框对卡面 ≥ 3:1（施工图 §8.2 第 10 条）', () => {
    // 卡面**从 token 取**，不写死色值。
    // （曾经写死 `#1E242C` —— 那个值在种子里**根本不存在**，
    //   是旧总纲留下的；写死的判据测的不是真实卡面。）
    for (const skin of ['dark', 'light'] as const) {
      const vars = aliasVars(skin);
      const cardSurface = vars['--cockpit-surface'] as string;
      const ratio = contrast(vars['--cockpit-border-strong'] as string, cardSurface);
      expect(ratio, `${skin} 的 border-strong 对卡面只有 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    }
  });

  it('正文与语义色对面板底 ≥ 4.5:1（施工图 §8.2 第 9 条）', () => {
    // 承载正文的面 = 卡面 = `--cockpit-surface`（从 token 取，不写死）
    const surface = {
      dark: aliasVars('dark')['--cockpit-surface'] as string,
      light: aliasVars('light')['--cockpit-surface'] as string,
    };
    const names = [
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
      for (const name of names) {
        const ratio = contrast(vars[name] as string, surface[skin]);
        expect(ratio, `${skin} 的 ${name} 只有 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
