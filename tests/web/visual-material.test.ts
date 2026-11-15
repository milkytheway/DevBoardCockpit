import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MATERIALS, materialVars } from '../../src/shared/theme/material';
import { themeCss, aliasVars } from '../../src/shared/theme/map';

/**
 * 材质层与色彩纪律的**机械判据**。
 *
 * ── 为什么要有这一组测试 ──
 *
 * 「不许乱用色彩」这句话，靠人记不住。
 * 过去 `visual.css` 里有 43 处硬编码色值，加进来、删掉、改值都没人管——
 * 因为**没有判据**。这一组测试就是那个判据。
 *
 * ── 规则（全部可机械判定） ──
 *
 * 1. **非生成产物的 CSS 里不许出现颜色字面量**
 *    （hex / rgb() / rgba() / hsl() / 颜色关键字）。
 *    颜色只有三个合法来源：`--cockpit-*`（语义）、`--shell-mat-*`（材质）、
 *    `color-mix()` 里当明暗调节用的白/黑。
 * 2. **颜色关键字只许出现在 `color-mix()` 里**
 *    ——`color: white` 那种「直接上色」是乱用的开始。
 * 3. **CSS 里用到的 `--shell-mat-*` 必须在材质层登记过**（不许有影子变量）。
 * 4. **材质层里不许有孤儿**（登记了却没人用 = 又一份真相）。
 * 5. **卡片拿不到材质层**（`--shell-mat-*` 是外壳专有）。
 * 6. **主题的产出方不许手写色值**（终端 / ECharts / 卡片基础样式）。
 */

const ROOT = process.cwd();

/** 生成产物：色值本来就该在这里（它由种子推导出来） */
const GENERATED = ['src/renderer/theme/tokens.generated.css'];

/** 参与检查的手写 CSS */
const HAND_WRITTEN = [
  'src/renderer/shell/shell.css',
  'src/renderer/shell/visual.css',
  'src/renderer/theme/app.css',
];

const CARD_CSS: string[] = [];
for (const name of readdirSync(join(ROOT, 'cards'))) {
  const p = join(ROOT, 'cards', name, 'style.css');
  try {
    if (statSync(p).isFile()) CARD_CSS.push(p);
  } catch {
    // 没有 style.css 的卡片目录，跳过
  }
}

/** 去掉注释 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 去掉 `color-mix(...)`（括号配对，允许嵌套） */
function stripColorMix(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const idx = css.indexOf('color-mix(', i);
    if (idx === -1) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, idx);
    let depth = 0;
    let j = idx + 'color-mix'.length;
    for (; j < css.length; j++) {
      if (css[j] === '(') depth++;
      else if (css[j] === ')') {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
    }
    i = j;
  }
  return out;
}

