import { request } from 'node:http';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestGateway, type TestGateway } from '../../__tests__/helpers/gateway.js';
import { runServe } from '../../cli/serve.js';
import { isLockHeld } from '../../core/lock.js';
import { createLogger } from '../../core/log.js';
import { SqliteStorage } from '../../storage/sqlite.js';
import { allowedHosts, bearerToken, startHttpServer, type RunningHttpServer } from '../http.js';
import { parseResponseBody, runStdioProxy } from '../stdio.js';

const silent = createLogger('test', { level: 'silent' });
let gw: TestGateway;
let http: RunningHttpServer;
let url: string;

beforeEach(async () => {
  gw = makeTestGateway();
  http = await startHttpServer({ services: gw.services, host: '127.0.0.1', port: 0, toolsets: ['core'], version: 'test', log: silent });
  url = `http://127.0.0.1:${http.port}/mcp`;
});

afterEach(async () => {
  await http.close();
  gw.cleanup();
});

/** Request with arbitrary headers: fetch does not allow overriding Host. */
function raw(method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: http.port, method, path, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } };

describe('HTTP: daemon entry point', () => {
  it('healthz needs no token and reveals no account information', async () => {
    const res = await fetch(`http://127.0.0.1:${http.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns 401 for missing or invalid tokens', async () => {
    const variants: Array<Record<string, string>> = [{}, { Authorization: 'Bearer ' + 'x'.repeat(43) }, { Authorization: 'Basic abc' }];
    for (const headers of variants) {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(initialize) });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('Bearer');
    }
  });

  it('rejects foreign Host headers and browser requests', async () => {
    const auth = { Authorization: `Bearer ${gw.tokens.user_a}`, 'Content-Type': 'application/json' };
    const rebinding = await raw('POST', '/mcp', { ...auth, Host: 'evil.example.com' }, JSON.stringify(initialize));
    expect(rebinding.status).toBe(403);
    const browser = await raw('POST', '/mcp', { ...auth, Host: `127.0.0.1:${http.port}`, Origin: 'https://evil.example.com' }, JSON.stringify(initialize));
    expect(browser.status).toBe(403);
    const localhost = await raw('POST', '/mcp', { ...auth, Host: `localhost:${http.port}`, Accept: 'application/json, text/event-stream' }, JSON.stringify(initialize));
    expect(localhost.status).toBe(200);
  });

  it('rejects GET and reports invalid bodies and unknown paths clearly', async () => {
    const auth = { Authorization: `Bearer ${gw.tokens.user_a}` };
    const get = await fetch(url, { headers: auth });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    const bad = await fetch(url, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{not json' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: number } }).error.code).toBe(-32700);
    expect((await fetch(`http://127.0.0.1:${http.port}/other`, { headers: auth })).status).toBe(404);
  });

  it('returns 413 for oversized bodies rather than dropping the connection', async () => {
    const small = await startHttpServer({ services: gw.services, host: '127.0.0.1', port: 0, toolsets: ['core'], version: 'test', log: silent, maxBodyBytes: 2_000 });
    try {
      const response = await fetch(`http://127.0.0.1:${small.port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gw.tokens.user_a}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { text: 'x'.repeat(300_000) } }),
      });
      expect(response.status).toBe(413);
      expect(await response.text()).toContain('too large');
    } finally {
      await small.close();
    }
  });

  it('drops a body beyond the discard bound instead of reading it forever, and keeps serving', async () => {
    const small = await startHttpServer({ services: gw.services, host: '127.0.0.1', port: 0, toolsets: ['core'], version: 'test', log: silent, maxBodyBytes: 2_000 });
    try {
      await expect(fetch(`http://127.0.0.1:${small.port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gw.tokens.user_a}` },
        body: 'x'.repeat(9 * 1024 * 1024),
      })).rejects.toThrow();
      expect((await fetch(`http://127.0.0.1:${small.port}/healthz`)).status).toBe(200);
    } finally {
      await small.close();
    }
  });

  it('MCP HTTP client: the token identifies the user', async () => {
    const connect = async (token: string) => {
      const client = new Client({ name: 'agent', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      return client;
    };
    const user_a = await connect(gw.tokens.user_a);
    const user_b = await connect(gw.tokens.user_b);
    expect((await user_a.listTools()).tools).toHaveLength(11);
    const text = async (c: Client) => ((await c.callTool({ name: 'tg_status', arguments: {} })) as { content: Array<{ text: string }> }).content[0]!.text;
    expect(await text(user_a)).toContain('Gateway user: user_a');
    expect(await text(user_b)).toContain('Gateway user: user_b');
    expect(user_a.getInstructions()).toContain('Telegram gateway');
    await user_a.close();
    await user_b.close();
  });

  it('parses headers', () => {
    expect(bearerToken({ headers: { authorization: 'Bearer abc' } } as never)).toBe('abc');
    expect(bearerToken({ headers: { authorization: 'bearer   abc  ' } } as never)).toBe('abc');
    expect(bearerToken({ headers: {} } as never)).toBeNull();
    expect([...allowedHosts('127.0.0.1', 7777)].sort()).toEqual(['127.0.0.1:7777', '[::1]:7777', 'localhost:7777']);
    expect(allowedHosts('10.0.0.5', 7777).has('10.0.0.5:7777')).toBe(true);
    expect(allowedHosts('0.0.0.0', 7777).has('0.0.0.0:7777')).toBe(false);
  });
});

describe('stdio proxy', () => {
  async function run(lines: string[], options: { token?: string; target?: string } = {}): Promise<Array<Record<string, unknown>>> {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', c => chunks.push(c as Buffer));
    const done = runStdioProxy({ url: options.target ?? url, token: options.token ?? gw.tokens.user_a, input, output, log: silent, timeoutMs: 5_000 });
    for (const line of lines) input.write(line + '\n');
    input.end();
    await done;
    return Buffer.concat(chunks)
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as Record<string, unknown>);
  }

  it('proxies requests and writes only JSON-RPC to stdout', async () => {
    const replies = await run([
      JSON.stringify(initialize),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      '',
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tg_status', arguments: {} } }),
    ]);
    expect(replies).toHaveLength(3);
    const byId = new Map(replies.map(r => [r.id, r]));
    expect((byId.get(1)!.result as { serverInfo: { name: string } }).serverInfo.name).toBe('telegram-gateway');
    expect((byId.get(2)!.result as { tools: unknown[] }).tools).toHaveLength(11);
    expect(JSON.stringify(byId.get(3))).toContain('Gateway user: user_a');
  });

  it('unavailable daemon: requests fail and notifications stay silent', async () => {
    const replies = await run([JSON.stringify(initialize), JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })], { target: 'http://127.0.0.1:9/mcp' });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ id: 1, error: { code: -32000 } });
    expect(JSON.stringify(replies[0])).toContain('daemon is not reachable');
  });

  it('rejects invalid tokens and malformed input', async () => {
    const denied = await run([JSON.stringify(initialize)], { token: 'wrong-token-wrong-token' });
    expect(JSON.stringify(denied[0])).toContain('rejected the token');
    const garbage = await run(['{not json']);
    expect(garbage[0]).toMatchObject({ id: null, error: { code: -32700 } });
  });

  it('reports empty HTTP errors and interrupted responses as request errors', async () => {
    const proxy = async (fetchImpl: typeof fetch): Promise<Array<Record<string, unknown>>> => {
      const input = new PassThrough();
      const output = new PassThrough();
      const chunks: Buffer[] = [];
      output.on('data', c => chunks.push(c as Buffer));
      const done = runStdioProxy({ url, token: gw.tokens.user_a, input, output, log: silent, fetch: fetchImpl });
      input.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }) + '\n');
      input.end();
      await done;
      return Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>);
    };

    const empty = await proxy((async () => new Response('', { status: 502 })) as never);
    expect(empty).toHaveLength(1);
    expect(empty[0]).toMatchObject({ id: 7, error: { code: -32000 } });
    expect(JSON.stringify(empty[0])).toContain('HTTP 502');

    const broken = await proxy(
      (async () => ({ status: 200, ok: true, headers: new Headers(), text: async () => Promise.reject(new Error('terminated')) })) as never,
    );
    expect(broken[0]).toMatchObject({ id: 7, error: { code: -32000 } });
    expect(JSON.stringify(broken[0])).toContain('closed the connection');
  });

  it('parses event-stream responses', () => {
    expect(parseResponseBody('text/event-stream', 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n')).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
    expect(parseResponseBody('application/json', '[{"id":1},{"id":2}]')).toHaveLength(2);
    expect(parseResponseBody('application/json', '')).toEqual([]);
  });
});

