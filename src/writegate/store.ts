/**
 * Write gateway storage: confirmation requests and a journal of executed
 * actions. The journal tracks daily caps for replies, reactions, joins,
 * and new conversations.
 */
import type { SqliteStorage } from '../storage/sqlite.js';

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
function json<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || v === '') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

export type ApprovalState = 'pending' | 'executing' | 'executed' | 'rejected' | 'expired' | 'failed';

export interface ApprovalRecord {
  id: string;
  /** Decision owner: the user who requested the action (decision 18). */
  userId: string;
  accountId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  preview: string;
  state: ApprovalState;
  result: Record<string, unknown> | null;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
}

export interface WriteRecord {
  ts: number;
  userId: string;
  accountId: string;
  kind: 'reply' | 'send' | 'join' | 'react';
  chatKey: string;
  postId: number | null;
  sentMessageId: number | null;
}

export class WriteStore {
  constructor(
    private readonly db: SqliteStorage,
    private readonly now: () => number = () => Date.now(),
  ) {}

  // ---------- confirmation requests ----------

  private mapApproval(r: Row): ApprovalRecord {
    return {
      id: str(r.id),
      userId: str(r.user_id),
      accountId: strOrNull(r.account_id),
      kind: str(r.kind),
      payload: json<Record<string, unknown>>(r.payload, {}),
      preview: str(r.preview),
      state: str(r.state) as ApprovalState,
      result: json<Record<string, unknown> | null>(r.result, null),
      createdAt: num(r.created_at),
      expiresAt: num(r.expires_at),
      decidedAt: numOrNull(r.decided_at),
    };
  }

  createApproval(a: Pick<ApprovalRecord, 'id' | 'userId' | 'accountId' | 'kind' | 'payload' | 'preview' | 'expiresAt'>): ApprovalRecord {
    this.db
      .prepare(
        `INSERT INTO approvals (id, user_id, account_id, kind, payload, preview, state, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(a.id, a.userId, a.accountId, a.kind, JSON.stringify(a.payload), a.preview, this.now(), a.expiresAt);
    return this.getApproval(a.id)!;
  }

  getApproval(id: string): ApprovalRecord | null {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined;
    return row ? this.mapApproval(row) : null;
  }

  updateApproval(id: string, patch: Partial<Pick<ApprovalRecord, 'state' | 'payload' | 'result'>>): void {
    const current = this.getApproval(id);
    if (!current) return;
    this.db
      .prepare('UPDATE approvals SET state = ?, payload = ?, result = ? WHERE id = ?')
      .run(
        patch.state ?? current.state,
        JSON.stringify(patch.payload ?? current.payload),
        patch.result === undefined ? (current.result === null ? null : JSON.stringify(current.result)) : patch.result === null ? null : JSON.stringify(patch.result),
        id,
      );
  }

  /**
   * Atomic state transition: returns true only when the record was in
   * an expected state. Prevents duplicate confirmation.
   */
  transitionApproval(id: string, from: ApprovalState[], to: ApprovalState): boolean {
    const marks = from.map(() => '?').join(', ');
    const result = this.db.prepare(`UPDATE approvals SET state = ?, decided_at = ? WHERE id = ? AND state IN (${marks})`).run(to, this.now(), id, ...from);
    return num(result.changes) > 0;
  }

  /** Lists a user's requests in selected states, newest first. */
  listApprovals(userId: string, states: ApprovalState[], limit = 100): ApprovalRecord[] {
    const marks = states.map(() => '?').join(', ');
    return (this.db.prepare(`SELECT * FROM approvals WHERE user_id = ? AND state IN (${marks}) ORDER BY created_at DESC LIMIT ?`).all(userId, ...states, limit) as Row[]).map(r =>
      this.mapApproval(r),
    );
  }

  approvalsInState(state: ApprovalState): ApprovalRecord[] {
    return (this.db.prepare('SELECT * FROM approvals WHERE state = ? ORDER BY created_at').all(state) as Row[]).map(r => this.mapApproval(r));
  }

  /** Marks overdue requests as `expired` and returns their count. */
  expireApprovals(): number {
    return num(this.db.prepare("UPDATE approvals SET state = 'expired', decided_at = ? WHERE state = 'pending' AND expires_at <= ?").run(this.now(), this.now()).changes);
  }

  /** Deletes old resolved requests because they contain message texts. */
  pruneApprovals(olderThanTs: number): number {
    return num(this.db.prepare("DELETE FROM approvals WHERE state != 'pending' AND state != 'executing' AND created_at < ?").run(olderThanTs).changes);
  }

  // ---------- write journal ----------

  recordWrite(write: WriteRecord): number {
    const result = this.db
      .prepare('INSERT INTO writes (ts, user_id, account_id, kind, chat_key, post_id, sent_message_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(write.ts, write.userId, write.accountId, write.kind, write.chatKey, write.postId, write.sentMessageId);
    return num(result.lastInsertRowid);
  }

  writesSince(accountId: string, kind: WriteRecord['kind'], sinceTs: number): number {
    return num((this.db.prepare('SELECT COUNT(*) AS n FROM writes WHERE account_id = ? AND kind = ? AND ts >= ?').get(accountId, kind, sinceTs) as Row).n);
  }

  /** Checks prior contact with this person from this account for the new-conversation cap. */
  hasWrittenTo(accountId: string, chatKey: string): boolean {
    return this.db.prepare("SELECT 1 AS ok FROM writes WHERE account_id = ? AND chat_key = ? AND kind = 'send' LIMIT 1").get(accountId, chatKey) !== undefined;
  }

  newDialogsSince(accountId: string, sinceTs: number): number {
    return num(
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM (
               SELECT chat_key, MIN(ts) AS first_ts FROM writes WHERE account_id = ? AND kind = 'send' AND chat_key NOT LIKE '-%' GROUP BY chat_key
             ) WHERE first_ts >= ?`,
          )
          .get(accountId, sinceTs) as Row
      ).n,
    );
  }
}
