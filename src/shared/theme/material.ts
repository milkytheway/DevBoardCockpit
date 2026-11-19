/**
 * The material layer of the theme: the veils, the edge highlights, the
 * shadows and the canvas base.
 *
 * ── Why this layer exists ──
 *
 * The contract layer (`seed.ts` → `map.ts` → `alias.ts`) is about
 * semantics: "this colour means normal / means danger / means body text".
 *
 * But the shell needs another kind of colour, one that stands for no
 * semantics at all and only says "material": the reflection of a sheet of
 * glass, a 1px highlight along the top edge, the density of a shadow.
 * These colours used to be written straight into the CSS — `visual.css`
 * once carried 43 hard-coded values, so "changing the base colour meant
 * changing 43 places" and "nobody could tell which values were
 * deliberate and which were written by hand".
 *
 * → This layer registers them as tiers. Once they are registered:
 *   1. every colour value has a name, a description of its purpose and a
 *      family it belongs to;
 *   2. no colour literal appears in the CSS any more (guarded by
 *      `tests/web/visual-material.test.ts`);
 *   3. changing the skin means changing one place, and the whole
 *      application follows.
 *
 * ── Why the name is `--shell-mat-*` and not `--cockpit-*` ──
 *
 * `--cockpit-*` is the contract prefix: the dozen-odd names a card may
 * rely on. The material layer belongs to the shell alone — cards cannot
 * reach it and must not reach it: as soon as cards could use
 * `--cockpit-mat-*` as well, they would start building a second set of
 * materials of their own and the idea of one unified skin would fall apart
 * on the spot.
 * → The `--shell-mat-*` prefix puts the boundary into the name itself.
 *
 * ── One hard rule ──
 *
 * Not one of the values in here may be copied into the CSS a second
 * time. To use one, write `var(--shell-mat-*)`.
 *
 * ── The difference from `seed.ts` ──
 *
 * `seed.ts` is picked by hand (changing the skin means changing there).
 * This layer is registered (the shell uses it itself; it does not make the
 * work of the person changing the skin harder, but it is not written by
 * hand either). Both of them hold values only, never the way to use them.
 */

import type { ThemeName } from './seed';

/** The material family — it answers "what kind of colour is this" */
export type MaterialFamily =
  /** Veil: the translucent base laid UNDER the content */
  | 'veil'
  /** Edge: outlines, highlights along the top edge, hairlines */
  | 'edge'
  /** Sheen: the gradient layer on the face of a panel/card */
  | 'sheen'
  /** Lift: the shadows of something raised, pressed down or dragged */
  | 'lift'
  /** Canvas: the layer at the very bottom */
  | 'canvas';

/**
 * The state of a tier:
 * - `active` — the version in effect right now
 * - `legacy` — overridden by a later rule, but kept on purpose (removing it
 *   would risk a change in the looks, which outweighs the gain, and these
 *   are the evidence of the historical design: v0.6 → v0.7 iterated on the
 *   glass look three times)
 */
export type MaterialStatus = 'active' | 'legacy';

export interface MaterialDef {
  /** The CSS variable name (`--shell-mat-*`) */
  name: string;
  /** The value under the dark skin */
  dark: string;
  /** The value under the light skin (most of them are the same as under the dark one — a material is a "thickness", not a "colour") */
  light: string;
  /** The family */
  family: MaterialFamily;
  /** In effect right now / kept as history */
  status: MaterialStatus;
  /** What this material is for (for humans) */
  usage: string;
}

/**
 * The table of the material tiers.
 *
 * ⚠️ The values here are identical, character by character, with the
 * original ones in `visual.css` — this layer registers, it does not change
 * the design. The looks must not change by a single byte.
 */
