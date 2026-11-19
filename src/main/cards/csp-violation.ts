import type { CardCspViolation } from '../../shared/ipc-contract';

/**
 * CSP 违规 → 运行时日志里的一句话。
 *
 * ── agent 看到的就是这一句 ──
 *
 * 契约 `spec/03` §6.1：「浏览器的 CSP 违规会记在卡片运行时日志里，
 * agent 因此能看到『这张卡试图联网』」。
 *
 * → 这句话必须**说清楚它想干什么**：
 * 「哪条指令被违反了」（`effectiveDirective`）+
 * 「它想访问什么」（`blockedURI`）+
 * 「在卡片的哪个文件第几行」（`sourceFile` / `lineNumber`）。
 *
 * 写成英文的 "CSP violation" 谁也看不懂——**卡片作者要照着改，agent 要照着判**。
 */
export function cspViolationMessage(violation: CardCspViolation): string {
  const directive = violation.effectiveDirective || violation.violatedDirective || '(unknown directive)';
  const target = violation.blockedURI === '' ? '(no address)' : violation.blockedURI;
  const where =
    violation.sourceFile === ''
      ? ''
      : ` (${violation.sourceFile}${violation.lineNumber > 0 ? ` line ${violation.lineNumber}` : ''})`;
  return `CSP violation: ${directive} — it wanted to access ${target}, the host CSP refused it ${where}`.trim();
}
