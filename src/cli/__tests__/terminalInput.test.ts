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

/** Minimal screen with real line reflow, so erasure assertions inspect old glyphs, not escape strings. */
class ReflowScreen {
  private lines: Array<{ cells: string[]; wrapped: boolean }> = [{ cells: [], wrapped: false }];
  private row = 0;
  private column = 0;
  constructor(private columns: number) {}
  private line() { while (this.lines.length <= this.row) this.lines.push({ cells: [], wrapped: false }); return this.lines[this.row]; }
  write(text: string): void {
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (char === '\u001b') {
        const code = /^\u001b\[([0-9;]*)([A-Za-z])/.exec(text.slice(index));
        if (!code) throw new Error('Unsupported screen escape.');
        const amount = Number(code[1] || '1'); index += code[0].length - 1;
        if (code[2] === 'A') this.row = Math.max(0, this.row - amount);
        else if (code[2] === 'B') { this.row += amount; this.line(); }
        else if (code[2] === 'D') this.column = Math.max(0, this.column - amount);
        else if (code[2] === 'K' && code[1] === '2') this.line().cells = [];
        else if (code[2] !== 'm') throw new Error('Unsupported screen control.');
      } else if (char === '\r') this.column = 0;
      else if (char === '\n') { this.line().wrapped = false; this.row++; this.column = 0; this.line(); }
      else if (char === '\b') this.column = Math.max(0, this.column - 1);
      else {
        if (this.column >= this.columns) { this.line().wrapped = true; this.row++; this.column = 0; }
        const line = this.line(); while (line.cells.length < this.column) line.cells.push(' ');
        line.cells[this.column++] = char;
      }
    }
  }
  resize(columns: number): void {
    const reflowed: typeof this.lines = []; let logical = ''; let offset: number | null = null;
    const flush = (): void => {
      const count = Math.max(1, Math.ceil(logical.length / columns), offset === null ? 0 : Math.floor(offset / columns) + 1);
      const base = reflowed.length;
      for (let row = 0; row < count; row++) reflowed.push({ cells: [...logical.slice(row * columns, (row + 1) * columns)], wrapped: row < count - 1 });
      if (offset !== null) { this.row = base + Math.floor(offset / columns); this.column = offset % columns; }
      logical = ''; offset = null;
    };
    const originalCursorRow = this.row; const originalCursorColumn = this.column;
    for (const [row, line] of this.lines.entries()) {
      if (row === originalCursorRow) offset = logical.length + originalCursorColumn;
      const text = line.cells.join(''); logical += line.wrapped ? text.padEnd(this.columns, ' ') : text.trimEnd();
      if (!line.wrapped) flush();
    }
    if (logical.length) flush(); this.lines = reflowed; this.columns = columns;
  }
  text(): string { return this.lines.map(line => line.cells.join('')).join('\n'); }
}
describe('owner terminal input', () => {
  it('echoes ordinary API IDs and phone numbers but keeps OTP and 2FA hidden', async () => {
    for (const [value, hidden] of [['12345', false], ['+15551234567', false], ['98765', true], ['fixture-2fa', true]] as const) {
      const f = fixture(); const pending = promptTerminal(f.input, f.output, 'Value: ', { hidden });
      f.input.write(value + '\r'); expect(await pending).toBe(value);
      if (hidden) expect(f.text.join('')).not.toContain(value); else expect(f.text.join('')).toContain(value);
      expect(f.input.isRaw).toBe(false);
    }
  });
  it.each([{ TERM: 'xterm' }, { TERM: 'xterm', NO_COLOR: '1' }])('edits and toggles the hidden hash, then erases its revealed line: %j', async env => {
    const f = fixture(); const pending = promptTerminal(f.input, f.output, 'API hash: ', { hidden: true, reveal: true }, env);
    f.input.write('abcde'); await tick(); expect(f.text.join('')).not.toContain('abcde');
    f.input.write('\u0014'); await tick(); expect(f.text.join('')).toContain('abcde');
    f.input.write('\u001b[D\u007fX'); await tick();
    f.input.write('\u0014'); await tick(); const hiddenScreen = f.text.at(-1)!; expect(hiddenScreen).not.toContain('abcXe');
    f.input.write('\u0014\r'); expect(await pending).toBe('abcXe');
    expect(f.text.at(-1)).toBe('API hash: [submitted]\n'); expect(f.input.isRaw).toBe(false);
    expect(f.input.listenerCount('keypress')).toBe(0); expect(f.input.isPaused()).toBe(true);
    expect(f.text.join('')).not.toMatch(/\u001b\[[0-9;]*m/);
  });
  it.each(['ctrl-c', 'eof', 'abort'])('clears a revealed hash and restores stdin after %s', async action => {
    const f = fixture(); const life = new AbortController();
    const pending = promptTerminal(f.input, f.output, 'API hash: ', { hidden: true, reveal: true, signal: life.signal }, { TERM: 'xterm' });
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
  it('keeps hash input hidden in TERM=dumb rather than claiming unsupported erasure', async () => {
    const f = fixture(); const pending = promptTerminal(f.input, f.output, 'Hash: ', { hidden: true, reveal: true }, { TERM: 'dumb' });
    f.input.write('fixture-secret\r'); expect(await pending).toBe('fixture-secret');
    expect(f.text.join('')).toContain('cursor-capable'); expect(f.text.join('')).not.toContain('fixture-secret');
    expect(f.text.join('')).not.toContain('Ctrl+T: show/hide'); expect(f.input.isRaw).toBe(false);
  });
  it.each([{ TERM: 'xterm' }, { TERM: 'xterm', NO_COLOR: '1' }])('removes all revealed hash glyphs from reflowed rows on resize and cancel: %j', async env => {
    const f = fixture(); const life = new AbortController();
    const screen = new ReflowScreen(80); f.output.on('data', bytes => screen.write(bytes.toString()));
    const pending = promptTerminal(f.input, f.output, 'API hash: ', { hidden: true, reveal: true, signal: life.signal }, env);
    const rejected = expect(pending).rejects.toThrow('Cancelled');
    f.input.write('9'.repeat(32) + '\u0014'); await tick(); expect(screen.text()).toContain('9'.repeat(32));
    screen.resize(20); expect(screen.text().split('\n').filter(line => line.includes('9')).length).toBeGreaterThan(1);
    f.output.columns = 20; f.output.emit('resize');
    expect(screen.text()).not.toContain('9');
    life.abort(); await rejected; expect(screen.text()).not.toContain('9'); expect(screen.text()).toContain('cancelled');
    expect(f.text.join('')).not.toMatch(/\u001b\[[0-9;]*m/); expect(f.input.isRaw).toBe(false);
  });
});
