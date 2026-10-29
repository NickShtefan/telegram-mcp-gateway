/** Original-user side of owner setup after local checks. The elevated peer exchanges only closed private protocol frames. */
import type { Readable, Writable } from 'node:stream';
import type { CliIo } from '../cli/io.js';
import { sha256Hex } from '../core/crypto.js';
import type { InstallLayout } from '../install/platform.js';
import type { OwnerPlan } from './owner.js';
import { ClientEntryConflict, type ClientKind } from './clientConfig.js';
import { privateExchange, sendPrivate, workerMessageSchema } from './promptChannel.js';
import { answerOwnerPrompt, elevationNotice, nextSteps, ownerClients } from './presentation.js';
import { SetupError } from './contract.js';
import { ownerOperationId, validatedClientHandoff } from './clientHandoff.js';
import { TerminalProgress } from '../cli/progress.js';
import type { OwnerLoginUi } from './ownerGuide.js';
import { clientListSchema } from './clientCatalog.js';

/** Elevated coordinator channel: sudo pipes on macOS/Linux, the approved broker's named pipe on Windows. */
export interface ElevatedPeer { input: Readable; output: Writable; closing(): Promise<number | null>; }
export interface OwnerConversation {
  io: CliIo; platform: InstallLayout['platform']; sha: string; preview: OwnerPlan; rerunCommand: string;
  /** Starts the elevated coordinator; the operating system asks for administrator approval here. */
  elevate(): Promise<ElevatedPeer>;
  existingTokens(port: number): Promise<string[]>;
  configure(client: ClientKind, port: number, token: string, replace: boolean): Promise<void>;
  probe(port: number, token: string): Promise<boolean>;
  loginUi?: OwnerLoginUi;
  /** Called only after OS-confirmed coordinator exit and its protected cleanup. */
  onClosed?(): void;
}

/** Human-requested mode changes restart only after the old coordinator and session worker are gone. */
export async function runOwnerAttempts(c: OwnerConversation): Promise<number> {
  for (let attempt = 0; attempt < 12; attempt++) {
    let closed = false;
    try { return await runOwnerConversation({ ...c, onClosed: () => { closed = true; c.onClosed?.(); } }); }
    catch (error) {
      if (!closed) throw error;
      const next = await c.loginUi?.takeRetry?.(); if (!next) throw error;
      c.preview.browser_login = next.mode === 'browser';
      if (next.mode === 'console') c.preview.clients.splice(0, c.preview.clients.length, ...await ownerClients(c.io));
      c.io.err('The previous login process has stopped. Continuing setup with the selected method...');
    }
  }
  throw new SetupError('invalid_state');
}

