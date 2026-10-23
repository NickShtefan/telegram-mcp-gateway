import { describe, expect, it } from 'vitest';
import { PassThrough, Readable } from 'node:stream';
import { privateLines, workerIo, workerMessageSchema } from '../promptChannel.js';

describe('private owner prompt channel', () => {
  it('bounds fragmented frames before yielding and rejects truncated input', async () => {
    const collect = async (parts: string[]): Promise<string[]> => {
      const result: string[] = [];
      for await (const line of privateLines(Readable.from(parts), 8)) result.push(line);
      return result;
    };
    expect(await collect(['one\nt', 'wo\n'])).toEqual(['one', 'two']);
    await expect(collect(['12345678', '9\n'])).rejects.toThrow('invalid_state');
    await expect(collect(['partial'])).rejects.toThrow('invalid_state');
  });
  it('uses fixed prompt identifiers, suppresses notices, and carries answers only on the private pipe', async () => {
    const output = new PassThrough(); let emitted = '';
    output.on('data', chunk => { emitted += chunk.toString(); });
    const input = privateLines(Readable.from(['{"kind":"answer","sequence":1,"value":"private-example"}\n']))[Symbol.asyncIterator]();
    const io = workerIo(input, output);
    io.err('private notice must not escape');
    expect(await io.prompt('Telegram application hash: ', { hidden: true })).toBe('private-example');
    expect(JSON.parse(emitted)).toEqual({ kind: 'prompt', sequence: 1, question: 'api_hash' });
    expect(emitted).not.toContain('private');
  });
  it('rejects arbitrary library text, nonhidden prompts and replayed answers', async () => {
    const output = new PassThrough(); output.resume();
    const input = privateLines(Readable.from(['{"kind":"answer","sequence":2,"value":"example"}\n']))[Symbol.asyncIterator]();
    const io = workerIo(input, output);
    await expect(io.prompt('attacker-selected text', { hidden: true })).rejects.toThrow('invalid_state');
    await expect(io.prompt('Telegram verification code: ')).rejects.toThrow('invalid_state');
    await expect(io.prompt('Telegram verification code: ', { hidden: true })).rejects.toThrow('invalid_state');
    expect(workerMessageSchema.safeParse({ kind: 'result', result: { format_version: 1, setup_id: '123e4567-e89b-42d3-a456-426614174000', phase: 'failed', error_code: 'owner_step_failed', token: 'unexpected' } }).success).toBe(false);
  });
});
