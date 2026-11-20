import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  checkAuthorization,
  checkHost,
  checkOrigin,
  MCP_PROTOCOL_VERSION,
} from './security';
import type { McpServer } from './server';

/**
 * The **HTTP transport of the MCP** (contract `spec/04` §7.1 ✓ · MCP
 * specification 2025-06-18 ✓).
 *
 * ── Why `node:http` and not a framework ──
 *
 * This project has **zero web framework dependencies** ✓ (none of the 7
 * dependencies in `package.json` is a web framework ✓), and this layer only
 * has to "receive one JSON-RPC message and answer with a JSON" ✓ — a
 * framework would not add anything ✓.
 *
 * ── The security baseline (the hard requirements of contract §7.1 ✓) ──
 *
 * | Order | Check | When it fails |
 * |---|---|---|
 * | 1 | **`Origin`** ✓ (it is there and not legitimate ✓) | **403** ✓ |
 * | 2 | **`Host`** ✓ (only `127.0.0.1:<port>` / `localhost:<port>` are accepted ✓) | **403** ✓ |
 * | 3 | **The bearer token** ✓ | **401** ✓ |
 * | 4 | **The protocol version header** ✓ | **400** ✓ |
 *
 * → **The order matters** ✓: `Origin`/`Host` first ✓ (they block the
 *   **browser** ✓), the token after ✓ (it blocks **everybody else** ✓) → the
 *   two block different attack surfaces ✓.
 *
 * → **Not a single CORS header is sent** ✓ (contract §7.1 ✓ — no cross-origin
 *   allowance ✓).
 */
export interface McpHttpOptions {
  mcp: McpServer;
  /** The bearer token of this start ✓ */
  token: string;
  /** The address it listens on (**only 127.0.0.1 is allowed** ✓ — another one has to be refused ✓) */
  host: string;
  /** The port it listens on (**0 = let the OS assign it** ✓ — that avoids a collision when it is started twice ✓) */
  port: number;
}

export interface McpHttpHandle {
  server: Server;
  /** The port it really listens on (**it is the one the OS gave when 0 was passed** ✓) */
  port: number;
  close: () => Promise<void>;
}

/** The path of the endpoint (**one** ✓ — the specification: "MUST provide a single HTTP endpoint path" ✓) */
export const MCP_ENDPOINT = '/mcp';

/** The protocol version we support (**another version → 400** ✓ — the specification §"Protocol Version Header" ✓) */
const SUPPORTED_VERSIONS = new Set([MCP_PROTOCOL_VERSION]);

/** Reads the body of the request (**there is an upper bound** ✓ — nobody should be able to pour a megabyte into the memory) */
const MAX_BODY_BYTES = 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * **Starts an HTTP service for the MCP** ✓.
 *
 * → **Only binds 127.0.0.1** ✓ (contract §7.1 ✓) — another host is
 *   **refused directly** ✓ (and not "bind it and see" ✗ — by then it is too
 *   late ✓).
 */
export async function startMcpHttp(opts: McpHttpOptions): Promise<McpHttpHandle> {
  if (opts.host !== '127.0.0.1' && opts.host !== 'localhost' && opts.host !== '::1') {
    throw new Error(`The MCP server may only bind to localhost (contract §7.1 ✓), got: ${opts.host}`);
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
    // **Only the loopback is bound** ✓ (**not 0.0.0.0** ✓ — contract §7.1 ✓)
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
  // ── ① `Origin`** (it is there and not legitimate → 403 ✓) ──
  const origin = req.headers['origin'];
  if (!checkOrigin(typeof origin === 'string' ? origin : undefined)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end('{"error":"forbidden_origin"}');
    return;
  }

  // ── ② `Host`** (only the local machine + the same port are accepted ✓) ──
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

  // ── ④ The protocol version header** ──
  const version = req.headers['mcp-protocol-version'];
  if (typeof version === 'string' && !SUPPORTED_VERSIONS.has(version)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end('{"error":"unsupported_protocol_version"}');
    return;
  }

  // ── The path is wrong → 404** ──
  const path = (req.url ?? '').split('?')[0];
  if (path !== MCP_ENDPOINT) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not_found"}');
    return;
  }

  // ── `GET` → no SSE in this round → 405** (the specification allows it ✓) ──
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

  // ── Parse the JSON-RPC ──
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

  // ── A **notification** → 202 with an empty body** (the specification §"Sending Messages", point 4 ✓) ──
  if (reply === null) {
    res.writeHead(202);
    res.end();
    return;
  }

  // ── A **request** → 200 + one JSON object** (the specification allows JSON or SSE ✓, this round chooses JSON ✓) ──
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(reply));
}

/**
 * The port this request actually reached ✓.
 *
 * → **Asked from the socket** ✓ — the `Host` header cannot be trusted ✓
 *   (that is exactly what is being validated ✓).
 */
function serverPort(req: IncomingMessage, opts: McpHttpOptions): number {
  const socket = req.socket.localPort;
  return socket ?? opts.port;
}
