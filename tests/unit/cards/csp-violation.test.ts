import { describe, it, expect } from 'vitest';
import { cspViolationFrom } from '../../../src/main/cards/csp-violation';

/**
 * CSP 违规的**识别**。
 *
 * ── 为什么单独一个模块 ──
 *
 * Electron 的 `console-message` 事件签名**换过**：
 *
 * | 版本 | 签名 |
 * |---|---|
 * | < 25 | `(event, level, message, line, sourceId)` |
 * | 25+（`ServiceWorkers`） | `(event, messageDetails)` |
 * | **34（`WebContents`，本工程在用）** | **`(event, level, message, line, sourceId)`** |
 *
 * `MessageDetails` 那个形**只属于 `ServiceWorkers`**——
 * 拿它去读 `WebContents` 的事件参数，读到的是**一个数字**（level），
 * `source` 恒为 `undefined` → **每一条违规都在第一道门就被丢掉**。
 *
 * → 所以识别逻辑必须**独立成纯函数**，并且用**真的参数形状**测。
 */
describe('CSP 违规的识别（Electron 34 的真参数形状）', () => {
  it('Electron 34 的参数是 (level, message, line, sourceId) —— 违规要被认出来', () => {
    const got = cspViolationFrom(
      3,
      "Refused to connect to 'https://evil.example/' because it violates the following " +
        "Content Security Policy directive: \"connect-src 'none'\". ",
      'cockpit://card/inst-1/index.html',
    );
    expect(got).not.toBeNull();
    expect(got?.message).toContain('Content Security Policy');
    expect(got?.sourceUrl).toBe('cockpit://card/inst-1/index.html');
  });

  it('普通日志**不是** CSP 违规', () => {
    expect(cspViolationFrom(1, 'hello world', 'cockpit://card/inst-1/index.html')).toBeNull();
  });

  it('卡片的普通报错也不是 CSP 违规', () => {
    expect(cspViolationFrom(3, 'TypeError: x is not a function', 'cockpit://card/inst-1/card.js')).toBeNull();
  });

  it('inline script 被拒也是 CSP 违规', () => {
    const got = cspViolationFrom(
      3,
      "Refused to execute inline script because it violates the following Content Security Policy " +
        "directive: \"script-src 'self'\". ",
      'cockpit://card/inst-1/index.html',
    );
    expect(got).not.toBeNull();
  });

  it('没有 sourceUrl（说不清是谁的）→ 不认领（**归属不了就不记**）', () => {
    const got = cspViolationFrom(3, 'violates the following Content Security Policy directive', '');
    expect(got).toBeNull();
  });
});