export async function runOwnerConversation(c: OwnerConversation): Promise<number> {
  const { io, preview } = c;
  for (const line of elevationNotice(c.platform)) io.err(line);
  // sudo/UAC owns its prompt. Do not write timer messages while the owner may
  // be entering the system password; start waiting feedback after its profile.
  if (io.interactive) io.err('Waiting for system approval and checking the installed gateway...');
  const { input, output, closing } = await c.elevate();
  const progress = new TerminalProgress(line => io.err(line), io.interactive === true);
  const cancelled = (): void => { input.destroy(new SetupError('invalid_state')); };
  c.loginUi?.signal.addEventListener('abort', cancelled, { once: true });
  let closed: Promise<number | null> | undefined; const close = (): Promise<number | null> => closed ??= closing().then(code => { c.onClosed?.(); return code; });
  // The coordinator's input ends with its final frame, so its pending read cannot keep it (and sudo) alive.
  const exchange = privateExchange(input, output);
  const life = new AbortController(); input.once('end', () => life.abort()); input.once('close', () => life.abort()); input.once('error', () => life.abort());
  if (c.loginUi?.signal.aborted) cancelled();
  let result: Extract<ReturnType<typeof workerMessageSchema.parse>, { kind: 'result' }> | null = null;
  let setupId: string | null = null; let port = 0; let token: string | null = null; let sequence = 0; let verified=false; let finished=false; let selected=false;
  try {
    for await (const line of exchange.frames) {
      const message = workerMessageSchema.parse(JSON.parse(line));
      if (result) throw new SetupError('invalid_state');
      if (message.kind === 'profile') {
        if (setupId) throw new SetupError('invalid_state'); setupId = ownerOperationId(c.sha, preview.user); port = message.port;
        progress.start('Preparing your Telegram account and the gateway service...');
        const existingTokens = await c.existingTokens(port);
        await sendPrivate(output, { kind: 'plan', plan: { ...preview, setup_id: setupId }, existing_tokens: existingTokens });
      } else if (message.kind === 'client_selection') {
        if (!setupId || token || selected || !preview.browser_login || !c.loginUi) throw new SetupError('invalid_state');
        selected = true; progress.stop();
        const clients = clientListSchema.parse(JSON.parse(await c.loginUi.answer('clients', life.signal)));
        // The profile adapter holds this same array, so its override checks follow the human selection.
        preview.clients.splice(0, preview.clients.length, ...clients);
        const existingTokens = await c.existingTokens(port);
        await sendPrivate(output, { kind: 'clients', clients, existing_tokens: existingTokens });
        progress.start('Preparing the selected client connections...');
      } else if (message.kind === 'qr') {
        if (!setupId || !preview.browser_login || !c.loginUi) throw new SetupError('invalid_state');
        c.loginUi.qr(message);
      } else if (message.kind === 'prompt') {
        if (!setupId || message.sequence !== ++sequence) throw new SetupError('invalid_state');
        // Guidance for a question (API application steps) appears only when the elevated worker actually asks it.
        progress.stop();
        const value = c.loginUi ? await c.loginUi.answer(message.question, life.signal) : await answerOwnerPrompt(io, message.question, life.signal);
        await sendPrivate(output, { kind: 'answer', sequence, value });
        progress.start('Preparing your Telegram account and the gateway service...');
      } else if (message.kind === 'handoff') {
        if (!setupId || token) throw new SetupError('invalid_state');
        token = validatedClientHandoff(message, setupId, port, preview.clients);
        progress.start('Connecting the selected MCP clients...');
        for (const client of message.clients) {
          try { await c.configure(client, port, token, false); }
          catch (err) {
            if (!(err instanceof ClientEntryConflict)) throw err;
            progress.stop();
            io.err(`Client ${client} has a different gateway entry. Replacement preserves unrelated settings and requires your choice.`);
            const replacement = c.loginUi ? await c.loginUi.answer('replace_client', life.signal, client)
              : await io.prompt(`Type REPLACE to update this gateway entry for ${client}, or cancel: `, { signal: life.signal });
            if (replacement !== 'REPLACE') throw new SetupError('invalid_state');
            progress.start('Connecting the selected MCP clients...');
            await c.configure(client, port, token, true);
          }
        }
        progress.start('Checking the authenticated MCP connection...');
        verified=await c.probe(port,token);if(!verified) throw new SetupError('invalid_state');
        progress.start('Finishing the protected setup...');
        await sendPrivate(output, { kind: 'client_ack', setup_id: setupId, token_sha256: sha256Hex(token) });
      } else {
        if (!setupId || message.result.setup_id !== setupId) throw new SetupError('invalid_state'); result = message; exchange.finish();
      }
    }
    const code = await close();
    progress.stop();
    if (!result || code !== 0 || result.result.phase === 'failed') throw new SetupError('invalid_state');
    if (!io.interactive) io.out(JSON.stringify({ ...result.result, sdk_connectivity_verified: !!verified, model_tool_loading_verified: false, clients: preview.clients }));
    nextSteps(io,preview.clients,verified,c.rerunCommand);
    finished=true; c.loginUi?.finish(true, verified ? preview.clients : []);
    return result.result.phase === 'needs_service_start' && !verified ? 1 : 0;
  } finally {
    progress.stop();
    c.loginUi?.signal.removeEventListener('abort', cancelled);
    if (!finished) c.loginUi?.finish(false);
    life.abort(); token = null; await close();
  }
}
