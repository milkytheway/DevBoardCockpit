import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * **MCP server 的本机安全基线**（契约 `spec/04` §7.1 ✓）。
 *
 * ── 为什么这几条是**硬要求**而不是「建议」 ──
 *
 * 本地 HTTP MCP server 若不校验 `Origin` / `Host` ✓，
 * **任何用户访问过的恶意网页**都能通过 DNS rebinding 向 `127.0.0.1` 发请求 ✓
 * → 直接驱动 `execute_action` 改用户的板子 ✓。
 * （MCP 规范原话：「Servers **MUST** validate the `Origin` header on all incoming connections
 * to prevent DNS rebinding attacks」✓ —— 契约把它写成了硬要求 ✓。）
 *
 * ── 为什么 `Origin` 与 `Host` **都要**查 ──
 *
 * - 只查 `Origin` ✗ → 挡不住**非浏览器客户端**（但那要本机有恶意程序 ✓）；
 * - 只查 `Host` ✗ → 挡不住**浏览器发来的合法 Host + 恶意 Origin**（proxy 场景 ✓）。
 * → **两个都要** ✓ → 各自堵一半 ✓ → 合起来才是闭环 ✓。
 */

/** MCP 协议版本（2025-06-18 ✓ —— 规范里最新的那版 ✓） */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** 一次会话的 token（**每次启动重新生成** ✓ —— 契约 §7.1 ✓） */
export function generateToken(): string {
  // **32 随机字节** ✓（契约：≥32 字节 ✓）→ base64url ✓（44 字符 ✓，无填充 ✓）
  return randomBytes(32).toString('base64url');
}

/**
 * **`Origin` 合不合法** ✓。
 *
 * → **存在且不合法** → 403 ✓（契约原文 ✓）。
 * → **不存在** → 放行 ✓（**不是浏览器**的客户端 ✓ —— 比如 agent 自己 ✓）。
 *
 * 什么算合法？**本机** ✓：`http://127.0.0.1:<port>` / `http://localhost:<port>` /
 * `file://` ✓（Electron 自己的页面 ✓）。
 */
export function checkOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return true;
  // **`null` 是浏览器的「不透明来源」** ✓ —— 它不是本机 ✓ → 拒 ✓
  if (origin === 'null') return false;
  if (origin === 'file://') return true;
  // **只认 http/https 的本机** ✓
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
 * **`Host` 合不合法** ✓（契约 §7.1：只接受 `127.0.0.1:<port>` 与 `localhost:<port>` ✓）。
 *
 * → 端口也必须对上 ✓（否则能把请求打到**别的**端口上 ✓）。
 */
export function checkHost(host: string | undefined, port: number): boolean {
  if (host === undefined || host === '') return false;
  // **`[::1]:port`** ✓（IPv6 回环 ✓）
  const match = /^\[?([^\]]+)\]?:(\d+)$/.exec(host);
  if (match === null) return false;
  const name = match[1] as string;
  const hostPort = Number(match[2]);
  if (hostPort !== port) return false;
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

/**
 * **Bearer 认证** ✓（契约 §7.1：每个请求必须带 `Authorization: Bearer <token>` ✓）。
 *
 * → 比较用**定长比较** ✓（`timingSafeEqual` ✓）——
 * 普通的 `===` **会因比较耗时泄露前缀** ✓。
 */
export function checkAuthorization(header: string | undefined, token: string): boolean {
  if (header === undefined) return false;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  const given = header.slice(prefix.length);
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(token, 'utf8');
  // **长度不等就不能比** ✓（`timingSafeEqual` 要求等长 ✓ —— 不等长时直接拒 ✓）
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