describe('serve', () => {
  it('does not listen remotely without explicit owner permission', async () => {
    const io = { out: () => undefined, err: () => undefined, prompt: async () => '' };
    delete process.env.TG_MCP_ALLOW_REMOTE;
    await expect(runServe({ config: { ...gw.config, host: '0.0.0.0', port: 0 }, io, version: 'test', overrides: { storage: new SqliteStorage({ path: ':memory:' }) }, log: silent })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining('plain HTTP'),
    });
    expect(await isLockHeld(gw.config.home)).toBe(false);
  });

  it('starts the daemon under a lock and releases it on stop', async () => {
    const storage = new SqliteStorage({ path: ':memory:' });
    const controller = new AbortController();
    const err: string[] = [];
    let port = 0;
    const ready = new Promise<void>(resolve => {
      void runServe({
        config: { ...gw.config, port: 0 },
        io: { out: () => undefined, err: l => err.push(l), prompt: async () => '' },
        version: 'test',
        signal: controller.signal,
        overrides: { storage },
        log: silent,
        onReady: info => {
          port = info.port;
          resolve();
        },
      }).then(code => {
        expect(code).toBe(0);
        resolve();
      });
    });
    await ready;
    expect(port).toBeGreaterThan(0);
    expect(err.join('\n')).toContain(`listening on http://127.0.0.1:${port}/mcp`);
    expect(await isLockHeld(gw.config.home)).toBe(true);
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);

    // A second daemon cannot start on the same sessions.
    await expect(
      runServe({ config: { ...gw.config, port: 0 }, io: { out: () => undefined, err: () => undefined, prompt: async () => '' }, version: 'test', overrides: { storage: new SqliteStorage({ path: ':memory:' }) }, log: silent }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });

    controller.abort();
    await new Promise(r => setTimeout(r, 100));
    expect(await isLockHeld(gw.config.home)).toBe(false);
  });
});
