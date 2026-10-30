/**
 * CLI input/output. Ordinary stdout output is allowed only here;
 * other gateway components log to stderr.
 */
import { selectTerminal, watchBrowserTerminal, watchTerminalCancel, type Choice } from './selection.js';
import { promptTerminal, terminalAnsi, type PromptOptions } from './terminalInput.js';
import { createTerminalQr } from './terminalQr.js';

export interface CliIo {
  /** Human-readable summaries may replace JSON only in an interactive terminal. */
  interactive?: boolean;
  ansi?: boolean;
  out(line: string): void;
  err(line: string): void;
  /** Ask a human for text; hidden suppresses password/code echo. */
  prompt(question: string, options?: PromptOptions): Promise<string>;
  select?(question: string, choices: Choice[], options?: { multiple?: boolean; selected?: string[]; signal?: AbortSignal }): Promise<string[] | null>;
  browserControl?(onConsole: () => void, onCancel: () => void): () => void;
  cancelControl?(onCancel: () => void): () => void;
  /** Private human display only, never a progress/logger callback. False means an unscannable terminal size. */
  qr?(code: { token: string; expires: number }): boolean;
  clearQr?(): void;
}

const terminalQr = createTerminalQr(process.stderr);
export const terminalIo: CliIo = {
  interactive: !!process.stdin.isTTY && !!process.stdout.isTTY && !!process.stderr.isTTY,
  ansi: terminalAnsi(process.stderr),
  out: line => void process.stdout.write(line + '\n'),
  err: line => void process.stderr.write(line + '\n'),
  select: (question, choices, options) => selectTerminal(process.stdin, process.stderr, question, choices, options),
  browserControl: (onConsole, onCancel) => watchBrowserTerminal(process.stdin, onConsole, onCancel),
  cancelControl: onCancel => watchTerminalCancel(process.stdin, onCancel),
  qr: code => terminalQr.show(code), clearQr: () => terminalQr.clear(),
  prompt: (question, options) => promptTerminal(process.stdin, process.stderr, question, options),
};
