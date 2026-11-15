import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  checkAuthorization,
  checkHost,
  checkOrigin,
  MCP_PROTOCOL_VERSION,
} from './security';
import type { McpServer } from './server';

/**
 * **MCP 的 HTTP 传输**（契约 `spec/04` §7.1 ✓ · MCP 规范 2025-06-18 ✓）。
 *
 * ── 为什么用 `node:http` 而不是某个框架 ──
 *
 * 本工程**零 web 框架依赖** ✓（`package.json` 里 7 个依赖没有一个是 web 框架 ✓），
 * 而这一层要做的只是「收一个 JSON-RPC 消息，回一个 JSON」✓ —— 框架给不了什么 ✓。
 *
 * ── 安全基线（契约 §7.1 的硬要求 ✓）──
 *
 * | 顺序 | 检查 | 不过时 |
 * |---|---|---|
 * | 1 | **`Origin`** ✓（存在且不合法 ✓） | **403** ✓ |
 * | 2 | **`Host`** ✓（只接受 `127.0.0.1:<port>` / `localhost:<port>` ✓） | **403** ✓ |
 * | 3 | **Bearer token** ✓ | **401** ✓ |
 * | 4 | **协议版本头** ✓ | **400** ✓ |
 *
 * → **顺序有讲究** ✓：`Origin`/`Host` 先 ✓（它们挡的是**浏览器** ✓），
 *   token 后 ✓（它挡的是**别人** ✓）→ 两者挡的是不同的攻击面 ✓。
 *
 * → **CORS 头一个都不发** ✓（契约 §7.1 ✓ —— 不做跨域放行 ✓）。
 */
export interface McpHttpOptions {
  mcp: McpServer;
  /** 本次启动的 bearer token ✓ */
  token: string;
  /** 监听地址（**只许 127.0.0.1** ✓ —— 传别的就该被拒 ✓） */
  host: string;
  /** 监听端口（**0 = 让 OS 分配** ✓ —— 避免多开撞端口 ✓） */
  port: number;
}

export interface McpHttpHandle {
  server: Server;
  /** 实际监听到的端口（**传 0 时是 OS 给的** ✓） */
  port: number;
  close: () => Promise<void>;
}

/** 端点路径（**一个** ✓ —— 规范：「MUST provide a single HTTP endpoint path」✓） */
export const MCP_ENDPOINT = '/mcp';

/** 我们支持的协议版本（**别的版本 → 400** ✓ —— 规范 §「Protocol Version Header」✓） */
const SUPPORTED_VERSIONS = new Set([MCP_PROTOCOL_VERSION]);

/** 读请求体（**有上限** ✓ —— 别让人往内存里灌一兆） */
const MAX_BODY_BYTES = 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体太大');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * **起一个 MCP 的 HTTP 服务** ✓。
 *
 * → **只绑 127.0.0.1** ✓（契约 §7.1 ✓）—— 传别的主机**直接拒绝** ✓
 *   （不是「绑上了再说」✗ —— 那就晚了 ✓）。
 */
export async function startMcpHttp(opts: McpHttpOptions): Promise<McpHttpHandle> {
  if (opts.host !== '127.0.0.1' && opts.host !== 'localhost' && opts.host !== '::1') {
    throw new Error(`MCP server 只能绑本机（契约 §7.1 ✓），收到：${opts.host}`);
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res, opts).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end('{"error":"internal"}');
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // **只绑回环** ✓（**不是 0.0.0.0** ✓ —— 契约 §7.1 ✓）
    server.listen(opts.port, opts.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : opts.port;

  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: McpHttpOptions,
): Promise<void> {
  // ── ① `Origin`**（存在且不合法 → 403 ✓）──
  const origin = req.headers['origin'];
  if (!checkOrigin(typeof origin === 'string' ? origin : undefined)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end('{"error":"forbidden_origin"}');
    return;
  }

  // ── ② `Host`**（只接受本机 + 同一个端口 ✓）──
  const host = req.headers['host'];
  const port = serverPort(req, opts);
  if (!checkHost(typeof host === 'string' ? host : undefined, port)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end('{"error":"forbidden_host"}');
    return;
  }

  // ── ③ Bearer token** ──
  const auth = req.headers['authorization'];
  if (!checkAuthorization(typeof auth === 'string' ? auth : undefined, opts.token)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"error":"unauthorized"}');
    return;
  }

  // ── ④ 协议版本头** ──
  const version = req.headers['mcp-protocol-version'];
  if (typeof version === 'string' && !SUPPORTED_VERSIONS.has(version)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end('{"error":"unsupported_protocol_version"}');
    return;
  }

  // ── 路径不对 → 404** ──
  const path = (req.url ?? '').split('?')[0];
  if (path !== MCP_ENDPOINT) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not_found"}');
    return;
  }

  // ── `GET` → 本轮不提供 SSE → 405**（规范允许 ✓）──
  if (req.method === 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
    res.end('{"error":"method_not_allowed"}');
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
    res.end('{"error":"method_not_allowed"}');
    return;
  }

  // ── 解析 JSON-RPC ──
  let message: unknown;
  try {
    const raw = await readBody(req);
    message = JSON.parse(raw) as unknown;
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end('{"error":"parse_error"}');
    return;
  }
  if (typeof message !== 'object' || message === null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end('{"error":"invalid_request"}');
    return;
  }

  const reply = await opts.mcp.handle(message as Parameters<McpServer['handle']>[0]);

  // ── **通知** → 202 空体**（规范 §「Sending Messages」第 4 条 ✓）──
  if (reply === null) {
    res.writeHead(202);
    res.end();
    return;
  }

  // ── **请求** → 200 + 一个 JSON 对象**（规范允许 JSON 或 SSE ✓，本轮选 JSON ✓）──
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(reply));
}

/**
 * 这个请求实际打到了**哪个端口** ✓。
 *
 * → **从 socket 上问** ✓ —— 不能信 `Host` 头 ✓（那正是我们要校验的东西 ✓）。
 */
function serverPort(req: IncomingMessage, opts: McpHttpOptions): number {
  const socket = req.socket.localPort;
  return socket ?? opts.port;
}
