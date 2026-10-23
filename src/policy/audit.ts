/**
 * Audit each tool call with time, user, account, chat,
 * and outcome, supporting activity review and limit configuration.
 */
import { isGatewayError } from '../core/errors.js';
import { createLogger, redactFields, type Logger } from '../core/log.js';
import type { Storage } from '../storage/port.js';

export interface AuditCall {
  userId: string | null;
  accountId: string | null;
  tool: string;
  args: Record<string, unknown>;
  peerKey?: string | null;
  resultCount?: number | null;
  startedAt: number;
  error?: unknown;
}

/** Truncate long argument values; audit does not need complete message text. */
function compactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(redactFields(args))) {
    if (value === undefined) continue;
    if (typeof value === 'string') out[key] = value.length > 200 ? value.slice(0, 200) + '…' : value;
    else if (Array.isArray(value)) out[key] = value.slice(0, 20).map(v => (typeof v === 'string' && v.length > 60 ? v.slice(0, 60) + '…' : v));
    else out[key] = value;
  }
  return out;
}

export class Audit {
  private readonly log: Logger;

  constructor(
    private readonly storage: Storage,
    private readonly now: () => number = () => Date.now(),
    log?: Logger,
  ) {
    this.log = log ?? createLogger('audit');
  }

  record(call: AuditCall): void {
    const error = call.error;
    try {
      this.storage.audit.add({
        ts: call.startedAt,
        userId: call.userId,
        accountId: call.accountId,
        tool: call.tool,
        args: compactArgs(call.args),
        peerKey: call.peerKey ?? null,
        resultCount: call.resultCount ?? null,
        durationMs: Math.max(0, this.now() - call.startedAt),
        errorCode: error === undefined ? null : isGatewayError(error) ? error.code : 'INTERNAL',
        floodWaitSeconds: isGatewayError(error, 'FLOOD_WAIT') ? (error.retryAfter ?? null) : null,
      });
    } catch (err) {
      // Audit storage failures must not fail the tool call.
      this.log.error('audit write failed', { error: err as Error, tool: call.tool });
    }
  }
}
