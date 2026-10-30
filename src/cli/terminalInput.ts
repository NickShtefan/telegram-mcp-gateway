/** Human terminal input only. Revealed values never enter log/progress callbacks. */
import { createInterface, emitKeypressEvents } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export interface TerminalInput extends Readable { isTTY?: boolean; isRaw?: boolean; setRawMode?(raw: boolean): unknown; }
export interface TerminalOutput extends Writable { isTTY?: boolean; columns?: number; rows?: number; }
export interface PromptOptions { hidden?: boolean; reveal?: boolean; signal?: AbortSignal; }
interface Key { name?: string; ctrl?: boolean; meta?: boolean; }

export function terminalAnsi(output: TerminalOutput, env: NodeJS.ProcessEnv = process.env): boolean {
  return terminalCursor(output, env) && env.NO_COLOR === undefined;
}

/** Cursor erasure is a functional capability, independent of decorative color preferences. */
export function terminalCursor(output: TerminalOutput, env: NodeJS.ProcessEnv = process.env): boolean {
  return output.isTTY === true && env.TERM !== 'dumb';
}

/** A bounded one-line hash editor for terminals with cursor erasure, including NO_COLOR. */
async function revealPrompt(input: TerminalInput, output: TerminalOutput, question: string, options: PromptOptions,
  env: NodeJS.ProcessEnv): Promise<string> {
  const cursorControl = terminalCursor(output, env); const wasRaw = input.isRaw === true; const paused = input.readableFlowing !== true;
  let chars: string[] = []; let cursor = 0; let shown = false; let done = false; let previousWidth = output.columns!;
  let paintedLength = 0; let paintedCursor = 0;
  const width = (): number => Math.max(8, Math.min(4096, output.columns ?? previousWidth));
  const erase = (): void => { output.write('\r\u001b[2K'); previousWidth = width(); };
  const draw = (): void => {
    erase();
    const label = `${question.trimEnd()} [${shown ? 'shown' : 'hidden'}] `;
    const maximum = width() - 1; const prefix = label.slice(0, Math.max(0, maximum - 8)); const room = Math.max(0, maximum - prefix.length);
    const start = Math.max(0, cursor - room + 1); const value = shown ? chars.slice(start, start + room).join('') : '';
    output.write(prefix + value);
    paintedLength = prefix.length + value.length; paintedCursor = paintedLength;
    if (shown) {
      const left = value.length - (cursor - start);
      if (left > 0) { output.write(`\u001b[${left}D`); paintedCursor -= left; }
    }
  };
  output.write('API hash starts hidden. Ctrl+T: show/hide, arrows/Backspace: edit, Enter: submit, Ctrl+C: cancel.\n');
  return new Promise<string>((resolve, reject) => {
    const finish = (accepted = false): void => {
      if (done) return; done = true;
      input.off('keypress', keypress); input.off('end', abort); input.off('close', abort); input.off('error', abort); output.off('resize', resize);
      options.signal?.removeEventListener('abort', abort); input.setRawMode?.(wasRaw); if (paused) input.pause();
      erase(); output.write(`${question.trimEnd()} [${accepted ? 'submitted' : 'cancelled'}]\n`);
      const value = chars.join(''); chars = []; cursor = 0;
      if (accepted) resolve(value); else reject(new Error('Cancelled.'));
    };
    const abort = (): void => finish();
    const resize = (): void => {
      // A terminal can reflow an already revealed line when its width shrinks.
      // Clear all resulting physical rows before returning to hidden input.
      if (cursorControl && shown && width() < previousWidth && paintedLength >= width()) {
        const above = Math.floor(paintedCursor / width()); const last = Math.floor(Math.max(0, paintedLength - 1) / width());
        output.write('\r' + (above ? `\u001b[${above}A` : ''));
        for (let row = 0; row <= last; row++) output.write('\u001b[2K' + (row < last ? '\u001b[1B\r' : ''));
        if (last) output.write(`\u001b[${last}A`);
      }
      shown = false; draw();
    };
    const keypress = (text: string, key: Key = {}): void => {
      if (key.ctrl && ['c', 'd'].includes(key.name ?? '') || key.name === 'escape') { finish(); return; }
      if (key.ctrl && key.name === 't') shown = !shown;
      else if (key.name === 'return' || key.name === 'enter') { finish(true); return; }
      else if (key.name === 'backspace' && cursor > 0) chars.splice(--cursor, 1);
      else if (key.name === 'delete') chars.splice(cursor, 1);
      else if (key.name === 'left') cursor = Math.max(0, cursor - 1);
      else if (key.name === 'right') cursor = Math.min(chars.length, cursor + 1);
      else if (key.name === 'home' || key.ctrl && key.name === 'a') cursor = 0;
      else if (key.name === 'end' || key.ctrl && key.name === 'e') cursor = chars.length;
      else if (key.ctrl && key.name === 'u') { chars = []; cursor = 0; }
      else if (!key.ctrl && !key.meta && text && /^[\x20-\x7e]+$/.test(text) && chars.length + text.length <= 512) {
        chars.splice(cursor, 0, ...text); cursor += text.length;
      } else return;
      draw();
    };
    emitKeypressEvents(input); input.setRawMode!(true); input.on('keypress', keypress);
    input.once('end', abort); input.once('close', abort); input.once('error', abort); output.on('resize', resize);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort(); else { draw(); input.resume(); }
  });
}

export async function promptTerminal(input: TerminalInput, output: TerminalOutput, question: string,
  options: PromptOptions = {}, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (!input.isTTY || !output.isTTY) throw new Error('This command needs an interactive terminal.');
  if (options.reveal && terminalCursor(output, env) && input.setRawMode && Number.isInteger(output.columns) && output.columns! >= 32) return revealPrompt(input, output, question, options, env);
  if (options.reveal) output.write('This terminal cannot safely reveal a one-line hash. Input stays hidden; use a wider cursor-capable terminal or browser guide to inspect it.\n');
  return new Promise<string>((resolve, reject) => {
    const raw = input.isRaw === true; const rl = createInterface({ input, output, terminal: true, historySize: 0 }); let settled = false;
    const finish = (answer?: string): void => {
      if (settled) return; settled = true; options.signal?.removeEventListener('abort', cancel); rl.close(); input.setRawMode?.(raw);
      input.off('error', cancel); input.off('end', cancel); if (options.hidden || options.reveal) output.write('\n');
      if (answer === undefined) reject(new Error('Cancelled.')); else resolve(options.hidden || options.reveal ? answer : answer.trim());
    };
    const cancel = (): void => finish();
    rl.on('close', cancel); rl.on('SIGINT', cancel); input.once('error', cancel); input.once('end', cancel);
    options.signal?.addEventListener('abort', cancel, { once: true }); if (options.signal?.aborted) { cancel(); return; }
    if (options.hidden || options.reveal) {
      const masked = rl as unknown as { _writeToOutput: (text: string) => void };
      masked._writeToOutput = text => { if (text.includes(question)) output.write(question); };
    }
    rl.question(question, finish);
  });
}
