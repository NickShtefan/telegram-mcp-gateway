/**
 * Hang watchdog. A hung teleproto call cannot be safely canceled, and a
 * second client on the same session causes AUTH_KEY_DUPLICATED. Exit
 * with code 1 and let the supervisor (launchd) restart a fresh process.
 */
import { createLogger, type Logger } from './log.js';

export type ExitProcess = (code: number) => void;

export interface FatalHandlerOptions {
  exit?: ExitProcess;
  log?: Logger;
  /** Before-exit cleanup, e.g. closing the database. Errors are ignored. */
  beforeExit?: () => void;
  /** Immediately reject queued work so callers learn about the failure. */
  prepare?: () => void;
  /**
   * Delay between `prepare` and exit, allowing error handlers
   * to record outcomes; otherwise writes could remain executing forever.
   */
  graceMs?: number;
}

export type FatalHandler = (reason: string) => void;

export function createFatalHandler(options: FatalHandlerOptions = {}): FatalHandler {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const log = options.log ?? createLogger('recovery');
  let requested = false;
  return (reason: string) => {
    if (requested) return;
    requested = true;
    log.error(`fatal MTProto failure: ${reason}; exiting for supervisor restart`);
    try {
      options.prepare?.();
    } catch {
      // Exiting takes priority over graceful shutdown.
    }
    const finish = (): void => {
      try {
        options.beforeExit?.();
      } catch {
        // Exiting takes priority over graceful close.
      }
      exit(1);
    };
    if (options.graceMs && options.graceMs > 0) setTimeout(finish, options.graceMs);
    else finish();
  };
}
