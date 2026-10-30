import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { promptTerminal, type TerminalInput, type TerminalOutput } from '../terminalInput.js';

function fixture(columns = 80) {
  const input = new PassThrough() as PassThrough & TerminalInput; input.isTTY = true; input.isRaw = false;
  input.setRawMode = vi.fn((raw: boolean) => { input.isRaw = raw; });
  const output = new PassThrough() as PassThrough & TerminalOutput; output.isTTY = true; output.columns = columns;
  const text: string[] = []; output.on('data', data => text.push(data.toString()));
  return { input, output, text };
}
const tick = async (): Promise<void> => { await new Promise(resolve => setImmediate(resolve)); };
describe('owner terminal input', () => {
  it('echoes ordinary API IDs and phone numbers but keeps OTP and 2FA hidden', async () => {
    for (const [value, hidden] of [['12345', false], ['+15551234567', false], ['98765', true], ['fixture-2fa', true]] as const) {
      const f = fixture(); const pending = promptTerminal(f.input, f.output, 'Value: ', { hidden });
      f.input.write(value + '\r'); expect(await pending).toBe(value);
      if (hidden) expect(f.text.join('')).not.toContain(value); else expect(f.text.join('')).toContain(value);
      expect(f.input.isRaw).toBe(false);
    }
  });
  it.each([{ TERM: 'xterm' }, { TERM: 'dumb' }, { TERM: 'xterm', NO_COLOR: '1' }])('edits and toggles the hidden hash, then erases its revealed line: %j', async env => {
    const f = fixture(); const pending = promptTerminal(f.input, f.output, 'API hash: ', { hidden: true, reveal: true }, env);
    f.input.write('abcde'); await tick(); expect(f.text.join('')).not.toContain('abcde');
    f.input.write('\u0014'); await tick(); expect(f.text.join('')).toContain('abcde');
    f.input.write('\u001b[D\u007fX'); await tick();
    f.input.write('\u0014'); await tick(); const hiddenScreen = f.text.at(-1)!; expect(hiddenScreen).not.toContain('abcXe');
    f.input.write('\u0014\r'); expect(await pending).toBe('abcXe');
    expect(f.text.at(-1)).toBe('API hash: [submitted]\n'); expect(f.input.isRaw).toBe(false);
    expect(f.input.listenerCount('keypress')).toBe(0); expect(f.input.isPaused()).toBe(true);
    if (env.TERM === 'dumb' || 'NO_COLOR' in env) expect(f.text.join('')).not.toContain('\u001b[');
  });
  it.each(['ctrl-c', 'eof', 'abort'])('clears a revealed hash and restores stdin after %s', async action => {
    const f = fixture(); const life = new AbortController();
    const pending = promptTerminal(f.input, f.output, 'API hash: ', { hidden: true, reveal: true, signal: life.signal });
    const rejected = expect(pending).rejects.toThrow('Cancelled');
    f.input.write('fixture-hash\u0014'); await tick(); expect(f.text.join('')).toContain('fixture-hash');
    if (action === 'ctrl-c') f.input.write('\u0003'); else if (action === 'eof') f.input.end(); else life.abort();
    await rejected; expect(f.text.at(-1)).toBe('API hash: [cancelled]\n');
    expect(f.input.isRaw).toBe(false); expect(f.input.listenerCount('keypress')).toBe(0);
  });
  it('keeps the hash hidden when terminal width cannot safely contain a reveal editor', async () => {
    const f = fixture(20); const pending = promptTerminal(f.input, f.output, 'Hash: ', { hidden: true, reveal: true });
    f.input.write('fixture-secret\r'); expect(await pending).toBe('fixture-secret');
    expect(f.text.join('')).toContain('cannot safely reveal'); expect(f.text.join('')).not.toContain('fixture-secret');
  });
  it('clears every reflowed row when an ANSI terminal shrinks while the hash is revealed', async () => {
    const f = fixture(); const life = new AbortController();
    const pending = promptTerminal(f.input, f.output, 'API hash: ', { hidden: true, reveal: true, signal: life.signal }, { TERM: 'xterm' });
    const rejected = expect(pending).rejects.toThrow('Cancelled');
    f.input.write('a'.repeat(32) + '\u0014'); await tick();
    const before = f.text.length; f.output.columns = 20; f.output.emit('resize');
    expect(f.text.slice(before).join('')).toContain('\u001b[2A');
    expect(f.text.slice(before).join('')).not.toContain('a'.repeat(32));
    life.abort(); await rejected; expect(f.input.isRaw).toBe(false);
  });
});
