/**
 * 主题的**材质层**：遮罩、边缘高光、投影、画布底。
 *
 * ── 为什么要有这一层 ──
 *
 * 契约层（`seed.ts` → `map.ts` → `alias.ts`）管的是**语义**：
 * 「这块颜色代表正常 / 代表危险 / 代表正文」。
 *
 * 但外壳还需要另一类颜色，它们**不代表任何语义**，只表示「材质」：
 * 一层玻璃的反光、一道 1px 的上沿高光、一片投影的浓淡。
 * 这类颜色过去是**直接写在 CSS 里的**——`visual.css` 一度有 43 处硬编码，
 * 于是「换个底色要改 43 个地方」，也「没人说得清哪些是刻意的、哪些是随手写的」。
 *
 * → 这一层把它们**登记成档位**。登记之后：
 *   1. 所有色值有名字、有用途说明、有归属族；
 *   2. CSS 里不再出现任何色值字面量（由 `tests/web/visual-material.test.ts` 守着）；
 *   3. 换肤时改一处，全应用跟着变。
 *
 * ── 命名为什么是 `--shell-mat-*` 而不是 `--cockpit-*` ──
 *
 * `--cockpit-*` 是**契约前缀**：卡片能依赖的那十几个。
 * 材质层是**外壳专有**的——卡片拿不到，也**不该**拿到：
 * 一旦卡片也能用 `--cockpit-mat-*`，它就会开始自己造第二套材质，
 * 「统一皮肤」当场就破。
 * → 用 `--shell-mat-*` 让边界在名字上就写着。
 *
 * ── 一条硬规矩 ──
 *
 * **这里面的值一个都不许在 CSS 里再抄一遍。**
 * 要用就 `var(--shell-mat-*)`。
 *
 * ── 与 `seed.ts` 的区别 ──
 *
 * `seed.ts` 是**手挑的**（换皮改那里）。
 * 这一层是**登记的**（外壳自己用，不给换皮的人添麻烦，但也不是随手写的）。
 * 两者都只放「值」，不放「怎么用」。
 */

import type { ThemeName } from './seed';

/** 材质族——用来回答「这是什么性质的颜色」 */
export type MaterialFamily =
  /** 遮罩：叠在内容**下面**的半透明底 */
  | 'veil'
  /** 边缘：描边、上沿高光、发丝线 */
  | 'edge'
  /** 面光：面板/卡片面上的那一层渐变 */
  | 'sheen'
  /** 投影：浮起、压下、拖拽 */
  | 'lift'
  /** 画布：最底下那一层 */
  | 'canvas';

/**
 * 档位状态：
 * - `active` —— 当前生效的那一版
 * - `legacy` —— 被后面的规则覆盖了，但**留着**（删掉会改动观感的风险大于收益，
 *   而且它们是历史设计的证据：v0.6 → v0.7 迭代了三次玻璃质感）
 */
export type MaterialStatus = 'active' | 'legacy';

export interface MaterialDef {
  /** CSS 变量名（`--shell-mat-*`） */
  name: string;
  /** 暗色皮肤下的值 */
  dark: string;
  /** 浅色皮肤下的值（绝大多数与暗色相同——材质是"厚薄"，不是"颜色"） */
  light: string;
  /** 族 */
  family: MaterialFamily;
  /** 当前生效 / 历史留档 */
  status: MaterialStatus;
  /** 这条材质干什么用的（人看） */
  usage: string;
}

/**
 * 材质档位表。
 *
 * ⚠️ **这里的值与 `visual.css` 里的原值逐字相同**——
 * 这一层是**登记**，不是**改设计**。观感必须一字节不变。
 */
export const MATERIALS: readonly MaterialDef[] = [
  // ── veil：叠在内容下面的半透明底 ───────────────────────────────
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

  // ── edge：描边与高光 ─────────────────────────────────────────
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


  // ── sheen：面上的渐变高光 ────────────────────────────────────
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

  // ── canvas：最底下那一层 ─────────────────────────────────────
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

  // ── lift：投影 ───────────────────────────────────────────────
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

/** 材质变量名 → 该皮肤下的值 */
export function materialVars(theme: ThemeName): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of MATERIALS) {
    out[m.name] = theme === 'light' ? m.light : m.dark;
  }
  return out;
}

/** 材质层里的所有名字 */
export const MATERIAL_NAMES: readonly string[] = MATERIALS.map((m) => m.name);