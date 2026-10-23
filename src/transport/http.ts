/**
 * Streamable HTTP: main daemon entry point. Listen on localhost and identify
 * users by bearer token (decision 16).
 *
 * Stateless: each request gets its own MCP server and transport. After
 * watchdog exit and supervisor restart, the client can simply retry
 * without restoring a transport session.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isGatewayError } from '../core/errors.js';
import type { Logger } from '../core/log.js';
import { createMcpServer } from '../mcp/server.js';
import type { Principal } from '../policy/access.js';
import type { GatewayServices } from '../services/index.js';

export interface HttpServerOptions {
  services: GatewayServices;
  host: string;
  port: number;
  toolsets: string[];
  version: string;
  log: Logger;
  /** Allowed Origin headers; browser requests are rejected by default. */
  allowedOrigins?: string[];
  maxBodyBytes?: number;
}

export interface RunningHttpServer {
  port: number;
  host: string;
  close(): Promise<void>;
}

const DEFAULT_MAX_BODY = 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function rpcError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code: -32000, message }, id: null }, headers);
}

export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const m = header.match(/^Bearer\s+(\S+)\s*$/i);
  return m ? m[1]! : null;
}

/** Allowed daemon Host headers: DNS rebinding protection. */
export function allowedHosts(host: string, port: number): Set<string> {
  const names = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (host && host !== '0.0.0.0' && host !== '::') names.add(host.includes(':') && !host.startsWith('[') ? `[${host}]` : host);
  const out = new Set<string>();
  for (const name of names) {
    out.add(`${name}:${port}`);
    if (port === 80) out.add(name);
  }
  return out;
}

/** Oversized request bytes discarded before answering 413; past this bound or time the connection is dropped. */
const MAX_DISCARD_BYTES = 8 * 1024 * 1024;
const DISCARD_MS = 10_000;

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let discarding: NodeJS.Timeout | undefined;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) { chunks.push(chunk); return; }
      // Answer 413 only after the client has finished sending: closing a socket with unread request
      // bytes makes Windows reset it, and the reset discards the response before the client reads it.
      if (!discarding) { chunks.length = 0; discarding = setTimeout(() => req.destroy(), DISCARD_MS); discarding.unref(); }
      if (size > limit + MAX_DISCARD_BYTES) req.destroy();
    });
    req.on('end', () => {
      clearTimeout(discarding);
      if (size > limit) reject(new Error('body too large')); else resolve(Buffer.concat(chunks));
    });
    req.on('error', err => { clearTimeout(discarding); reject(err); });
    req.on('close', () => { clearTimeout(discarding); reject(new Error('body dropped')); });
  });
}

export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const { services, log } = options;
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const origins = new Set(options.allowedOrigins ?? []);
  let hosts = allowedHosts(options.host, options.port);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '/').split('?')[0];

    if (path === '/healthz') {
      // Liveness only: no account information without authentication.
      return sendJson(res, 200, { ok: true });
    }
    if (path !== '/mcp') return rpcError(res, 404, 'Not found. The MCP endpoint is /mcp.');

    const hostHeader = (req.headers.host ?? '').toLowerCase();
    if (!hosts.has(hostHeader)) return rpcError(res, 403, 'Forbidden host.');
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin !== '' && !origins.has(origin)) {
      return rpcError(res, 403, 'Requests from browsers are not allowed for this origin.');
    }

    let principal: Principal;
    try {
      principal = services.access.authenticate(bearerToken(req));
    } catch {
      return rpcError(res, 401, 'Missing or invalid gateway token.', { 'WWW-Authenticate': 'Bearer realm="tg-mcp"' });
    }

    if (req.method !== 'POST') {
      // Stateless transport holds no event stream; GET and DELETE are unsupported.
      return rpcError(res, 405, 'Method not allowed. Use POST.', { Allow: 'POST' });
    }

    let body: unknown;
    try {
      body = JSON.parse((await readBody(req, maxBody)).toString('utf8'));
    } catch (err) {
      // An oversized body beyond the discard bound, or a stalled one, has no reader left for a response.
      if ((err as Error).message === 'body dropped') return;
      const tooLarge = (err as Error).message === 'body too large';
      return sendJson(res, tooLarge ? 413 : 400, {
        jsonrpc: '2.0',
        error: { code: tooLarge ? -32000 : -32700, message: tooLarge ? 'Request body is too large.' : 'Parse error: body is not valid JSON.' },
        id: null,
      }, tooLarge ? { Connection: 'close' } : {});
    }

    const { server } = createMcpServer({
      services,
      principal,
      toolsets: options.toolsets,
      version: options.version,
      log: log.child('mcp'),
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(err => {
      log.error('http request failed', { error: isGatewayError(err) ? err.message : ((err as Error)?.stack ?? String(err)) });
      if (!res.headersSent) rpcError(res, 500, 'Internal gateway error.');
      else res.end();
    });
  });
  // Open client connections must not prevent daemon shutdown.
  server.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  hosts = allowedHosts(options.host, port);
  log.info('listening', { host: options.host, port, toolsets: options.toolsets.join(',') });

  return {
    port,
    host: options.host,
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
