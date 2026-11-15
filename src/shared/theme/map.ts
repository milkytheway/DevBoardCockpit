import { ALIASES } from './alias';
import { materialVars } from './material';
import { GEOMETRY, SEEDS, type ThemeName } from './seed';

/**
 * 主题的**映射层**：种子 → 角色 → 别名。
 *
 * ── 为什么映射是纯函数 ──
 *
 * 因为它要**同时**产出四样东西，而它们**必须永远一致**：
 *
 * ```
 * 映射(seed) ──┬─→ 应用自己的 CSS 变量
 *             ├─→ 卡片注入的 <style>（__host/theme.css）
 *             ├─→ ECharts 主题 JSON（给卡片）
 *             └─→ xterm 的 theme 对象（终端）
 * ```
 *
 * 四处各维护一份 = 迟早对不上（终端和卡片颜色不一样，是这类产品最常见的破相）。
 * **一处映射，四处产出** = 换一次皮肤，全应用连着换 ✓。
 */

/** 角色 → 值（种子层直接给） */
export function roleVars(theme: ThemeName): Record<string, string> {
  return { ...SEEDS[theme], ...GEOMETRY };
}

/** 别名 → 值 */
export function aliasVars(theme: ThemeName): Record<string, string> {
  const roles = roleVars(theme);
  const out: Record<string, string> = {};
  for (const alias of ALIASES) {
    const value = roles[alias.role];
    if (value !== undefined) out[alias.name] = value;
  }
  // 几何与字号也进别名层（它们与皮肤无关，但组件要用同一个入口取）
  for (const [key, value] of Object.entries(GEOMETRY)) {
    const name = `--cockpit-${key}`;
    // **别名层说了算**（别名的定义更具体：比如 `--cockpit-radius` 指的是控件圆角）
    if (!(name in out)) out[name] = value;
  }
  return out;
}

/**
 * 生成 `:root{…}` 的 CSS 文本。
 *
 * @param selector 变量挂在谁身上（`:root` 或 `[data-theme='light']`）
 * @param includeMaterial 是否带上**材质层**（`--shell-mat-*`）。
 *
 *   ⚠️ **只有应用外壳要带，卡片不许带。**
 *
 *   材质层是外壳专有的（见 `material.ts`）。一旦卡片也能用 `--shell-mat-*`，
 *   它就会开始自己造第二套材质，「统一皮肤」当场就破。
 *   → 卡片注入的 `theme.css` 一律 `includeMaterial = false`。
 */
export function themeCss(theme: ThemeName, selector = ':root', includeMaterial = false): string {
  const vars = aliasVars(theme);
  if (includeMaterial) Object.assign(vars, materialVars(theme));
  const body = Object.entries(vars)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
  return `${selector} {\n${body}\n}\n`;
}

/** 两套皮肤的 CSS 文本（生成脚本用它落盘） */
export function allThemesCss(): string {
  return [
    '/* 本文件是**生成产物** —— 改它没有意义，改 `src/shared/theme/seed.ts`。 */',
    '/* 由 `npm run gen:theme` 生成；`npm run gen:theme:check` 守着它与种子一致。 */',
    '',
    themeCss('dark', ':root', true),
    themeCss('light', "[data-theme='light']", true),
  ].join('\n');
}
