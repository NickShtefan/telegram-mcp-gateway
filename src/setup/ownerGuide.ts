/** Temporary human-only loopback UI. It never opens Telegram or reads stored credentials. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import qrcode from 'qrcode-generator';
import { z } from 'zod';
import type { CliIo } from '../cli/io.js';
import { normalizePhone } from '../core/auth.js';
import { SetupError } from './contract.js';
import { answerOwnerPrompt, ownerClients } from './presentation.js';
import { qrMessageSchema, type OwnerQuestion } from './promptChannel.js';
import { ownerGuidePage } from './ownerGuidePage.js';
import { CLIENT_KINDS, clientListSchema, type ClientKind } from './clientCatalog.js';

export type GuideQuestion = OwnerQuestion | 'clients' | 'replace_client';
export interface OwnerLoginUi {
  readonly signal: AbortSignal;
  answer(question: GuideQuestion, signal: AbortSignal, client?: ClientKind): Promise<string>;
  qr(code: { token: string; expires: number }): void;
  finish(ok: boolean, clients?: ClientKind[]): void;
  close(): Promise<void>;
}
interface GuideState {
  phase: 'waiting' | 'prompt' | 'working' | 'qr' | 'complete' | 'failed' | 'cancelled';
  sequence: number;
  question?: GuideQuestion;
  client?: ClientKind;
  clients?: ClientKind[];
  qrImage?: string;
  expires?: number;
}
export interface OwnerGuide extends OwnerLoginUi {
  /** Private launch URL. Never log or include it in public progress. */
  readonly url: string;
}
const answerSchema = z.strictObject({ sequence: z.number().int().positive(), value: z.string().min(1).max(512) });
function validAnswer(question: GuideQuestion, value: string): boolean {
  if (question === 'clients') { try { return clientListSchema.safeParse(JSON.parse(value)).success; } catch { return false; } }
  if (question === 'replace_client') return value === 'REPLACE' || value === 'cancel';
  if (question === 'api_id') return /^[0-9]{1,15}$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
  if (question === 'api_hash') return /^[0-9a-f]{32}$/.test(value);
  if (question === 'login_method') return value === 'qr' || value === 'phone';
  if (question === 'phone') { try { normalizePhone(value); return true; } catch { return false; } }
  return value.length > 0 && value.length <= 512;
}
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) {
    length += Buffer.byteLength(chunk);
    if (length > 2048) throw new SetupError('invalid_request');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function startOwnerGuide(timeoutMs = 10 * 60_000): Promise<OwnerGuide> {
  const capability = randomBytes(32).toString('hex');
  const nonce = randomBytes(24).toString('base64');
  const life = new AbortController();
  let state: GuideState = { phase: 'waiting', sequence: 0 };
  let pending: { question: GuideQuestion; resolve(value: string): void; reject(error: Error): void } | null = null;
  let origin = ''; let closed = false;
  const cancel = (): void => {
    if (closed || state.phase === 'complete' || state.phase === 'failed') return;
    state = { phase: 'cancelled', sequence: state.sequence };
    life.abort(); pending?.reject(new SetupError('invalid_state')); pending = null;
  };
  const server = createServer((req, res) => { void handle(req, res); });
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.maxHeadersCount = 32;
  const json = (res: ServerResponse, code: number, value: unknown): void => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value));
  };
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    if (req.headers.host !== origin.slice(7) || (req.headers.origin !== undefined && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') {
      json(res, 403, { error: 'forbidden' }); return;
    }
    if (req.url === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(ownerGuidePage(nonce)); return;
    }
    const supplied = req.headers['x-setup-token'];
    if (typeof supplied !== 'string' || !/^[0-9a-f]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(capability))) {
      json(res, 403, { error: 'forbidden' }); return;
    }
    if (req.url === '/api/status' && req.method === 'GET') { json(res, 200, state); return; }
    if (req.method !== 'POST' || req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') {
      json(res, 403, { error: 'forbidden' }); return;
    }
    try {
      if (req.url === '/api/cancel') {
        if (Object.keys(z.object({}).strict().parse(await body(req))).length) throw new SetupError('invalid_request');
        cancel(); json(res, 200, { ok: true }); return;
      }
      if (req.url !== '/api/answer') { json(res, 404, { error: 'not_found' }); return; }
      const answer = answerSchema.parse(await body(req));
      if (!pending || answer.sequence !== state.sequence || state.phase !== 'prompt') { json(res, 409, { error: 'stale_step' }); return; }
      if (!validAnswer(pending.question, answer.value)) { json(res, 400, { error: 'invalid_value' }); return; }
      const next = pending; pending = null;
      state = { phase: 'working', sequence: state.sequence };
      next.resolve(answer.value); json(res, 200, { ok: true });
    } catch { json(res, 400, { error: 'invalid_request' }); }
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new SetupError('invalid_state');
  origin = `http://127.0.0.1:${address.port}`;
  const timer = setTimeout(cancel, timeoutMs); timer.unref();
  return {
    url: `${origin}/#${capability}`, signal: life.signal,
    answer: async (question, signal, client) => {
      if (closed || life.signal.aborted || signal.aborted || pending || state.phase === 'complete' || state.phase === 'failed') throw new SetupError('invalid_state');
      if (question === 'replace_client' && (!client || !CLIENT_KINDS.includes(client))) throw new SetupError('invalid_state');
      state = { phase: 'prompt', question, sequence: state.sequence + 1, ...(client ? { client } : {}) };
      return new Promise<string>((resolve, reject) => {
        const aborted = (): void => { pending = null; reject(new SetupError('invalid_state')); };
        signal.addEventListener('abort', aborted, { once: true });
        pending = { question, resolve: value => { signal.removeEventListener('abort', aborted); resolve(value); },
          reject: error => { signal.removeEventListener('abort', aborted); reject(error); } };
      });
    },
    qr: code => {
      if (closed || life.signal.aborted || pending || state.phase !== 'working' && state.phase !== 'qr') throw new SetupError('invalid_state');
      const parsed = qrMessageSchema.parse({ kind: 'qr', ...code });
      const qr = qrcode(0, 'M'); qr.addData(`tg://login?token=${parsed.token}`); qr.make();
      state = { phase: 'qr', sequence: state.sequence, expires: parsed.expires,
        qrImage: 'data:image/svg+xml;base64,' + Buffer.from(qr.createSvgTag({ cellSize: 6, margin: 24, scalable: true })).toString('base64') };
    },
    finish: (ok, clients = []) => {
      if (!life.signal.aborted && state.phase !== 'complete' && state.phase !== 'failed') {
        pending?.reject(new SetupError('invalid_state')); pending = null;
        state = { phase: ok ? 'complete' : 'failed', sequence: state.sequence, clients: clientListSchema.parse(clients) };
      }
      clearTimeout(timer);
    },
    close: async () => {
      if (closed) return; cancel(); closed = true; clearTimeout(timer); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

/** Launch only fixed OS programs, as the original user, without a shell or URL logging. */
export async function openOwnerBrowser(url: string): Promise<void> {
  const command = process.platform === 'darwin' ? '/usr/bin/open' : process.platform === 'win32'
    ? 'C:\\Windows\\System32\\rundll32.exe' : '/usr/bin/xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await promisify(execFile)(command, args, { timeout: 10000, maxBuffer: 1024, windowsHide: true });
}

/** No server is created until the protected worker actually requests human input. */
export function browserOwnerLogin(io: CliIo, openBrowser = openOwnerBrowser): OwnerLoginUi {
  let guide: OwnerGuide | null = null; let fallback = false;
  const life = new AbortController();
  return {
    signal: life.signal,
    answer: async (question, signal, client) => {
      if (!guide && !fallback) {
        guide = await startOwnerGuide(); guide.signal.addEventListener('abort', () => life.abort(), { once: true });
        try { await openBrowser(guide.url); io.err('Continue in the local setup page opened in your browser. Keep this terminal open.'); }
        catch {
          // Closing a failed browser launch must not cancel the console fallback.
          const failed = guide; guide = null; fallback = true;
          failed.finish(false); await failed.close();
          io.err('The browser could not be opened. Continuing with hidden console prompts.');
        }
      }
      if (guide) return guide.answer(question, signal, client);
      if (question === 'clients') return JSON.stringify(await ownerClients(io, signal));
      if (question === 'replace_client') return io.prompt(`Type REPLACE to update the gateway entry for ${client}, or cancel: `, { signal });
      if (question === 'login_method') return 'phone';
      return answerOwnerPrompt(io, question, signal);
    },
    qr: code => { if (!guide) throw new SetupError('invalid_state'); guide.qr(code); },
    finish: (ok, clients) => guide?.finish(ok, clients),
    close: async () => { if (guide) { await guide.close(); guide = null; } },
  };
}
