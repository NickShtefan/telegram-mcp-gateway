/**
 * stdio proxy for clients that can only launch a process.
 * Never open Telegram sessions: read JSON-RPC from stdin, forward it
 * to the HTTP daemon, and write responses to stdout. One process
 * continues owning the session (decisions 1 and 17).
 *
 * stdout contains JSON-RPC only; everything else goes to stderr.
 */
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { Logger } from '../core/log.js';

export interface StdioProxyOptions {
  /** Daemon URL, e.g. http://127.0.0.1:7777/mcp. */
  url: string;
  token: string;
  input: Readable;
  output: Writable;
  log: Logger;
  fetch?: typeof fetch;
  /** Timeout for one daemon response. */
  timeoutMs?: number;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  result?: { protocolVersion?: string };
}

function hasId(message: unknown): message is RpcMessage & { id: string | number } {
  const id = (message as RpcMessage | null)?.id;
  return typeof id === 'string' || typeof id === 'number';
}

/** Messages from response bodies: plain JSON or event streams. */
export function parseResponseBody(contentType: string, text: string): unknown[] {
  if (contentType.includes('text/event-stream')) {
    const out: unknown[] = [];
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      try {
        out.push(JSON.parse(data));
      } catch {
        // Non-JSON stream housekeeping event.
      }
    }
    return out;
  }
  if (!text.trim()) return [];
  const parsed = JSON.parse(text) as unknown;
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Forward messages until stdin closes. */
export async function runStdioProxy(options: StdioProxyOptions): Promise<void> {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;
  let protocolVersion: string | null = null;
  const pending = new Set<Promise<void>>();

  const write = (message: unknown): void => {
    options.output.write(JSON.stringify(message) + '\n');
  };

  const fail = (message: unknown, text: string): void => {
    const list = Array.isArray(message) ? message : [message];
    for (const m of list) {
      if (hasId(m)) write({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: text } });
    }
  };

  const forward = async (line: string): Promise<void> => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: not valid JSON.' } });
      return;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${options.token}`,
    };
    if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;

    let response: Response;
    try {
      response = await doFetch(options.url, { method: 'POST', headers, body: line, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      options.log.warn('daemon is not reachable', { url: options.url, error: (err as Error).message });
      fail(message, `The tg-mcp daemon is not reachable at ${options.url}. The owner has to start it (tg-mcp serve).`);
      return;
    }

    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      options.log.warn('daemon closed the connection mid-response', { error: (err as Error).message });
      fail(message, 'The tg-mcp daemon closed the connection before answering. It may be restarting: repeat the call.');
      return;
    }
    if (response.status === 401) {
      fail(message, 'The tg-mcp daemon rejected the token. Check TG_MCP_TOKEN.');
      return;
    }
    if (response.status === 202) return;
    if (text.trim() === '') {
      if (!response.ok) fail(message, `The tg-mcp daemon answered HTTP ${response.status}.`);
      return;
    }

    let replies: unknown[];
    try {
      replies = parseResponseBody(response.headers.get('content-type') ?? '', text);
    } catch {
      fail(message, `The tg-mcp daemon returned an unreadable response (HTTP ${response.status}).`);
      return;
    }

    for (const reply of replies) {
      const version = (reply as RpcMessage | null)?.result?.protocolVersion;
      if (typeof version === 'string' && (message as RpcMessage).method === 'initialize') protocolVersion = version;
      // HTTP errors without a response ID belong to the originating request.
      if (!response.ok && (reply as RpcMessage | null)?.id === null && hasId(message)) {
        write({ ...(reply as object), id: message.id });
      } else {
        write(reply);
      }
    }
  };

  const lines = createInterface({ input: options.input, crlfDelay: Infinity });
  for await (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const task = forward(line).catch(err => {
      options.log.error('proxy failed', { error: (err as Error).message });
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
    // initialize must finish first; subsequent messages depend on its protocol version.
    if (protocolVersion === null) await task;
  }
  await Promise.all(pending);
}
