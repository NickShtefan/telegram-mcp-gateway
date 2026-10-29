import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { selectTerminal, watchBrowserTerminal, type SelectionInput, type SelectionOutput } from '../selection.js';

function fixture() {
  const input = new PassThrough() as PassThrough & SelectionInput; input.isTTY = true; input.isRaw = false;
  input.setRawMode = vi.fn((raw: boolean) => { input.isRaw = raw; });
  const output = new PassThrough() as SelectionOutput; output.isTTY = true; const text: string[] = [];
  output.on('data', data => text.push(data.toString()));
  return { input, output, text, key: (name: string) => input.emit('keypress', '', { name }) };
}
const choices = [{ value: 'browser', label: 'Browser' }, { value: 'console', label: 'Console' }];
describe('human terminal selection', () => {
  it('decodes actual arrow/space/Enter bytes and restores terminal ownership', async () => {
    const f = fixture(); const pending = selectTerminal(f.input, f.output, 'Choose', choices, { multiple: true }, 'xterm');
    f.input.write('\u001b[B \r');
    expect(await pending).toEqual(['console']); expect(f.input.isRaw).toBe(false);
    expect(f.input.listenerCount('keypress')).toBe(0); expect(f.input.isPaused()).toBe(true);
    expect(f.text.join('')).toContain('[x] Console');
  });
  it('honors recommended defaults, wraps arrows and allows empty multi-selection', async () => {
    const f = fixture(); let pending = selectTerminal(f.input, f.output, 'Choose', choices, { selected: ['console'] }, 'xterm');
    f.key('return'); expect(await pending).toEqual(['console']);
    pending = selectTerminal(f.input, f.output, 'Choose', choices, {}, 'xterm'); f.key('up'); f.key('return'); expect(await pending).toEqual(['console']);
    pending = selectTerminal(f.input, f.output, 'Choose', choices, { multiple: true }, 'xterm'); f.key('return'); expect(await pending).toEqual([]);
  });
  it('cancels on Ctrl+C or peer abort without retaining raw input handlers', async () => {
    const f = fixture(); const life = new AbortController();
    const pending = selectTerminal(f.input, f.output, 'Choose', choices, { signal: life.signal }, 'xterm');
    const rejected = expect(pending).rejects.toThrow('Cancelled'); life.abort(); await rejected;
    expect(f.input.isRaw).toBe(false); expect(f.input.listenerCount('keypress')).toBe(0);
    const second = selectTerminal(f.input, f.output, 'Choose', choices, {}, 'xterm');
    const cancelled = expect(second).rejects.toThrow('Cancelled'); f.input.emit('keypress', '\u0003', { name: 'c', ctrl: true }); await cancelled;
    expect(f.input.listenerCount('keypress')).toBe(0);
  });
  it('uses text fallback without changing stdin when the terminal has limited support', async () => {
    const f = fixture(); expect(await selectTerminal(f.input, f.output, 'Choose', choices, {}, 'dumb')).toBeNull();
    f.input.isTTY = false; expect(await selectTerminal(f.input, f.output, 'Choose', choices, {}, 'xterm')).toBeNull();
    expect(f.input.setRawMode).not.toHaveBeenCalled(); expect(f.text).toEqual([]);
  });
  it('offers browser-to-console control and restores input before hidden prompts', () => {
    const f = fixture(); const consoleMode = vi.fn(); const cancel = vi.fn();
    const stop = watchBrowserTerminal(f.input, consoleMode, cancel);
    f.input.emit('keypress', 'c', { name: 'c' }); expect(consoleMode).toHaveBeenCalledOnce();
    f.input.emit('keypress', '\u0003', { name: 'c', ctrl: true }); expect(cancel).toHaveBeenCalledOnce();
    stop(); expect(f.input.isRaw).toBe(false); expect(f.input.listenerCount('keypress')).toBe(0);
  });
});
