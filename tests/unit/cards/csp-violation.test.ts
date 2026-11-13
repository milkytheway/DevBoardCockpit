import { describe, it, expect } from 'vitest';
import { cspViolationMessage } from '../../../src/main/cards/csp-violation';
import type { CardCspViolation } from '../../../src/shared/ipc-contract';

/**
 * CSP 违规 → 运行时日志里的一句话。
 *
 * ── 为什么要有这个模块 ──
 *
 * 契约 `spec/03` §6.1 承诺「浏览器的 CSP 违规会记在卡片运行时日志里，
 * agent 因此能看到『这张卡试图联网』」。
 * agent 看到的是**一句话**——所以这句话必须**说清楚它想干什么**，
 * 而不是「CSP violation」这种谁也看不懂的英文。
 *
 * ── 违规从哪来 ──
 *
 * 卡片文档里的 `securitypolicyviolation` 事件（宿主注入的监听脚本）→
 * 卡片 → 页面侧经纪人 → main → 运行时日志。
 *
 * （宿主**原来**靠 `console-message` 抓，实测抓不到 `connect-src` 那类——
 * Electron 34 的 `sourceId` 对它是空串，归属不到卡。见 ADR-D29。）
 */
describe('CSP 违规的消息', () => {
  const violation: CardCspViolation = {
    blockedURI: 'https://evil.example/steal',
    effectiveDirective: 'connect-src',
    violatedDirective: 'connect-src',
    sourceFile: 'cockpit://card/inst-1/card.js',
    lineNumber: 42,
    sample: '',
  };

  it('**说清楚「哪条指令」与「它想干什么」**', () => {
    const message = cspViolationMessage(violation);
    expect(message).toContain('connect-src');
    expect(message).toContain('https://evil.example/steal');
  });

  it('**是一句中文**（agent 与人都读得懂）', () => {
    expect(cspViolationMessage(violation)).toContain('CSP');
  });

  it('**行号也给出来**（卡片作者要照着改）', () => {
    expect(cspViolationMessage(violation)).toContain('42');
  });

  it('内联脚本这类「地址是 inline」的也要说得清楚', () => {
    const inline = cspViolationMessage({
      ...violation,
      blockedURI: 'inline',
      effectiveDirective: 'script-src-elem',
      violatedDirective: 'script-src',
    });
    expect(inline).toContain('script-src');
    expect(inline).toContain('inline');
  });

  it('没有地址（空串）也不要说成「undefined」', () => {
    const message = cspViolationMessage({ ...violation, blockedURI: '' });
    expect(message).not.toContain('undefined');
    expect(message).toContain('connect-src');
  });
});