export const MATERIALS: readonly MaterialDef[] = [
  // ── veil: the translucent base laid under the content ─────────
  {
    name: '--shell-mat-veil-code',
    dark: 'rgba(4, 6, 9, 0.5)',
    light: 'rgba(4, 6, 9, 0.5)',
    family: 'veil',
    status: 'legacy',
    usage: '原始读数（JSON）块的底 —— v0.6 规则，后续被 color-mix 版覆盖',
  },
  {
    name: '--shell-mat-veil-terminal',
    dark: 'rgba(6, 8, 11, 0.66)',
    light: 'rgba(6, 8, 11, 0.66)',
    family: 'veil',
    status: 'active',
    usage: '终端窗格的底 —— 终端要的是"沉进去"，不能和面板一样亮',
  },
  {
    name: '--shell-mat-veil-canvas',
    dark: 'radial-gradient(80% 60% at 40% 40%, rgba(255, 255, 255, 0.025), transparent 70%)',
    light: 'radial-gradient(80% 60% at 40% 40%, rgba(255, 255, 255, 0.025), transparent 70%)',
    family: 'veil',
    status: 'legacy',
    usage: '画布中央的一圈环境光 —— v0.6 glass pass',
  },

  // ── edge: outlines and highlights ─────────────────────────────
  {
    name: '--shell-mat-edge-highlight',
    dark: 'rgba(255, 255, 255, 0.06)',
    light: 'rgba(255, 255, 255, 1)',
    family: 'edge',
    status: 'active',
    usage: '面上沿那一道 1px 高光 —— 面板/卡片/窗格共用，是"这块是浮起来的"的主要信号',
  },
  {
    name: '--shell-mat-edge-bright',
    dark: 'rgba(255, 255, 255, 0.35)',
    light: 'rgba(255, 255, 255, 0.35)',
    family: 'edge',
    status: 'active',
    usage: '主按钮上沿的强高光 —— 主按钮是唯一允许"发光"的东西',
  },
  {
    name: '--shell-mat-edge-hairline',
    dark: 'rgba(255, 255, 255, 0.16)',
    light: 'rgba(255, 255, 255, 0.16)',
    family: 'edge',
    status: 'active',
    usage: '发丝线里掺的那一点白 —— 纯 border 太硬，掺白才有"金属细线"的感觉',
  },


  // ── sheen: the gradient highlight on a face ───────────────────
  {
    name: '--shell-mat-sheen-card',
    dark: 'linear-gradient(180deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.025) 46%)',
    light: 'linear-gradient(180deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.025) 46%)',
    family: 'sheen',
    status: 'active',
    usage: '玻璃卡片面的渐变高光 —— v0.7 生效值',
  },
  {
    name: '--shell-mat-sheen-card-v2',
    dark: 'linear-gradient(180deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.02) 48%)',
    light: 'linear-gradient(180deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.02) 48%)',
    family: 'sheen',
    status: 'legacy',
    usage: '玻璃卡片面高光 —— v0.7 第一遍，被后一遍覆盖',
  },
  {
    name: '--shell-mat-sheen-card-v1',
    dark: 'linear-gradient(180deg, rgba(255, 255, 255, 0.075), rgba(255, 255, 255, 0.012) 46%)',
    light: 'linear-gradient(180deg, rgba(255, 255, 255, 0.075), rgba(255, 255, 255, 0.012) 46%)',
    family: 'sheen',
    status: 'legacy',
    usage: '玻璃卡片面高光 —— v0.6',
  },
  {
    name: '--shell-mat-pure-white',
    dark: '#ffffff',
    light: '#ffffff',
    family: 'sheen',
    status: 'active',
    usage: '浅色皮肤上的纯白 —— 浮层底、渐变起点',
  },

  // ── canvas: the layer at the very bottom ─────────────────────
  {
    name: '--shell-mat-canvas',
    dark: '#06080b',
    light: '#F5F6F7',
    family: 'canvas',
    status: 'active',
    usage: '玻璃画布的底 —— 深色比 --cockpit-bg 更黑让浮层浮起来；浅色用暖灰底衬托浮层',
  },
  {
    name: '--shell-mat-canvas-v1',
    dark: '#07090c',
    light: '#EEF0F2',
    family: 'canvas',
    status: 'legacy',
    usage: '玻璃画布的底 —— v0.7 第一遍',
  },

  // ── lift: shadows ────────────────────────────────────────────
  {
    name: '--shell-mat-shadow-card',
    dark: '0 18px 36px -26px rgba(0, 0, 0, 0.9), 0 2px 6px -3px rgba(0, 0, 0, 0.4)',
    light: '0 10px 26px -20px rgba(23, 30, 40, 0.28), 0 1px 2px -1px rgba(23, 30, 40, 0.14)',
    family: 'lift',
    status: 'active',
    usage: '面板与窗格的常规投影 —— 浅色皮肤用带色相的冷灰，不用纯黑',
  },
  {
    name: '--shell-mat-shadow-float',
    dark: '0 24px 60px -30px rgba(0, 0, 0, 0.95)',
    light: '0 24px 60px -30px rgba(23, 30, 40, 0.3)',
    family: 'lift',
    status: 'active',
    usage: '浮层（调色板 / 卡片菜单）的投影 —— 比常规投影更远更淡',
  },
  {
    name: '--shell-mat-shadow-glass',
    dark:
      '0 34px 66px -32px rgba(0, 0, 0, 0.98), 0 10px 26px -14px rgba(0, 0, 0, 0.62), inset 0 1px 0 rgba(255, 255, 255, 0.12)',
    light:
      '0 34px 66px -32px rgba(0, 0, 0, 0.98), 0 10px 26px -14px rgba(0, 0, 0, 0.62), inset 0 1px 0 rgba(255, 255, 255, 0.12)',
    family: 'lift',
    status: 'active',
    usage: '玻璃卡片的投影 —— v0.7 生效值（远投影 + 近投影 + 内嵌上沿高光）',
  },
  {
    name: '--shell-mat-shadow-glass-hover',
    dark:
      '0 44px 86px -34px rgba(0, 0, 0, 1), 0 14px 34px -16px rgba(0, 0, 0, 0.7), inset 0 1px 0 rgba(255, 255, 255, 0.16)',
    light:
      '0 44px 86px -34px rgba(0, 0, 0, 1), 0 14px 34px -16px rgba(0, 0, 0, 0.7), inset 0 1px 0 rgba(255, 255, 255, 0.16)',
    family: 'lift',
    status: 'active',
    usage: '玻璃卡片悬停时的投影 —— 比常态更大更黑',
  },
  {
    name: '--shell-mat-shadow-glass-v1',
    dark:
      '0 28px 56px -30px rgba(0, 0, 0, 0.95), 0 6px 18px -10px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.09)',
    light:
      '0 28px 56px -30px rgba(0, 0, 0, 0.95), 0 6px 18px -10px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.09)',
    family: 'lift',
    status: 'legacy',
    usage: '玻璃卡片投影 —— v0.6 glass pass',
  },
  {
    name: '--shell-mat-shadow-glass-hover-v1',
    dark:
      '0 34px 64px -30px rgba(0, 0, 0, 0.98), 0 10px 24px -12px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.12)',
    light:
      '0 34px 64px -30px rgba(0, 0, 0, 0.98), 0 10px 24px -12px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.12)',
    family: 'lift',
    status: 'legacy',
    usage: '玻璃卡片悬停投影 —— v0.6 glass pass',
  },
  {
    name: '--shell-mat-shadow-detail',
    dark: '-24px 0 48px rgba(0, 0, 0, 0.42)',
    light: '-24px 0 48px rgba(30, 40, 55, 0.16)',
    family: 'lift',
    status: 'active',
    usage: '详情栏的投影 —— 只有左侧一道（它是覆盖式浮层，右侧没有边界）',
  },
  {
    name: '--shell-mat-shadow-detail-v1',
    dark: '-20px 0 40px -32px rgba(0, 0, 0, 0.9)',
    light: '-20px 0 40px -32px rgba(0, 0, 0, 0.9)',
    family: 'lift',
    status: 'legacy',
    usage: '详情栏早期投影 —— 被后来的 .detail 规则覆盖',
  },
  {
    name: '--shell-mat-shadow-active',
    dark: '0 6px 16px -12px rgba(0, 0, 0, 0.8)',
    light: '0 6px 16px -12px rgba(0, 0, 0, 0.8)',
    family: 'lift',
    status: 'active',
    usage: '侧栏选中项的投影 —— 选中项是"抬起来"的，不是"换了颜色"',
  },
  {
    name: '--shell-mat-shadow-lift',
    dark: '0 30px 60px -26px rgba(0, 0, 0, 0.9)',
    light: '0 30px 60px -26px rgba(0, 0, 0, 0.9)',
    family: 'lift',
    status: 'active',
    usage: '拖拽中的卡片被抬起时的投影',
  },
  {
    name: '--shell-mat-shadow-hover-v1',
    dark: '0 22px 44px -24px rgba(0, 0, 0, 0.95)',
    light: '0 22px 44px -24px rgba(0, 0, 0, 0.95)',
    family: 'lift',
    status: 'legacy',
    usage: '卡片悬停投影 —— v0.6，被玻璃版覆盖',
  },
  {
    name: '--shell-mat-shadow-selected',
    dark: '0 24px 48px -26px rgba(0, 0, 0, 0.95)',
    light: '0 24px 48px -26px rgba(0, 0, 0, 0.95)',
    family: 'lift',
    status: 'active',
    usage: '选中卡片的投影 —— 选中是"被拿起来看"，不是"亮了"',
  },
];

/** Material variable name → the value under that skin */
export function materialVars(theme: ThemeName): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of MATERIALS) {
    out[m.name] = theme === 'light' ? m.light : m.dark;
  }
  return out;
}

/** Every name of the material layer */
export const MATERIAL_NAMES: readonly string[] = MATERIALS.map((m) => m.name);