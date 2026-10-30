/** Human console login, using the protected worker protocol without a browser or listener. */
import type { CliIo } from '../cli/io.js';
import { answerOwnerPrompt, ownerClients, ownerLoginMethod } from './presentation.js';
import type { OwnerLoginUi, OwnerRetry } from './ownerGuide.js';

export function consoleOwnerLogin(io: CliIo, remembered = new Map<'api_id' | 'api_hash', string>()): OwnerLoginUi {
  let life = new AbortController(); let retry: OwnerRetry | null = null; let forcePhone = false; let stopControl: (() => void) | null = null;
  const clear = (): void => { stopControl?.(); stopControl = null; io.clearQr?.(); };
  return {
    get signal() { return life.signal; },
    answer: async (question, signal, client) => {
      clear();
      if ((question === 'api_id' || question === 'api_hash') && remembered.has(question)) return remembered.get(question)!;
      if (question === 'login_method') {
        if (forcePhone || !io.qr) { forcePhone = false; return 'phone'; }
        return ownerLoginMethod(io, signal);
      }
      if (question === 'clients') return JSON.stringify(await ownerClients(io, signal));
      if (question === 'replace_client') return io.prompt(`Type REPLACE to update the gateway entry for ${client}, or cancel: `, { signal });
      const value = await answerOwnerPrompt(io, question, signal);
      if (question === 'api_id' || question === 'api_hash') remembered.set(question, value);
      return value;
    },
    qr: code => {
      if (life.signal.aborted) return;
      if (!io.qr?.(code)) {
        clear(); retry = { mode: 'console', method: 'phone' };
        io.err('This terminal cannot fit a complete QR code. The current login will stop before continuing by phone. Enlarge the terminal and rerun setup if you prefer QR.');
        life.abort(); return;
      }
      stopControl ??= io.cancelControl?.(() => { clear(); life.abort(); }) ?? (() => undefined);
    },
    finish: () => { clear(); if (!retry) remembered.clear(); },
    close: async () => { clear(); remembered.clear(); },
    takeRetry: async () => {
      const next = retry; if (!next) return null;
      retry = null; life = new AbortController(); forcePhone = true; return next;
    },
  };
}
