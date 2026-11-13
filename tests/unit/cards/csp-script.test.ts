import { describe, it, expect } from 'vitest';
import { cspScriptFor, cspScriptTag } from '../../../src/main/cards/csp-script';

/**
 * 卡片里的 **CSP 违规监听脚本**。
 *
 * ── 为什么要有它 ──
 *
 * 契约 `spec/03` §6.1：「浏览器的 CSP 违规会记在卡片运行时日志里，
 * agent 因此能看到『这张卡试图联网』」。
 *
 * **但宿主原来靠 `console-message` 抓，抓不到**（实测，Electron 34.5.8）：
 *
 * | 违规类型 | `console-message` 的 `sourceId` | 能不能归属到卡 |
 * |---|---|---|
 * | `img-src`（外链图片） | **有**（卡片的 URL） | 能 |
 * | `connect-src`（`fetch` 外网） | **空串** | **不能** |
 * | `script-src`（内联脚本） | **空串** | **不能** |
 *
 * 而「试图联网」正是 **`connect-src`** 那条——
 * **恰恰是宿主抓不到的那一类**。
 *
 * → 改用浏览器唯一的标准信号：**DOM 的 `securitypolicyviolation` 事件**。
 * 它**在违规发生的那张卡的文档里**触发（归属天然精确），
 * 而且带 `blockedURI` / `effectiveDirective` / `violatedDirective`——
 * agent 能直接看出「它想干什么」。
 *
 * ── 为什么是**经典脚本**而不是 module ──
 *
 * 监听必须**在卡片自己的脚本之前**就装上。
 * `type="module"` 的脚本是 defer 的 → 整个文档解析完才执行 →
 * 卡片在解析期做的违规（内联脚本、外链图片）会漏掉。
 * 经典脚本在解析时**同步执行** → 装得早 ✓。
 */
describe('CSP 违规监听脚本', () => {
  it('**监听 securitypolicyviolation**（浏览器唯一可靠的 CSP 违规信号）', () => {
    expect(cspScriptFor('inst-1')).toContain("addEventListener('securitypolicyviolation'");
  });

  it('报给宿主时带上 instanceId（归属的依据）', () => {
    const script = cspScriptFor('inst-1');
    expect(script).toContain('inst-1');
    expect(script).toContain('cockpit-csp');
  });

  it('把违规的关键字段都带上去（**agent 要知道它想干什么**）', () => {
    const script = cspScriptFor('inst-1');
    for (const field of [
      'blockedURI',
      'effectiveDirective',
      'violatedDirective',
      'sourceFile',
      'lineNumber',
      'sample',
    ]) {
      expect(script).toContain(field);
    }
  });

  it('注入的标签是**经典脚本**（不是 module）——要赶在卡片自己的脚本之前', () => {
    const tag = cspScriptTag('inst-1');
    expect(tag).toContain('src="cockpit://card/inst-1/__host/csp.js"');
    expect(tag).not.toContain('type="module"');
  });

  it('脚本里没有外部依赖（它跑在不透明源的 iframe 里，没有 Node、没有网络）', () => {
    const script = cspScriptFor('inst-1');
    expect(script).not.toMatch(/\brequire\s*\(/);
    expect(script).not.toMatch(/\bimport\s/);
  });
});
