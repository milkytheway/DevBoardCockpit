import { describe, it, expect } from 'vitest';
import { SHELL_CSP } from '../../src/main/shell-csp';

/**
 * The CSP of the shell (`cockpit://app/`).
 *
 * Why this deserves a test of its own:
 *
 * The shell is the **only** place that can host an iframe (the card is its
 * iframe). The `frame-src` of the CSP says "**which frames this document
 * may host**", so as soon as the `frame-src` of the shell is wrong, **not a
 * single card loads**, and the symptom is "the card area stays blank" without
 * any error.
 *
 * The pitfall that was hit:
 *
 * The card is at `cockpit://card`, the shell at `cockpit://app` — **two
 * different origins** (the host differs). So `'self'` does not cover the
 * card, it has to be the **scheme origin** `cockpit:`.
 *
 * The design baseline of `docs/21` §4.7 copied the CSP **of the card** to
 * the shell (and it held a `frame-src 'none'`) — that "design" was wrong in
 * itself, do not copy it again.
 */
describe('the CSP of the shell', () => {
  it('**frame-src has to allow `cockpit:`** — the card is at cockpit://card, the shell at cockpit://app', () => {
    expect(SHELL_CSP).toMatch(/frame-src[^;]*cockpit:/);
  });

  it('**it may not be frame-src none** — that would keep every card out', () => {
    expect(SHELL_CSP).not.toMatch(/frame-src\s+'none'/);
  });

  it('the resources of the shell itself are still same-origin only', () => {
    expect(SHELL_CSP).toContain("default-src 'self'");
    expect(SHELL_CSP).toContain("script-src 'self'");
  });

  it('the network the shell may reach is limited', () => {
    expect(SHELL_CSP).toContain("connect-src 'self'");
  });
});
