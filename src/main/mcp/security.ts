import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The **security baseline of the local MCP server** (contract `spec/04` §7.1 ✓).
 *
 * ── Why these rules are a **hard requirement** and not a "recommendation" ──
 *
 * If a local HTTP MCP server does not validate `Origin` / `Host` ✓,
 * **every malicious web page the user has ever visited** can send requests to
 * `127.0.0.1` through DNS rebinding ✓
 * → and drive `execute_action` to change the board of the user ✓.
 * (The words of the MCP specification: "Servers **MUST** validate the
 * `Origin` header on all incoming connections to prevent DNS rebinding
 * attacks" ✓ — the contract turned that into a hard requirement ✓.)
 *
 * ── Why **both** `Origin` and `Host` have to be checked ──
 *
 * - only `Origin` ✗ → does not block a **non-browser client** (that would
 *   require malicious software on the machine ✓);
 * - only `Host` ✗ → does not block a **legitimate Host with a malicious Origin
 *   sent by a browser** (the proxy case ✓).
 * → **Both of them** ✓ → each blocks half ✓ → together they close the loop ✓.
 */

/** The version of the MCP protocol (2025-06-18 ✓ — the latest one in the specification ✓) */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** The token of one session (**regenerated on every start** ✓ — contract §7.1 ✓) */
export function generateToken(): string {
  // **32 random bytes** ✓ (the contract: ≥32 bytes ✓) → base64url ✓ (44 characters ✓, no padding ✓)
  return randomBytes(32).toString('base64url');
}

/**
 * **Is the `Origin` legitimate** ✓.
 *
 * → **It is there and not legitimate** → 403 ✓ (the words of the contract ✓).
 * → **It is not there** → let it pass ✓ (a client that is **not a browser** ✓
 *   — the agent itself, for instance ✓).
 *
 * What counts as legitimate? **The local machine** ✓:
 * `http://127.0.0.1:<port>` / `http://localhost:<port>` / `file://` ✓ (the
 * pages of Electron itself ✓).
 */
export function checkOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return true;
  // **`null` is the "opaque origin" of the browser** ✓ — it is not the local machine ✓ → refuse ✓
  if (origin === 'null') return false;
  if (origin === 'file://') return true;
  // **Only the local machine over http/https is accepted** ✓
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
}

/**
 * **Is the `Host` legitimate** ✓ (contract §7.1: only `127.0.0.1:<port>` and
 * `localhost:<port>` are accepted ✓).
 *
 * → The port has to match as well ✓ (otherwise the request could be aimed at
 *   **another** port ✓).
 */
export function checkHost(host: string | undefined, port: number): boolean {
  if (host === undefined || host === '') return false;
  // **`[::1]:port`** ✓ (the IPv6 loopback ✓)
  const match = /^\[?([^\]]+)\]?:(\d+)$/.exec(host);
  if (match === null) return false;
  const name = match[1] as string;
  const hostPort = Number(match[2]);
  if (hostPort !== port) return false;
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

/**
 * **Bearer authentication** ✓ (contract §7.1: every request has to carry
 * `Authorization: Bearer <token>` ✓).
 *
 * → The comparison is a **constant-time comparison** ✓ (`timingSafeEqual` ✓) —
 *   a plain `===` **leaks the prefix through the time it takes** ✓.
 */
export function checkAuthorization(header: string | undefined, token: string): boolean {
  if (header === undefined) return false;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  const given = header.slice(prefix.length);
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(token, 'utf8');
  // **A different length cannot be compared** ✓ (`timingSafeEqual` requires the same length ✓ — a different length is refused directly ✓)
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
