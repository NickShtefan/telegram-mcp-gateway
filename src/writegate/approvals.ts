/**
 * Write confirmation. Every action that changes Telegram state
 * uses two steps (decisions 4 and 23): a write tool creates a request
 * and returns a preview; the gateway executes it after `tg_confirm`.
 *
 * Requests have a short lifetime for the conversation between agent and owner
 * (a proposed action and consent). The gateway does not maintain a draft queue.
 */
import { randomBytes } from 'node:crypto';
import { GatewayError, isGatewayError } from '../core/errors.js';
import { createLogger, type Logger } from '../core/log.js';
import { sanitizeOutgoing } from '../policy/envelope.js';
import { MESSAGE_MAX_CHARS } from '../services/write.js';
import type { ApprovalRecord, WriteStore } from './store.js';

export interface ApprovalRequest {
  userId: string;
  accountId: string | null;
  kind: string;
  /** Action arguments. The owner can replace the draft in the `text` field. */
  payload: Record<string, unknown>;
  /** Gateway-generated description of what will happen and where, without untrusted text. */
  title: string;
}

/** Action executor after confirmation. Returns a one-line outcome for the agent. */
export type ApprovalExecutor = (approval: ApprovalRecord) => Promise<{ summary: string; data?: Record<string, unknown> }>;

interface ExecutorEntry {
  run: ApprovalExecutor;
  /** Whether confirmation can replace the draft text. */
  editable: boolean;
}

export interface ApprovalsOptions {
  store: WriteStore;
  log?: Logger;
  now?: () => number;
  ttlMs?: number;
}

/** Request lifetime: time to present a preview and obtain a response. */
export const APPROVAL_TTL_MS = 30 * 60 * 1000;
/** Retention period for resolved requests. */
const KEEP_DECIDED_MS = 7 * 24 * 60 * 60 * 1000;

/** Exact outgoing action text shown in the preview and sent to Telegram. */
function cleanDraft(text: string): string {
  const clean = sanitizeOutgoing(text).trim();
  if (!clean) throw new GatewayError('INVALID_ARGUMENT', 'Message text is empty.');
  if (clean.length > MESSAGE_MAX_CHARS) {
    throw new GatewayError('INVALID_ARGUMENT', `Message text is ${clean.length} characters, the Telegram limit is ${MESSAGE_MAX_CHARS}.`);
  }
  return clean;
}

export class Approvals {
  private readonly store: WriteStore;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly executors = new Map<string, ExecutorEntry>();

  constructor(options: ApprovalsOptions) {
    this.store = options.store;
    this.log = options.log ?? createLogger('approvals');
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? APPROVAL_TTL_MS;
  }

  register(kind: string, run: ApprovalExecutor, options: { editable?: boolean } = {}): void {
    this.executors.set(kind, { run, editable: options.editable ?? false });
  }

  /** Creates an action request without changing anything in Telegram. */
  request(request: ApprovalRequest): ApprovalRecord {
    if (!this.executors.has(request.kind)) throw new GatewayError('INVALID_ARGUMENT', `Unknown action kind "${request.kind}".`);
    // Confirm exactly what will be sent: sanitize before the preview, not afterward.
    const payload = typeof request.payload.text === 'string' ? { ...request.payload, text: cleanDraft(request.payload.text) } : request.payload;
    return this.store.createApproval({
      id: `ap_${randomBytes(5).toString('hex')}`,
      userId: request.userId,
      accountId: request.accountId,
      kind: request.kind,
      payload,
      preview: request.title,
      expiresAt: this.now() + this.ttlMs,
    });
  }

  /** Finds a pending request of the same kind to prevent duplicates. */
  findPending(userId: string, kind: string, match: (payload: Record<string, unknown>) => boolean): ApprovalRecord | null {
    return this.store.listApprovals(userId, ['pending', 'executing']).find(a => a.kind === kind && a.expiresAt > this.now() && match(a.payload)) ?? null;
  }

  /** Looks up a user request. Another user's request is indistinguishable from a missing one. */
  status(id: string, userId: string): ApprovalRecord {
    const approval = this.store.getApproval(id);
    if (!approval || approval.userId !== userId) throw new GatewayError('NOT_FOUND', `Approval "${id}" not found.`);
    return approval;
  }

  /**
   * Confirms and executes an action. `text` replaces the draft with
   * the owner's wording. Repeated calls do not execute it again:
   * they return the record with the known outcome.
   */
  async confirm(id: string, userId: string, text?: string): Promise<ApprovalRecord> {
    const approval = this.status(id, userId);
    if (approval.state !== 'pending') return approval;
    if (approval.expiresAt <= this.now()) {
      this.store.transitionApproval(id, ['pending'], 'expired');
      throw new GatewayError('LIMIT_REACHED', `Approval ${id} has expired. Nothing was done: prepare the action again if it is still needed.`);
    }
    if (text !== undefined) {
      if (this.executors.get(approval.kind)?.editable !== true) throw new GatewayError('INVALID_ARGUMENT', 'This request has no text to replace.');
      this.store.updateApproval(id, { payload: { ...approval.payload, text: cleanDraft(text), editedByOwner: true } });
    }
    await this.execute(id);
    return this.store.getApproval(id)!;
  }

  /** Rejects a request without executing the action. */
  reject(id: string, userId: string): ApprovalRecord {
    this.status(id, userId);
    this.store.transitionApproval(id, ['pending'], 'rejected');
    return this.store.getApproval(id)!;
  }

  /** Executes a confirmed action. Concurrent confirmations cannot execute it twice. */
  private async execute(id: string): Promise<void> {
    if (!this.store.transitionApproval(id, ['pending'], 'executing')) return;
    const approval = this.store.getApproval(id)!;
    const entry = this.executors.get(approval.kind);
    try {
      if (!entry) throw new GatewayError('INVALID_ARGUMENT', `No executor for "${approval.kind}".`);
      const outcome = await entry.run(approval);
      this.store.updateApproval(id, { state: 'executed', result: { summary: outcome.summary, ...(outcome.data ?? {}) } });
    } catch (err) {
      const message = isGatewayError(err) ? `${err.code}: ${err.message}` : (err as Error).message;
      this.log.warn('confirmed action failed', { approval: id, kind: approval.kind, error: message });
      // Store the error code separately so the confirming agent receives a normal tool error.
      const detail = isGatewayError(err) ? { code: err.code, message: err.message, retry_after: err.retryAfter, outcome_unknown: err.outcomeUnknown === true } : {};
      this.store.updateApproval(id, { state: 'failed', result: { error: message, ...detail } });
    }
  }

  /**
   * After a restart, actions interrupted during execution have unknown outcomes.
   * The gateway cannot know whether Telegram received them and will not retry them.
   */
  recover(): number {
    const stuck = this.store.approvalsInState('executing');
    for (const approval of stuck) {
      this.store.updateApproval(approval.id, {
        state: 'failed',
        result: { error: 'The gateway restarted while this action was being executed. The outcome is unknown: check in Telegram before repeating it.' },
      });
    }
    return stuck.length;
  }

  /** Housekeeping: expire pending requests and delete old resolved records. */
  sweep(): number {
    const expired = this.store.expireApprovals();
    this.store.pruneApprovals(this.now() - KEEP_DECIDED_MS);
    return expired;
  }
}
