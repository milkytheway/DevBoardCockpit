import type { CardCspViolation } from '../../shared/ipc-contract';

/**
 * A CSP violation rendered as one line in the runtime log.
 *
 * ── This line is what the agent sees ──
 *
 * The contract `spec/03` §6.1: "the CSP violation of the browser is recorded in
 * the card runtime log, so the agent can see that the card tried to reach the
 * network".
 *
 * → The line must say **what it was trying to do**:
 * "which directive was violated" (`effectiveDirective`) +
 * "what it wanted to reach" (`blockedURI`) +
 * "in which file of the card, at which line" (`sourceFile` / `lineNumber`).
 *
 * A bare "CSP violation" tells nobody anything — **the card author has to fix
 * it, the agent has to judge it**.
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
