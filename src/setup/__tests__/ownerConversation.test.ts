import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { CliIo } from '../../cli/io.js';
import { privateLines, sendPrivate } from '../promptChannel.js';
import { runOwnerConversation, type OwnerConversation } from '../ownerConversation.js';
import { apiInstructions, elevationNotice } from '../presentation.js';
import { SetupError } from '../contract.js';

type Question = 'api_id' | 'api_hash' | 'phone' | 'code' | 'password';
const sha = 'a'.repeat(40);
const preview = { setup_id: '123e4567-e89b-42d3-a456-426614174000', account: 'personal', user: 'owner', replace_session: false, rotate_token: false, clients: [] };
const rerunCommand = '"/fixture/bin/tg-mcp-owner" setup';

/** Fake elevated coordinator: profile, the requested private questions, then a final result frame. */
function harness(questions: Question[]): { conversation: OwnerConversation; events: string[]; answers: unknown[] } {
  const events: string[] = []; const answers: unknown[] = [];
  const io: CliIo = { out: line => events.push(`out:${line}`), err: line => events.push(`err:${line}`),
    prompt: async (question, options) => { events.push(`${options?.hidden ? 'hidden' : 'visible'}:${question}`); return `private-example-${events.length}`; } };
  const conversation: OwnerConversation = { io, platform: 'darwin', sha, preview, rerunCommand,
    elevate: async () => {
      events.push('elevate');
      const toLauncher = new PassThrough(); const fromLauncher = new PassThrough();
      void (async () => {
        const frames = privateLines(fromLauncher)[Symbol.asyncIterator]();
        await sendPrivate(toLauncher, { kind: 'profile', setup_id: preview.setup_id, port: 4100 });
        const plan = JSON.parse((await frames.next()).value as string);
        let sequence = 0;
        for (const question of questions) {
          await sendPrivate(toLauncher, { kind: 'prompt', sequence: ++sequence, question });
          answers.push(JSON.parse((await frames.next()).value as string));
        }
        await sendPrivate(toLauncher, { kind: 'result', result: { format_version: 1, setup_id: plan.plan.setup_id, phase: 'needs_existing_client_credential', error_code: null } });
        toLauncher.end();
      })().catch(() => toLauncher.destroy());
      return { input: toLauncher, output: fromLauncher, closing: async () => { events.push('closed'); return 0; } };
    },
    existingTokens: async () => [], configure: async () => { throw new Error('unexpected configuration'); }, probe: async () => false };
  return { conversation, events, answers };
}

describe('owner conversation ordering', () => {
  it('announces the administrator password, elevates, then shows API guidance only when the worker asks for the application id', async () => {
    const { conversation, events, answers } = harness(['api_id', 'api_hash', 'phone']);
    expect(await runOwnerConversation(conversation)).toBe(0);
    const elevated = events.indexOf('elevate');
    expect(events.slice(0, elevated)).toEqual(elevationNotice('darwin').map(line => `err:${line}`));
    const guidance = events.indexOf(`err:${apiInstructions[0]}`);
    expect(guidance).toBeGreaterThan(elevated);
    expect(events.slice(guidance, guidance + apiInstructions.length + 1)).toEqual([...apiInstructions.map(line => `err:${line}`), 'hidden:Telegram application id: ']);
    expect(events.filter(event => event === `err:${apiInstructions[0]}`)).toHaveLength(1);
    expect(events.filter(event => event.startsWith('hidden:'))).toEqual(['hidden:Telegram application id: ', 'hidden:Telegram application hash: ', 'hidden:Telegram phone (international format): ']);
    expect(answers.map(answer => (answer as { kind: string; sequence: number }).sequence)).toEqual([1, 2, 3]);
    expect(answers.every(answer => (answer as { kind: string }).kind === 'answer')).toBe(true);
  });
  it('never shows API guidance when saved credentials are used or elevation is refused', async () => {
    const saved = harness(['phone', 'code']);
    expect(await runOwnerConversation(saved.conversation)).toBe(0);
    expect(saved.events.some(event => apiInstructions.some(line => event === `err:${line}`))).toBe(false);
    const refused = harness(['api_id']);
    refused.conversation.elevate = async () => { refused.events.push('elevate'); throw new SetupError('protection_unverified'); };
    await expect(runOwnerConversation(refused.conversation)).rejects.toThrow('protection_unverified');
    expect(refused.events).toEqual([...elevationNotice('darwin').map(line => `err:${line}`), 'elevate']);
  });
  it('ends an unverified run with public evidence and the exact installed rerun command', async () => {
    const { conversation, events } = harness([]);
    expect(await runOwnerConversation(conversation)).toBe(0);
    const output = events.filter(event => event.startsWith('out:'));
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!.slice(4))).toMatchObject({ phase: 'needs_existing_client_credential', sdk_connectivity_verified: false, model_tool_loading_verified: false, clients: [] });
    expect(events.slice(-2)).toEqual(['err:No client connection was verified; existing state is kept. To connect a client, run this in an ordinary terminal and select one:', `err:${rerunCommand}`]);
    expect(events).toContain('closed');
  });
});
