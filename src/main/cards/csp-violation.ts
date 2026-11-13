/**
 * 认出「这是一条 CSP 违规」。
 *
 * ── 为什么要有这个模块 ──
 *
 * Electron 的 `console-message` 事件签名**换过**，而且**两种形都还在**：
 *
 * | 事件 | 签名 | 版本 |
 * |---|---|---|
 * | `WebContents.console-message` | `(event, level, message, line, sourceId)` | **本工程在用的 Electron 34 就是这个** |
 * | `ServiceWorkers.console-message` | `(event, messageDetails: MessageDetails)` | 25+ |
 *
 * `MessageDetails` **只属于 `ServiceWorkers`**。
 * 拿它去读 `WebContents` 的参数，`args[1]` 是**一个数字**（level），
 * `details.source` 恒为 `undefined` → **每一条违规都在第一道门就被丢掉**
 * → 契约 §6.1 承诺的「agent 能看到这张卡试图联网」**永远兑现不了**。
 *
 * ── 怎么认 ──
 *
 * 旧签名里**没有** `source` 字段（那是 `MessageDetails` 才有的），
 * 所以只能看**消息文本**：Chromium 的 CSP 违规消息一定含
 * `Content Security Policy`（或 `CSP violation`）。
 *
 * ── 归属不了就不记 ──
 *
 * 没有 `sourceId` 就说不清是谁的 → 返回 `null`，
 * 由 `runtime-log` 决定「不落进任何卡」
 * （挂错卡的日志比没有日志更糟——它会让 agent 去查一张没做错事的卡）。
 */

/** Chromium 的 CSP 违规消息里一定有的那句 */
const CSP_MESSAGE = /Content Security Policy|CSP violation/i;

export interface CspViolation {
  /** 违规的原文（进运行时日志） */
  message: string;
  /** 触发这条消息的源 URL（`cockpit://card/<实例 id>/…`） */
  sourceUrl: string;
}

/**
 * 判一条 `console-message` 是不是 CSP 违规。
 *
 * @param level 日志级别（0..3）——**旧签名里的第二个参数**
 * @param message 日志正文——**旧签名里的第三个参数**
 * @param sourceId 源 URL——**旧签名里的第五个参数**
 */
export function cspViolationFrom(
  level: number,
  message: string,
  sourceId: string,
): CspViolation | null {
  // CSP 违规**至少是警告**（Chromium 记成 error=3，新版有些记成 warning=2），
  // 绝不会出现在 verbose/info（0/1）里。
  if (level < 2) return null;
  if (!CSP_MESSAGE.test(message)) return null;
  // **说不清是谁的 → 不认领**
  if (sourceId === '') return null;
  return { message, sourceUrl: sourceId };
}
