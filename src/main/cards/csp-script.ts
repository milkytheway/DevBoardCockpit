/**
 * 注入给卡片的 **CSP 违规监听脚本**。
 *
 * ── 为什么是它（而不是 `console-message`）──
 *
 * 宿主原来靠渲染进程的 `console-message` 事件抓 CSP 违规。**实测抓不全**：
 *
 * | 违规类型 | `console-message` 的 `sourceId`（Electron 34.5.8） | 能归属到卡吗 |
 * |---|---|---|
 * | `img-src`（外链图片） | 卡片的 URL | 能 |
 * | `connect-src`（`fetch` 外网） | **空串** | **不能** |
 * | `script-src`（内联脚本） | **空串** | **不能** |
 *
 * 而契约 `spec/03` §6.1 承诺的正是「agent 能看到**这张卡试图联网**」——
 * 「试图联网」就是 `connect-src` → **恰恰是宿主抓不到的那一类**。
 *
 * → 改用浏览器唯一的标准信号：**DOM 的 `securitypolicyviolation` 事件**。
 * 它**在违规发生的那张卡的文档里**触发 → 归属天然精确；
 * 而且带 `blockedURI` / `effectiveDirective` / `violatedDirective`，
 * agent 能直接看出「它想干什么」。
 *
 * ── 为什么是**经典脚本**（不是 module）──
 *
 * 监听必须**在卡片自己的脚本之前**装上。
 * `type="module"` 的脚本是 defer 的 → 整个文档解析完才执行 →
 * 卡片在**解析期**造成的违规（内联脚本、外链图片）会漏掉。
 * 经典脚本在解析时**同步执行** → 装得早 ✓。
 *
 * ── 它怎么报 ──
 *
 * 直接 `parent.postMessage`（**不经 bridge**）：
 * bridge 是 module → 装得太晚；而且这条消息**不是卡片 API**——
 * 卡片自己伪造一条也只能污染**它自己**的日志。
 */
export const CSP_SCRIPT_MARKER = '/* cockpit-csp:v1 */';

/**
 * 生成监听脚本。
 *
 * @param instanceId 这个实例的 id —— **归属的依据**
 */
export function cspScriptFor(instanceId: string): string {
  const id = JSON.stringify(instanceId);
  return `${CSP_SCRIPT_MARKER}
(function () {
  'use strict';
  var INSTANCE_ID = ${id};
  function report(detail) {
    try {
      parent.postMessage({ type: 'cockpit-csp', instanceId: INSTANCE_ID, detail: detail }, '*');
    } catch (err) {
      // 报不出去就算了——**不能因为报告失败把卡片搞崩**
    }
  }
  document.addEventListener('securitypolicyviolation', function (event) {
    report({
      blockedURI: String(event.blockedURI || ''),
      effectiveDirective: String(event.effectiveDirective || ''),
      violatedDirective: String(event.violatedDirective || ''),
      sourceFile: String(event.sourceFile || ''),
      lineNumber: Number(event.lineNumber || 0),
      sample: String(event.sample || '')
    });
  });
})();
`;
}

/**
 * 注入的标签。
 *
 * **不带 `type="module"`** —— 经典脚本在解析时同步执行，装得早。
 */
export function cspScriptTag(instanceId: string): string {
  const id = encodeURIComponent(instanceId);
  return `<script src="cockpit://card/${id}/__host/csp.js"></script>`;
}
