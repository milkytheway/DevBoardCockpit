import { describe, it, expect } from 'vitest';
import {
  generateToken,
  checkOrigin,
  checkHost,
  checkAuthorization,
  MCP_PROTOCOL_VERSION,
} from '../../../src/main/mcp/security';

/**
 * The local security baseline of the MCP server (contract `spec/04` §7.1).
 *
 * Why these are **hard requirements** and not advice:
 *
 * If the local HTTP MCP server does not validate `Origin` and `Host`, then
 * **any malicious page the user has visited** can send a request to
 * `127.0.0.1` through DNS rebinding and drive `execute_action` to change the
 * user's board. The specification says: "Servers **MUST** validate the
 * `Origin` header on all incoming connections to prevent DNS rebinding
 * attacks"; the contract turns that into a hard requirement.
 *
 * Why both `Origin` and `Host` are checked:
 *
 * - checking only `Origin` does not stop a **non-browser client** from forging
 *   it (that would require malicious software on the machine);
 * - checking only `Host` does not stop a **browser sending a valid Host with a
 *   malicious Origin** (the proxy case).
 *
 * Both are needed: each closes one half, together they close the loop.
 */
describe('MCP · token', () => {
  it('**every generation differs** (≥32 bytes) — the token of the previous session is invalid at once', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    // **≥32 bytes** (contract §7.1) — too little entropy means it can be guessed
    expect(Buffer.from(a, 'base64url').length).toBeGreaterThanOrEqual(32);
  });

  it('**it is not readable plaintext** (a counter is no token)', () => {
    const token = generateToken();
    // The base64url of 32 random bytes has a fixed length — a shorter one means
// there is too little entropy
    expect(token.length).toBeGreaterThanOrEqual(43);
  });
});

describe('MCP · Origin check', () => {
  it('**a malicious Origin → 403** (a cross-site request from a web page)', () => {
    expect(checkOrigin('https://evil.example.com')).toBe(false);
    expect(checkOrigin('http://localhost.evil.com')).toBe(false);
    expect(checkOrigin('null')).toBe(false);
  });

  it('**a local Origin → let through** (the page of Electron itself)', () => {
    expect(checkOrigin('http://127.0.0.1:5173')).toBe(true);
    expect(checkOrigin('http://localhost:5173')).toBe(true);
    expect(checkOrigin('file://')).toBe(true);
  });

  it('**no Origin → let through** (a client that is not a browser, such as an agent itself)', () => {
    // **does not exist is not the same as not legitimate** — the contract says:
// "**when it exists and is not legitimate**, 403 is returned"
    expect(checkOrigin(undefined)).toBe(true);
  });
});

describe('MCP · Host check', () => {
  it('**another host name → 403** (the other half of DNS rebinding)', () => {
    expect(checkHost('evil.example.com:51234', 51234)).toBe(false);
    expect(checkHost('127.0.0.1.evil.com:51234', 51234)).toBe(false);
  });

  it('**127.0.0.1 and localhost → let through** (contract §7.1 names these two)', () => {
    expect(checkHost('127.0.0.1:51234', 51234)).toBe(true);
    expect(checkHost('localhost:51234', 51234)).toBe(true);
  });

  it('**the wrong port → 403** (it reached a different service)', () => {
    expect(checkHost('127.0.0.1:9999', 51234)).toBe(false);
  });
});

describe('MCP · Bearer authentication', () => {
  it('**no Authorization → 401**', () => {
    expect(checkAuthorization(undefined, 'tok')).toBe(false);
  });

  it('**the wrong token → 401**', () => {
    expect(checkAuthorization('Bearer wrong', 'tok')).toBe(false);
    expect(checkAuthorization('Bearer tok-extra', 'tok')).toBe(false);
  });

  it('**not a Bearer → 401** (another prefix is not recognised either)', () => {
    expect(checkAuthorization('Basic dXNlcjp0b2s=', 'tok')).toBe(false);
    expect(checkAuthorization('tok', 'tok')).toBe(false);
  });

  it('**it matches → let through**', () => {
    expect(checkAuthorization('Bearer tok', 'tok')).toBe(true);
  });
});

describe('MCP · protocol version', () => {
  it('**the version number is the one the contract fixes**', () => {
    expect(MCP_PROTOCOL_VERSION).toBe('2025-06-18');
  });
});
