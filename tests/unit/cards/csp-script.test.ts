import { describe, it, expect } from 'vitest';
import { cspScriptFor, cspScriptTag } from '../../../src/main/cards/csp-script';

/**
 * The **script that listens for the CSP violations** inside the card.
 *
 * Why it exists:
 *
 * Contract `spec/03` §6.1: "the CSP violations of the browser are recorded in
 * the runtime log of the card, so the agent can see "this card tried to reach
 * the network"".
 *
 * **But the host used to catch them with `console-message`, and that does
 * not work** (measured on Electron 34.5.8):
 *
 * | Kind of violation | the `sourceId` of `console-message` | attributable to a card |
 * |---|---|---|
 * | `img-src` (an external image) | **there is one** (the URL of the card) | yes |
 * | `connect-src` (`fetch` to the outside) | **an empty string** | **no** |
 * | `script-src` (an inline script) | **an empty string** | **no** |
 *
 * And "tried to reach the network" is exactly the `connect-src` case —
 * **precisely the one the host cannot catch**.
 *
 * → Therefore the one standard signal of the browser is used instead: **the
 *   `securitypolicyviolation` event of the DOM**. It **fires in the document
 *   of the card where the violation happened** (the attribution is exact by
 *   nature) and it carries `blockedURI` / `effectiveDirective` /
 *   `violatedDirective` — the agent can see directly "what it wanted to do".
 *
 * Why a **classic script** and not a module:
 *
 * The listener has to be installed **before the script of the card itself**. A
 * script with `type="module"` is deferred → it runs after the whole document
 * was parsed → a violation that happens while the document is parsed (an
 * inline script, an external image) is missed. A classic script runs
 * **synchronously while the document is parsed** → it is installed early.
 */
describe('the script that listens for the CSP violations', () => {
  it('**it listens for securitypolicyviolation** (the only reliable signal of a CSP violation in the browser)', () => {
    expect(cspScriptFor('inst-1')).toContain("addEventListener('securitypolicyviolation'");
  });

  it('the instanceId is carried when it is reported to the host (the basis of the attribution)', () => {
    const script = cspScriptFor('inst-1');
    expect(script).toContain('inst-1');
    expect(script).toContain('cockpit-csp');
  });

  it('the key fields of the violation are carried as well (**the agent has to know what it wanted to do**)', () => {
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

  it('the injected tag is a **classic script** (not a module) — it has to come before the script of the card', () => {
    const tag = cspScriptTag('inst-1');
    expect(tag).toContain('src="cockpit://card/inst-1/__host/csp.js"');
    expect(tag).not.toContain('type="module"');
  });

  it('the script has no external dependency (it runs in an opaque origin iframe, there is no Node and no network)', () => {
    const script = cspScriptFor('inst-1');
    expect(script).not.toMatch(/\brequire\s*\(/);
    expect(script).not.toMatch(/\bimport\s/);
  });
});
