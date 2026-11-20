import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { type Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { startMcpHttp } from '../../../src/main/mcp/http';
import type { McpServer } from '../../../src/main/mcp/server';

/**
 * The HTTP transport of MCP (contract `spec/04` §7.1, MCP specification
 * 2025-06-18).
 *
 * Why this layer has to run real HTTP:
 *
 * Several parts of the security baseline **can only be verified over real
 * HTTP**: a malicious `Origin` → **403**, another `Host` → **403**, no token →
 * **401**. These are matters of **headers**, and a unit test cannot compose
 * "the request was really refused".
 *
 * What the specification requires:
 *
 * - the client sends JSON-RPC with `POST` and an `Accept: application/json,
 *   text/event-stream` header;
 * - a request is answered with `application/json` (**one JSON object** — the
 *   specification allows JSON or SSE, and this round chooses JSON);
 * - a notification or a response → **202 with an empty body** (specification,
 *   "Sending Messages", item 4);
 * - `GET` → this round **offers no SSE** → **405** (the specification allows
 *   it);
 * - the `MCP-Protocol-Version` header with an unsupported version → **400**
 *   (specification, "Protocol Version Header").
 */

let server: Server;
let port: number;
let token: string;
let mcp: McpServer;
let close: () => Promise<void>;

beforeEach(async () => {
  // **The stub has to behave like the real thing**: a message without an `id` (a
// notification) is answered with `null`, and the HTTP layer turns that into 202
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

/** Sends a request (**the headers can be overridden** — a case such as a malicious Origin needs them) */
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

describe('MCP · HTTP transport', () => {
  it('**it binds 127.0.0.1 only** (contract §7.1 — it may not bind 0.0.0.0)', () => {
    const address = server.address();
    expect(typeof address === 'object' && address !== null).toBe(true);
    expect((address as { address: string }).address).toBe('127.0.0.1');
  });

  it('**binding another address → it is refused right away** (not "bind it and see", that would be too late)', async () => {
    // ⚠️ **0.0.0.0 = every network card** — that exposes the service to the local network
    await expect(
      startMcpHttp({ mcp, token, host: '0.0.0.0', port: 0 }),
    ).rejects.toThrow(/only bind to localhost/);
  });

  it('**a JSON-RPC request → 200 and JSON**', async () => {
    const reply = await send('POST', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(reply.status).toBe(200);
    expect(String(reply.headers['content-type'])).toContain('application/json');
    expect(JSON.parse(reply.body)).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  });

  it('**a notification → 202 with an empty body** (specification, "Sending Messages", item 4)', async () => {
    const reply = await send('POST', { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(reply.status).toBe(202);
    expect(reply.body).toBe('');
  });

  it('**a malicious Origin → 403** (DNS rebinding)', async () => {
    const reply = await send(
      'POST',
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { Origin: 'https://evil.example.com' },
    );
    expect(reply.status).toBe(403);
  });

  it('**another host name → 403**', async () => {
    const reply = await send(
      'POST',
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { Host: 'evil.example.com' },
    );
    expect(reply.status).toBe(403);
  });

  it('**no token → 401**', async () => {
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

  it('**the wrong token → 401**', async () => {
    const reply = await send(
      'POST',
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { Authorization: 'Bearer wrong' },
    );
    expect(reply.status).toBe(401);
  });

  it('**no CORS headers are sent** (contract §7.1 — no cross-origin allowance)', async () => {
    const reply = await send('POST', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(reply.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('**an unsupported protocol version → 400** (specification, "Protocol Version Header")', async () => {
    const reply = await send(
      'POST',
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { 'MCP-Protocol-Version': '1999-01-01' },
    );
    expect(reply.status).toBe(400);
  });

  it('**GET → 405** (this round offers no SSE, and the specification allows that answer)', async () => {
    const reply = await send('GET', undefined);
    expect(reply.status).toBe(405);
  });
});
