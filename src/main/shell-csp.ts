/**
 * The CSP of the shell (`cockpit://app/`).
 *
 * ── Why it is a separate file ──
 *
 * `main/index.ts` imports Electron, so **unit tests cannot reach it**.
 * The shell CSP is exactly the kind of thing that **"fails silently and simply
 * shows nothing"** — it needs a criterion that can run in a unit test.
 *
 * ── Why `frame-src` is `cockpit:` ──
 *
 * | | scheme | host | origin |
 * |---|---|---|---|
 * | shell | `cockpit:` | `app` | `cockpit://app` |
 * | card | `cockpit:` | `card` | `cockpit://card` |
 *
 * **Two different origins** (the hosts differ) → the shell's `'self'` does
 * **not** cover the cards. The CSP host-source syntax accepts only
 * http/https/ws/wss/ftp, so a **scheme source** `cockpit:` is the only
 * possibility.
 *
 * ── A pitfall hit on 2026-11-14 ──
 *
 * The design baseline copied the **card** CSP into the shell,
 * and that copy contained `frame-src 'none'` → **in production mode not a
 * single card would load**,
 * and the only symptom was "the card area is blank", with no error at all.
 *
 * → This table **must never be copied from the card side again**.
 */
export const SHELL_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; " +
  "object-src 'none'; base-uri 'none'; frame-src cockpit:";
