/** Bounded private pipe protocol. Only fixed prompts and closed public results cross the worker boundary. */
import { z } from 'zod';
import type { Readable, Writable } from 'node:stream';
import type { CliIo } from '../cli/io.js';
import { ownerPlanSchema } from './owner.js';
import { setupIdSchema, SetupError } from './contract.js';
import { withTimeout } from '../core/time.js';

export const questions = {
  api_id: 'Telegram application id: ', api_hash: 'Telegram application hash: ',
  phone: 'Telegram phone (international format): ', code: 'Telegram verification code: ', password: 'Telegram two-factor password: ',
} as const;
const questionSchema = z.enum(['api_id', 'api_hash', 'phone', 'code', 'password']);
export const ownerResultSchema = z.strictObject({ format_version: z.literal(1), setup_id: setupIdSchema,
  phase: z.enum(['needs_client_configuration', 'needs_existing_client_credential', 'needs_service_start', 'failed']),
  error_code: z.enum(['invalid_owner_input', 'owner_step_failed']).nullable() });
export const workerMessageSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('profile'), setup_id: setupIdSchema, port: z.number().int().min(1).max(65535) }),
  z.strictObject({ kind: z.literal('handoff'), setup_id: setupIdSchema, port: z.number().int().min(1).max(65535),
    token: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/), service_evidence: z.literal('listener_owned_by_service').optional(), clients: z.array(z.enum(['codex', 'claude', 'opencode', 'hermes'])).min(1).max(4) }),
  z.strictObject({ kind: z.literal('prompt'), sequence: z.number().int().positive(), question: questionSchema }),
  z.strictObject({ kind: z.literal('result'), result: ownerResultSchema }),
]);
export const coordinatorMessageSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('plan'), plan: ownerPlanSchema, existing_token: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/).nullable().default(null), existing_tokens: z.array(z.string().regex(/^[A-Za-z0-9_-]{32,256}$/)).max(4).default([]) }),
  z.strictObject({ kind: z.literal('client_ack'), setup_id: setupIdSchema, token_sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  z.strictObject({ kind: z.literal('answer'), sequence: z.number().int().positive(), value: z.string().max(512) }),
]);
/** No readline buffering: reject oversized/partial/multiple queued messages before allocating more. */
export function privateLines(input: Readable, maximum = 2048): AsyncIterable<string> {
  return { async *[Symbol.asyncIterator]() {
    let pending = Buffer.alloc(0);
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      // A sender may coalesce frames, but each frame is bounded independently.
      let start = 0;
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] !== 10) continue;
        if (pending.length + i - start > maximum) throw new SetupError('invalid_state');
        const line = Buffer.concat([pending, bytes.subarray(start, i)]).toString('utf8');
        pending = Buffer.alloc(0); start = i + 1; yield line;
      }
      if (pending.length + bytes.length - start > maximum) throw new SetupError('invalid_state');
      pending = Buffer.concat([pending, bytes.subarray(start)]);
    }
    if (pending.length) throw new SetupError('invalid_state');
  } };
}
export async function sendPrivate(output: Writable, message: unknown): Promise<void> {
  const bytes = JSON.stringify(message) + '\n';
  if (Buffer.byteLength(bytes) > 2049) throw new SetupError('invalid_state');
  await new Promise<void>((resolve, reject) => output.write(bytes, err => err ? reject(new SetupError('invalid_state')) : resolve()));
}
/**
 * Parent half of the final-frame lifecycle. A peer blocked reading an open pipe never exits, so the parent
 * ends the peer's input once the final frame arrives (`finish`) or the exchange fails, then waits only
 * `graceMs` for the peer to close its output.
 */
export function privateExchange(input: Readable, output: Writable, graceMs = 30000): { frames: AsyncIterable<string>; finish(): void } {
  let deadline = 0;
  // Write failures surface through sendPrivate callbacks; an emitted EPIPE must not crash cleanup.
  output.on('error', () => undefined);
  const finish = (): void => { if (deadline) return; deadline = Date.now() + graceMs; output.end(); };
  return { finish, frames: { async *[Symbol.asyncIterator]() {
    const lines = privateLines(input)[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await (deadline ? withTimeout(lines.next(), deadline - Date.now(), 'private peer exit') : lines.next());
        if (next.done) return; yield next.value;
      }
    } finally { finish(); }
  } } };
}
/**
 * Child half: whatever the outcome, release stdin once `main` settles so a pending pipe read cannot keep
 * the process alive, and keep a vanished parent's EPIPE from crashing cleanup. Output is a fixed code only.
 */
export function runPrivateProcess(main: () => Promise<number>, errorCode: string): void {
  process.stdout.on('error', () => undefined);
  void main().then(code => { process.exitCode = code; }, () => {
    process.stderr.write(`{"format_version":1,"error_code":"${errorCode}"}\n`); process.exitCode = 1;
  }).finally(() => { process.stdin.destroy(); });
}
export async function nextPrivate(input: AsyncIterator<string>, signal: AbortSignal, timeoutMs = 300000): Promise<IteratorResult<string>> {
  let cancel: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new SetupError('invalid_state'));
    signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
  });
  try { return await withTimeout(Promise.race([input.next(), aborted]), timeoutMs, 'private owner input'); }
  finally { signal.removeEventListener('abort', cancel); }
}
/** Worker notices never cross the boundary; the launcher shows fixed guidance for each closed question identifier. */
export function workerIo(input: AsyncIterator<string>, output: Writable): CliIo {
  let sequence = 0;
  return { out: () => { throw new SetupError('invalid_state'); }, err: () => undefined,
    prompt: async (question, options) => {
      const key = (Object.keys(questions) as Array<keyof typeof questions>).find(k => questions[k] === question);
      if (!key || !options?.hidden) throw new SetupError('invalid_state');
      const current = ++sequence;
      await sendPrivate(output, { kind: 'prompt', sequence: current, question: key });
      const next = await input.next(); if (next.done) throw new SetupError('invalid_state');
      const answer = coordinatorMessageSchema.parse(JSON.parse(next.value));
      if (answer.kind !== 'answer' || answer.sequence !== current) throw new SetupError('invalid_state');
      return answer.value;
    } };
}
