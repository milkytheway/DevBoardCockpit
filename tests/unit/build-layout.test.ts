import { describe, it, expect } from 'vitest';
import {
  PRELOAD_ENTRY,
  PRELOAD_FILE,
  PRELOAD_FORMAT,
  preloadEntryName,
} from '../../src/shared/build-layout';

/**
 * preload 产物的命名契约。
 *
 * 这条契约的代价是**一整条静默失败链**：
 *
 *   main 指 `../preload/index.js`
 *     → 构建实际产出 `index.mjs`（因为 package.json 是 `"type": "module"`）
 *       → preload 加载失败，`window.cockpit` 是 undefined
 *         → renderer 一个 API 都没有，界面永远停在「选一个连接开始」
 *
 * 链上每一环在开发期都「正常」：构建成功、类型检查通过、测试全绿。
 * 只有真的把窗口打开才暴露。所以它必须由**机器**守住，不是靠人记得。
 *
 * 守它的两道：
 * 1. 这里——命名对得上，且格式必须是 CJS（沙箱 preload 跑不了 ESM）。
 * 2. `scripts/check-build.ts`——构建完验产物真的在、真的是 CJS。
 */
describe('preload 产物的命名', () => {
  it('构建产物的文件名与 main 引用的文件名是同一个', () => {
    expect(preloadEntryName('index')).toBe(PRELOAD_FILE);
  });

  it('preload 必须构建成 CommonJS——沙箱 preload 跑不了 ESM', () => {
    // ESM preload 需要 `sandbox: false`，那等于关掉渲染进程的沙箱。
    // 而渲染进程里要装不可信的卡片，沙箱是最后一道防线。
    expect(PRELOAD_FORMAT).toBe('cjs');
  });

  it('产物用 .cjs 后缀——`.cjs` 在任何情况下都是 CommonJS', () => {
    // `.js` 的语义取决于最近的 package.json 的 `type`；
    // `.cjs` 不管走到哪里都是 CommonJS。
    expect(PRELOAD_ENTRY.endsWith('.cjs')).toBe(true);
    expect(PRELOAD_FILE.endsWith('.cjs')).toBe(true);
  });
});
