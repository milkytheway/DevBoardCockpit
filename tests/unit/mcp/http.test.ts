import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { type Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { startMcpHttp } from '../../../src/main/mcp/http';
import type { McpServer } from '../../../src/main/mcp/server';

/**
 * **MCP 的 HTTP 传输**（契约 `spec/04` §7.1 ✓ · MCP 规范 2025-06-18 ✓）。
 *
 * ── 为什么这一层要真跑 HTTP ──
 *
 * 安全基线的几条**只有在真 HTTP 上才验得了** ✓：
 * 恶意 `Origin` → **403** ✓ · 别的 `Host` → **403** ✓ · 没 token → **401** ✓
 * —— 这些是**头**上的事 ✓，单元测试拼不出「请求真的被拒了」✓。
 *
 * ── 规范要求的几件事 ──
 *
 * - 客户端 `POST` 发 JSON-RPC ✓；带 `Accept: application/json, text/event-stream` ✓；
 * - 请求 → 回 `application/json`（**一个 JSON 对象** ✓ —— 规范允许 JSON 或 SSE ✓，本轮选 JSON ✓）；
 * - 通知 / 响应 → **202 空体** ✓（规范 §「Sending Messages」第 4 条 ✓）；
 * - `GET` → 本轮**不提供 SSE** → **405** ✓（规范允许 ✓）；
 * - `MCP-Protocol-Version` 头 → 不支持的版本 → **400** ✓（规范 §「Protocol Version Header」✓）。
 */

let server: Server;
let port: number;
let token: string;
let mcp: McpServer;
let close: () => Promise<void>;

beforeEach(async () => {
  // **桩要像真的**：没有 `id` 的消息（通知 ✓）→ 回 `null` ✓（HTTP 层据此给 202 ✓）
  mcp = {
    handle: async (message: { id?: unknown }) =>
      message.id === undefined
        ? null
        : { jsonrpc: '2.0', id: message.id, result: {} },
  } as unknown as McpServer;
  token = 'tok-abc';
  const started = await startMcpHttp({
    mcp,
    token,
    host: '127.0.0.1',
    port: 0,
  });
  server = started.server;
  port = started.port;
  close = started.close;
});

afterEach(async () => {
  await close();
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** 发一个请求（**头可以覆盖** ✓ —— 测「恶意 Origin」这类就要改头 ✓） */
function send(
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method,
        headers: {
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${token}`,
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += String(chunk);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: text,
          }),
        );
      },
    );
    req.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
    if (payload !== undefined) req.end(payload);
    else req.end();
  });
}

describe('MCP · HTTP 传输', () => {
  it('**只绑 127.0.0.1** ✓（契约 §7.1 ✓ —— 不许绑 0.0.0.0 ✓）', () => {
    const address = server.address();
    expect(typeof address === 'object' && address !== null).toBe(true);
    expect((address as { address: string }).address).toBe('127.0.0.1');
  });

  it('**要绑别的地址 → 直接拒绝** ✓（不是「绑上了再说」✗ —— 那就晚了 ✓）', async () => {
    // ⚠️ **0.0.0.0 = 所有网卡** ✓ —— 那是把服务暴露到局域网 ✓
    await expect(
      startMcpHttp({ mcp, token, host: '0.0.0.0', port: 0 }),
    ).rejects.toThrow(/only bind to localhost/);
  });

  it('**JSON-RPC 请求 → 200 + JSON** ✓', async () => {
    const reply = await send('POST', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(reply.status).toBe(200);
    expect(String(reply.headers['content-type'])).toContain('application/json');
    expect(JSON.parse(reply.body)).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  });

  it('**通知 → 202 空体** ✓（规范 §「Sending Messages」第 4 条 ✓）', async () => {
    const reply = await send('POST', { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(reply.status).toBe(202);
    expect(reply.body).toBe('');
  });

  it('**恶意 Origin → 403** ✓（DNS rebinding ✓）', async () => {
    const reply = await send(
      'POST',
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { Origin: 'https://evil.example.com' },
    );
    expect(reply.status).toBe(403);
  });

  it('**别的主机名 → 403** ✓', async () => {
    const reply = await send(
      'POST',
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { Host: 'evil.example.com' },
    );
    expect(reply.status).toBe(403);
  });

  it('**没带 token → 401** ✓', async () => {
    const reply = await new Promise<Reply>((resolve) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
        },
        (res) => {
          let text = '';
          res.on('data', (c) => {
            text += String(c);
          });
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
          );
        },
      );
      req.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    });
    expect(reply.status).toBe(401);
  });

  it('**token 不对 → 401** ✓', async () => {
    const reply = await send(
      'POST',
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { Authorization: 'Bearer wrong' },
    );
    expect(reply.status).toBe(401);
  });

  it('**不发 CORS 头** ✓（契约 §7.1 ✓ —— 不做跨域放行 ✓）', async () => {
    const reply = await send('POST', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(reply.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('**不支持的协议版本 → 400** ✓（规范 §「Protocol Version Header」✓）', async () => {
    const reply = await send(
      'POST',
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { 'MCP-Protocol-Version': '1999-01-01' },
    );
    expect(reply.status).toBe(400);
  });

  it('**GET → 405** ✓（本轮不提供 SSE ✓ —— 规范允许这样回 ✓）', async () => {
    const reply = await send('GET', undefined);
    expect(reply.status).toBe(405);
  });
});
