/** Original-user side of owner setup after local checks. The elevated peer exchanges only closed private protocol frames. */
import type { Readable, Writable } from 'node:stream';
import type { CliIo } from '../cli/io.js';
import { sha256Hex } from '../core/crypto.js';
import type { InstallLayout } from '../install/platform.js';
import type { OwnerPlan } from './owner.js';
import { ClientEntryConflict, type ClientKind } from './clientConfig.js';
import { privateExchange, sendPrivate, workerMessageSchema } from './promptChannel.js';
import { answerOwnerPrompt, elevationNotice, nextSteps } from './presentation.js';
import { SetupError } from './contract.js';
import { ownerOperationId, validatedClientHandoff } from './clientHandoff.js';

/** Elevated coordinator channel: sudo pipes on macOS/Linux, the approved broker's named pipe on Windows. */
export interface ElevatedPeer { input: Readable; output: Writable; closing(): Promise<number | null>; }
export interface OwnerConversation {
  io: CliIo; platform: InstallLayout['platform']; sha: string; preview: OwnerPlan; rerunCommand: string;
  /** Starts the elevated coordinator; the operating system asks for administrator approval here. */
  elevate(): Promise<ElevatedPeer>;
  existingTokens(port: number): Promise<string[]>;
  configure(client: ClientKind, port: number, token: string, replace: boolean): Promise<void>;
  probe(port: number, token: string): Promise<boolean>;
}

export async function runOwnerConversation(c: OwnerConversation): Promise<number> {
  const { io, preview } = c;
  for (const line of elevationNotice(c.platform)) io.err(line);
  const { input, output, closing } = await c.elevate();
  let closed: Promise<number | null> | undefined; const close = (): Promise<number | null> => closed ??= closing();
  // The coordinator's input ends with its final frame, so its pending read cannot keep it (and sudo) alive.
  const exchange = privateExchange(input, output);
  const life = new AbortController(); input.once('end', () => life.abort()); input.once('close', () => life.abort()); input.once('error', () => life.abort());
  let result: Extract<ReturnType<typeof workerMessageSchema.parse>, { kind: 'result' }> | null = null;
  let setupId: string | null = null; let port = 0; let token: string | null = null; let sequence = 0; let verified=false;
  try {
    for await (const line of exchange.frames) {
      const message = workerMessageSchema.parse(JSON.parse(line));
      if (result) throw new SetupError('invalid_state');
      if (message.kind === 'profile') {
        if (setupId) throw new SetupError('invalid_state'); setupId = ownerOperationId(c.sha, preview.user); port = message.port;
        const existingTokens = await c.existingTokens(port);
        await sendPrivate(output, { kind: 'plan', plan: { ...preview, setup_id: setupId }, existing_tokens: existingTokens });
      } else if (message.kind === 'prompt') {
        if (!setupId || message.sequence !== ++sequence) throw new SetupError('invalid_state');
        // Guidance for a question (API application steps) appears only when the elevated worker actually asks it.
        const value = await answerOwnerPrompt(io, message.question, life.signal);
        await sendPrivate(output, { kind: 'answer', sequence, value });
      } else if (message.kind === 'handoff') {
        if (!setupId || token) throw new SetupError('invalid_state');
        token = validatedClientHandoff(message, setupId, port, preview.clients);
        for (const client of message.clients) {
          try { await c.configure(client, port, token, false); }
          catch (err) {
            if (!(err instanceof ClientEntryConflict)) throw err;
            io.err(`Client ${client} has a different gateway entry. Replacement preserves unrelated settings and requires your choice.`);
            if (await io.prompt(`Type REPLACE to update this gateway entry for ${client}, or cancel: `, { signal: life.signal }) !== 'REPLACE') throw new SetupError('invalid_state');
            await c.configure(client, port, token, true);
          }
        }
        verified=await c.probe(port,token);if(!verified) throw new SetupError('invalid_state');
        await sendPrivate(output, { kind: 'client_ack', setup_id: setupId, token_sha256: sha256Hex(token) });
      } else {
        if (!setupId || message.result.setup_id !== setupId) throw new SetupError('invalid_state'); result = message; exchange.finish();
      }
    }
    const code = await close();
    if (!result || code !== 0 || result.result.phase === 'failed') throw new SetupError('invalid_state');
    io.out(JSON.stringify({ ...result.result, sdk_connectivity_verified: !!verified, model_tool_loading_verified: false, clients: preview.clients }));
    nextSteps(io,preview.clients,verified,c.rerunCommand);
    return result.result.phase === 'needs_service_start' && !verified ? 1 : 0;
  } finally { life.abort(); token = null; await close().catch(() => undefined); }
}
