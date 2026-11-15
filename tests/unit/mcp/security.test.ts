import { describe, it, expect } from 'vitest';
import {
  generateToken,
  checkOrigin,
  checkHost,
  checkAuthorization,
  MCP_PROTOCOL_VERSION,
} from '../../../src/main/mcp/security';

/**
 * **MCP server 的本机安全基线**（契约 `spec/04` §7.1 ✓）。
 *
 * ── 为什么这几条是**硬要求**而不是建议 ──
 *
 * 本地 HTTP MCP server 若不校验 `Origin` / `Host` ✓，
 * **任何用户访问过的恶意网页**都能通过 DNS rebinding 向 `127.0.0.1` 发请求 ✓
 * → 直接驱动 `execute_action` 改用户的板子 ✓。
 * （规范原话：「Servers **MUST** validate the `Origin` header on all incoming connections
 * to prevent DNS rebinding attacks」✓ —— 契约把它写成了硬要求 ✓。）
 *
 * ── 为什么 Origin 与 Host **都要**查 ──
 *
 * - 只查 `Origin` ✗ → 挡不住**非浏览器客户端**伪造 ✓（但那需要本机有恶意程序 ✓）；
 * - 只查 `Host` ✗ → 挡不住**浏览器发来的合法 Host + 恶意 Origin** ✓（proxy 场景 ✓）。
 * → **两个都要** ✓ → 各自堵一半 ✓ → 合起来才是闭环 ✓。
 */
describe('MCP · token', () => {
  it('**每次生成都不一样**（≥32 字节 ✓）—— 上次会话的 token 立刻失效 ✓', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    // **≥32 字节** ✓（契约 §7.1 ✓）—— 熵不够 = 可被猜到 ✓
    expect(Buffer.from(a, 'base64url').length).toBeGreaterThanOrEqual(32);
  });

  it('**不是可读的明文**（别用计数器当 token ✓）', () => {
    const token = generateToken();
    // 32 随机字节的 base64url 长度固定 ✓ —— 短了就说明熵不够 ✓
    expect(token.length).toBeGreaterThanOrEqual(43);
  });
});

describe('MCP · Origin 校验', () => {
  it('**恶意 Origin → 403**（网页发来的跨站请求 ✓）', () => {
    expect(checkOrigin('https://evil.example.com')).toBe(false);
    expect(checkOrigin('http://localhost.evil.com')).toBe(false);
    expect(checkOrigin('null')).toBe(false);
  });

  it('**本机 Origin → 放行**（Electron 自己的页面 ✓）', () => {
    expect(checkOrigin('http://127.0.0.1:5173')).toBe(true);
    expect(checkOrigin('http://localhost:5173')).toBe(true);
    expect(checkOrigin('file://')).toBe(true);
  });

  it('**没有 Origin → 放行**（不是浏览器的客户端 ✓ —— 比如 agent 自己 ✓）', () => {
    // ⚠️ **不存在 ≠ 不合法** ✓ —— 契约原文：「**存在且不合法时**返回 403」✓
    expect(checkOrigin(undefined)).toBe(true);
  });
});

describe('MCP · Host 校验', () => {
  it('**别的主机名 → 403**（DNS rebinding 的另一半 ✓）', () => {
    expect(checkHost('evil.example.com:51234', 51234)).toBe(false);
    expect(checkHost('127.0.0.1.evil.com:51234', 51234)).toBe(false);
  });

  it('**127.0.0.1 与 localhost → 放行**（契约 §7.1 明写这两个 ✓）', () => {
    expect(checkHost('127.0.0.1:51234', 51234)).toBe(true);
    expect(checkHost('localhost:51234', 51234)).toBe(true);
  });

  it('**端口不对 → 403**（连到别的服务上 ✓）', () => {
    expect(checkHost('127.0.0.1:9999', 51234)).toBe(false);
  });
});

describe('MCP · Bearer 认证', () => {
  it('**没有 Authorization → 401**', () => {
    expect(checkAuthorization(undefined, 'tok')).toBe(false);
  });

  it('**token 不对 → 401**', () => {
    expect(checkAuthorization('Bearer wrong', 'tok')).toBe(false);
    expect(checkAuthorization('Bearer tok-extra', 'tok')).toBe(false);
  });

  it('**不是 Bearer → 401**（别的前缀也认不出来 ✓）', () => {
    expect(checkAuthorization('Basic dXNlcjp0b2s=', 'tok')).toBe(false);
    expect(checkAuthorization('tok', 'tok')).toBe(false);
  });

  it('**对得上 → 放行**', () => {
    expect(checkAuthorization('Bearer tok', 'tok')).toBe(true);
  });
});

describe('MCP · 协议版本', () => {
  it('**版本号是契约写死的那个**', () => {
    expect(MCP_PROTOCOL_VERSION).toBe('2025-06-18');
  });
});