/** 一条 CSS 里所有「颜色字面量」的位置与文本 */
function colorLiterals(css: string): string[] {
  const stripped = stripComments(css);
  const outsideMix = stripColorMix(stripped);
  const hits: string[] = [];

  // hex：#rgb / #rgba / #rrggbb / #rrggbbaa
  for (const m of outsideMix.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    // 排除 id 选择器（`#root` 之类）：hex 必须正好 3/4/6/8 位
    const digits = m[0].slice(1);
    if (![3, 4, 6, 8].includes(digits.length)) continue;
    hits.push(m[0]);
  }
  // rgb / rgba / hsl / hsla / hwb
  for (const m of outsideMix.matchAll(/\b(?:rgba?|hsla?|hwb)\(/g)) hits.push(m[0]);

  // 颜色关键字：直接上色（white-space / tone-cyan / near-black 都不算）
  const KEYWORDS =
    /\b(white|black|red|green|blue|gray|grey|orange|yellow|purple|pink|cyan|magenta|silver|gold|navy|teal|lime|maroon|olive|aqua|fuchsia|indigo|violet|crimson|salmon|tomato|beige|ivory|khaki|salmon)\b(?![-\w])/gi;
  for (const m of outsideMix.matchAll(KEYWORDS)) {
    const before = outsideMix[m.index - 1] ?? '';
    if (before === '-' || /[\w-]/.test(before)) continue;
    hits.push(m[0]);
  }
  return hits;
}

describe('材质层 · 登记与引用闭环', () => {
  it('每条材质都有名字、族、状态、用途（没有"随手加的"）', () => {
    for (const m of MATERIALS) {
      expect(m.name, '材质名必须以 --shell-mat- 开头').toMatch(/^--shell-mat-[a-z0-9-]+$/);
      expect(['veil', 'edge', 'sheen', 'lift', 'canvas']).toContain(m.family);
      expect(['active', 'legacy']).toContain(m.status);
      expect(m.usage.length, `${m.name} 缺用途说明`).toBeGreaterThan(4);
      expect(m.dark.length).toBeGreaterThan(0);
      expect(m.light.length).toBeGreaterThan(0);
    }
  });

  it('材质名不重名', () => {
    const names = MATERIALS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('两套皮肤给的是**同一批**材质（少一条就是漏给浅色皮肤）', () => {
    const dark = Object.keys(materialVars('dark')).sort();
    const light = Object.keys(materialVars('light')).sort();
    expect(light).toEqual(dark);
  });

  it('材质层**不进卡片**（卡片只许拿契约别名）', () => {
    const cardCss = themeCss('dark', ':root');
    expect(cardCss).not.toContain('--shell-mat-');
    // 但应用外壳要拿得到
    expect(themeCss('dark', ':root', true)).toContain('--shell-mat-');
  });

  it('卡片的 theme.css 里连影子的材质变量都没有', () => {
    for (const name of MATERIALS.map((m) => m.name)) {
      expect(themeCss('dark', ':root')).not.toContain(name);
    }
  });

  it('**卡片实际注入**的 theme.css 没把材质层带进去', () => {
    // 接线处是最容易顺手加 `true` 的地方 —— 所以守住它。
    const src = readFileSync(join(ROOT, 'src/main/cards/wiring.ts'), 'utf8');
    expect(src).toContain("themeCss(theme(), ':root')");
    expect(src, '卡片注入的 theme.css 不许带材质层').not.toContain("themeCss(theme(), ':root', true)");
  });

  it('推送给卡片的变量是**别名层**，不是全量（含材质层）', () => {
    const src = readFileSync(join(ROOT, 'src/main/cards/wiring.ts'), 'utf8');
    expect(src).toContain('return aliasVars(theme);');
    expect(src, '推给卡片的变量不许来自 materialVars').not.toContain('materialVars');
  });

  it('生成的 CSS 里每一条材质都在（少一条 = 外壳少一块材质）', () => {
    const css = readFileSync(join(ROOT, 'src/renderer/theme/tokens.generated.css'), 'utf8');
    for (const m of MATERIALS) {
      expect(css, `生成的 CSS 缺 ${m.name}`).toContain(`${m.name}:`);
    }
  });
});

describe('材质层 · CSS 里不许再抄色值', () => {
  it('手写 CSS 里**一个颜色字面量都没有**', () => {
    for (const rel of HAND_WRITTEN) {
      const css = readFileSync(join(ROOT, rel), 'utf8');
      const hits = colorLiterals(css);
      expect(hits, `${rel} 里还有硬编码色值：${hits.join(', ')}`).toEqual([]);
    }
  });

  it('卡片的 CSS 里也**一个颜色字面量都没有**', () => {
    for (const abs of CARD_CSS) {
      const css = readFileSync(abs, 'utf8');
      const hits = colorLiterals(css);
      expect(hits, `${abs.replace(ROOT, '')} 里还有硬编码色值：${hits.join(', ')}`).toEqual([]);
    }
  });

  it('卡片不许用外壳专有的材质层', () => {
    for (const abs of CARD_CSS) {
      const css = readFileSync(abs, 'utf8');
      expect(css, `${abs.replace(ROOT, '')} 用了 --shell-mat-*`).not.toContain('--shell-mat-');
    }
  });

  it('生成产物之外的文件才是被检查的对象（生成产物里的色值来自种子）', () => {
    for (const rel of GENERATED) {
      expect(HAND_WRITTEN).not.toContain(rel);
    }
  });
});

describe('材质层 · 引用闭环（不许有影子变量与孤儿）', () => {
  const shellCss = HAND_WRITTEN.map((rel) => readFileSync(join(ROOT, rel), 'utf8')).join('\n');

  it('CSS 里用到的每个 --shell-mat-* 都在材质层登记过', () => {
    const used = new Set([...shellCss.matchAll(/var\((--shell-mat-[a-z0-9-]+)/g)].map((m) => m[1]));
    const known = new Set(MATERIALS.map((m) => m.name));
    for (const name of used) {
      expect(known.has(name), `CSS 用了没登记的材质 ${name}`).toBe(true);
    }
    expect(used.size, '一条材质都没被用到，说明这一层是空转').toBeGreaterThan(0);
  });

  it('材质层里没有孤儿（登记了却没人用 = 又一份真相）', () => {
    for (const m of MATERIALS) {
      expect(shellCss, `${m.name} 登记了但没人用`).toContain(`var(${m.name})`);
    }
  });

  it('材质层只有一个来源：CSS 里不许**重新定义** --shell-mat-*', () => {
    for (const rel of HAND_WRITTEN) {
      const css = readFileSync(join(ROOT, rel), 'utf8');
      expect(css, `${rel} 又定义了一遍材质变量`).not.toMatch(/--shell-mat-[a-z0-9-]+\s*:/);
    }
  });
});

describe('主题的产出方不许手写色值', () => {
  it('终端主题（shell/theme.ts）里没有颜色字面量', () => {
    const src = readFileSync(join(ROOT, 'src/renderer/shell/theme.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(code).not.toMatch(/\brgba?\(/);
  });

  it('终端组件（TerminalView.tsx）里没有颜色字面量', () => {
    const src = readFileSync(join(ROOT, 'src/renderer/terminal/TerminalView.tsx'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code, '终端组件不许自己存一套回落色（那是第二份真相）').not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('ECharts 主题（echarts-theme.ts）里没有颜色字面量', () => {
    const src = readFileSync(join(ROOT, 'src/shared/theme/echarts-theme.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(code).not.toMatch(/['"][#a-f0-9]{6}['"]/i);
  });

  it('宿主注入给卡片的基础样式里没有颜色字面量', () => {
    const src = readFileSync(join(ROOT, 'src/shared/theme/base-css.ts'), 'utf8');
    const code = src.replace(/`[\s\S]*?`/g, '');
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe('终端主题 · 单一来源', () => {
  it('终端的兜底色 == 种子的真值（不是另抄一份）', async () => {
    const { xtermThemeFromVars } = await import('../../src/renderer/shell/theme');
    const { SEEDS } = await import('../../src/shared/theme/seed');
    const theme = xtermThemeFromVars({});
    expect(theme.background).toBe(SEEDS.dark['bg-0']);
    expect(theme.foreground).toBe(SEEDS.dark['text-0']);
    expect(theme.cursor).toBe(SEEDS.dark['accent']);
    expect(theme.selectionBackground).toBe(SEEDS.dark['bg-3']);
    expect(theme.green).toBe(SEEDS.dark['ok']);
    expect(theme.red).toBe(SEEDS.dark['danger']);
    expect(theme.cyan).toBe(SEEDS.dark['series-5']);
  });

  it('别名层给的终端主题与兜底**一致**（两条路不许分叉）', async () => {
    const { xtermThemeFromVars } = await import('../../src/renderer/shell/theme');
    const fromVars = xtermThemeFromVars(aliasVars('dark'));
    const fromFallback = xtermThemeFromVars({});
    expect(fromVars.background).toBe(fromFallback.background);
    expect(fromVars.foreground).toBe(fromFallback.foreground);
    expect(fromVars.cursor).toBe(fromFallback.cursor);
  });
});