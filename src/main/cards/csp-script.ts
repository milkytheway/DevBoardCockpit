/**
 * The **CSP violation listener script** injected into cards.
 *
 * ── Why this and not `console-message` ──
 *
 * The host used to catch CSP violations through the renderer's
 * `console-message` event. **In practice it did not catch them all**:
 *
 * | Violation type | `sourceId` of `console-message` (Electron 34.5.8) | Attributable to a card? |
 * |---|---|---|
 * | `img-src` (external image) | the card's URL | yes |
 * | `connect-src` (`fetch` to the network) | **empty string** | **no** |
 * | `script-src` (inline script) | **empty string** | **no** |
 *
 * The contract `spec/03` §6.1 promises exactly that an agent can see **this
 * card tried to reach the network** — and "tried to reach the network" is
 * `connect-src`, which is **precisely the kind the host could not catch**.
 *
 * → Use the browser's only standard signal: the DOM
 * **securitypolicyviolation** event.
 * It fires **inside the document of the card that violated the policy** →
 * attribution is exact by construction; and it carries `blockedURI` /
 * `effectiveDirective` / `violatedDirective`, so an agent can see directly
 * what it was trying to do.
 *
 * ── Why a **classic script** and not a module ──
 *
 * The listener must be installed **before the card's own scripts**.
 * A `type="module"` script is deferred → it runs after the whole document is
 * parsed → violations caused during **parsing** (inline script, external
 * image) are missed. A classic script runs **synchronously during parsing** →
 * it is installed early ✓.
 *
 * ── How it reports ──
 *
 * It calls `parent.postMessage` directly (**not through the bridge**):
 * the bridge is a module → installed too late; and this message is **not a
 * card API** — a card forging one could only pollute **its own** log.
 */
export const CSP_SCRIPT_MARKER = '/* cockpit-csp:v1 */';

/**
 * Generates the listener script.
 *
 * @param instanceId the id of this instance — **the basis for attribution**
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
      // If the report cannot get out, so be it — **a failed report must not take the card down**
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
 * The injected tag.
 *
 * **No `type="module"`** — a classic script runs synchronously during parsing,
 * so it is installed early.
 */
export function cspScriptTag(instanceId: string): string {
  const id = encodeURIComponent(instanceId);
  return `<script src="cockpit://card/${id}/__host/csp.js"></script>`;
}
