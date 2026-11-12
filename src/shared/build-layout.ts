/**
 * 构建产物的**布局契约**。
 *
 * main 写死的 preload 路径、electron-vite 生成的 preload 文件名、
 * 以及构建自检脚本，三处必须说同一件事。
 * 所以它们不各自写死字符串——都从这里取。
 *
 * **为什么要 CJS（`.cjs`）而不是 ESM（`.mjs`）**：
 * Electron 的沙箱 preload 只跑 CommonJS（`docs/04` §9.0 的进程与安全基线）。
 * ESM preload 需要 `sandbox: false`，那等于关掉渲染进程的沙箱——
 * 而本工程要在渲染进程里装载**不可信的卡片**（契约 §6.1 的 CSP 断网），
 * 沙箱是最后一道防线，不能为了省事关掉。
 * （依据：Electron 官方文档「Sandboxed preload scripts can't use ESM imports」
 * 与「ESM preload scripts must have the .mjs extension」。）
 */

/** preload 的构建格式。沙箱 preload 只能是 CommonJS。 */
export const PRELOAD_FORMAT = 'cjs' as const;

/** rollup 的 entryFileNames：构建产物叫 `[name].cjs` */
export const PRELOAD_ENTRY = '[name].cjs';

/** 构建产物目录里的实际文件名 */
export const PRELOAD_FILE = 'index.cjs';

/** 两条约定必须对得上：`[name]` 换成入口名就是文件名 */
export function preloadEntryName(entryName: string): string {
  return PRELOAD_ENTRY.replace('[name]', entryName);
}
