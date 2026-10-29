/** Human-only keyboard controls. Never use this reader while a secret prompt owns stdin. */
import { emitKeypressEvents } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export interface SelectionInput extends Readable { isTTY?: boolean; isRaw?: boolean; setRawMode?(raw: boolean): unknown; }
export interface SelectionOutput extends Writable { isTTY?: boolean; }
export interface Choice { value: string; label: string; }
interface Key { name?: string; ctrl?: boolean; }

function keys(input: SelectionInput, onKey: (text: string, key: Key) => void): () => void {
  const raw = input.isRaw === true; const paused = input.readableFlowing !== true;
  emitKeypressEvents(input); input.setRawMode?.(true); input.on('keypress', onKey); input.resume();
  return () => { input.off('keypress', onKey); input.setRawMode?.(raw); if (paused) input.pause(); };
}

export async function selectTerminal(input: SelectionInput, output: SelectionOutput, question: string,
  choices: Choice[], options: { multiple?: boolean; selected?: string[]; signal?: AbortSignal } = {}, term = process.env.TERM): Promise<string[] | null> {
  if (!input.isTTY || !output.isTTY || !input.setRawMode || term === 'dumb') return null;
  if (!choices.length) throw new Error('Empty selection.');
  const selected = new Set(options.selected ?? []); let cursor = Math.max(0, choices.findIndex(choice => selected.has(choice.value)));
  output.write(question + '\n' + (options.multiple ? 'Arrows: move, Space: select, Enter: continue, Ctrl+C: cancel.\n' : 'Arrows: choose, Enter: continue, Ctrl+C: cancel.\n'));
  let drawn = false;
  const draw = (): void => {
    if (drawn) output.write(`\u001b[${choices.length}A`);
    for (const [index, choice] of choices.entries()) output.write(`\r\u001b[2K${index === cursor ? '>' : ' '} ${options.multiple ? (selected.has(choice.value) ? '[x] ' : '[ ] ') : ''}${choice.label}\n`);
    drawn = true;
  };
  draw();
  return new Promise((resolve, reject) => {
    let done = false; let dispose = (): void => undefined;
    const abort = (): void => finish();
    const finish = (values?: string[]): void => {
      if (done) return; done = true; dispose(); options.signal?.removeEventListener('abort', abort);
      if (values) resolve(values); else reject(new Error('Cancelled.'));
    };
    dispose = keys(input, (text, key) => {
      if (key.ctrl && key.name === 'c' || key.name === 'escape') { finish(); return; }
      if (key.name === 'up') cursor = (cursor + choices.length - 1) % choices.length;
      else if (key.name === 'down') cursor = (cursor + 1) % choices.length;
      else if (key.name === 'space' && options.multiple) { const value = choices[cursor]!.value; if (selected.has(value)) selected.delete(value); else selected.add(value); }
      else if (key.name === 'return' || key.name === 'enter') { finish(options.multiple ? choices.filter(choice => selected.has(choice.value)).map(choice => choice.value) : [choices[cursor]!.value]); return; }
      else if (/^[1-9]$/.test(text) && Number(text) <= choices.length) cursor = Number(text) - 1;
      else return;
      draw();
    });
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
  });
}

/** C switches the browser flow to console; cancellation uses the same protected teardown. */
export function watchBrowserTerminal(input: SelectionInput, onConsole: () => void, onCancel: () => void): () => void {
  if (!input.isTTY || !input.setRawMode) return () => undefined;
  return keys(input, (text, key) => {
    if (key.ctrl && key.name === 'c' || key.name === 'escape') onCancel();
    else if (!key.ctrl && text.toLowerCase() === 'c') onConsole();
  });
}
