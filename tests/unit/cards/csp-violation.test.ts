import { describe, it, expect } from 'vitest';
import { cspViolationMessage } from '../../../src/main/cards/csp-violation';
import type { CardCspViolation } from '../../../src/shared/ipc-contract';

/**
 * A CSP violation → one sentence in the runtime log.
 *
 * Why this module exists:
 *
 * Contract `spec/03` §6.1 promises that "the CSP violations of the browser
 * are recorded in the runtime log of the card, so the agent can see "this
 * card tried to reach the network"". The agent sees **one sentence** — so
 * that sentence has to **say what it wanted to do** and not be an English
 * "CSP violation" that nobody understands.
 *
 * Where the violation comes from:
 *
 * the `securitypolicyviolation` event of the document of the card (the
 * listener script the host injects) → the card → the broker on the page side
 * → main → the runtime log.
 *
 * (The host **used to** catch them with `console-message`, which does not
 * catch the `connect-src` kind — the `sourceId` of Electron 34 is an empty
 * string for it and it cannot be attributed to a card. See ADR-D29.)
 */
describe('the message of a CSP violation', () => {
  const violation: CardCspViolation = {
    blockedURI: 'https://evil.example/steal',
    effectiveDirective: 'connect-src',
    violatedDirective: 'connect-src',
    sourceFile: 'cockpit://card/inst-1/card.js',
    lineNumber: 42,
    sample: '',
  };

  it('**it names the directive and says what it wanted to do**', () => {
    const message = cspViolationMessage(violation);
    expect(message).toContain('connect-src');
    expect(message).toContain('https://evil.example/steal');
  });

  it('**it is one sentence** (the agent and the operator both read it)', () => {
    expect(cspViolationMessage(violation)).toContain('CSP');
  });

  it('**the line number is given as well** (the author of the card has to change it)', () => {
    expect(cspViolationMessage(violation)).toContain('42');
  });

  it('an inline script, a case whose address is inline, has to be described as well', () => {
    const inline = cspViolationMessage({
      ...violation,
      blockedURI: 'inline',
      effectiveDirective: 'script-src-elem',
      violatedDirective: 'script-src',
    });
    expect(inline).toContain('script-src');
    expect(inline).toContain('inline');
  });

  it('an address that is missing (an empty string) may not be reported as "undefined"', () => {
    const message = cspViolationMessage({ ...violation, blockedURI: '' });
    expect(message).not.toContain('undefined');
    expect(message).toContain('connect-src');
  });
});
