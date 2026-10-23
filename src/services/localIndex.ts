/**
 * Local index: selected chat messages are stored in the gateway database;
 * searches require no Telegram requests or rate-limit budget.
 *
 * Indexing runs as a job because initial imports can be slow. Repeated
 * runs fetch updates using date-bounded history and batch inserts;
 * each chat has independent SQLite state.
 *
 * FTS5 trigram search matches substrings such as 'bicycle' in 'bicycles'
 * regardless of case. Trigrams cannot match words shorter than three
 * characters, so verify those separately against candidate rows.
 */
import { GatewayError } from '../core/errors.js';
import type { TgCallOptions } from '../core/tg.js';
import type { EntityRecord, Storage } from '../storage/port.js';
import type { SqliteStorage } from '../storage/sqlite.js';
import { PAGE_MAX, type HistoryService } from './history.js';
import type { JobContext } from './jobs.js';
import type { MessageDto } from './messages.js';

export const INDEX_DEFAULT_DAYS = 90;
export const INDEX_MAX_DAYS = 3 * 365;
/** Message cap per job; 100 messages require one Telegram request. */
export const INDEX_MAX_PER_RUN = 20_000;
/** Refresh recent messages whose counters may still change. */
const REFRESH_WINDOW_SEC = 3 * 86_400;
const MIN_TERM = 3;

type Row = Record<string, unknown>;

export interface IndexedChat {
  accountId: string;
  chatKey: string;
  /** Index completeness boundary in Unix seconds. */
  sinceTs: number;
  newestId: number;
  oldestId: number;
  /** Last incremental indexing time, milliseconds. */
  syncedAt: number | null;
  createdBy: string;
  messages: number;
}

export class IndexStore {
  constructor(
    private readonly storage: SqliteStorage,
    private readonly now: () => number = () => Date.now(),
  ) {
    // JavaScript case folding preserves Unicode behavior for short words.
    this.storage.db.function('tg_lower', { deterministic: true }, value => String(value ?? '').toLowerCase());
  }

  private map(r: Row): IndexedChat {
    return {
      accountId: String(r.account_id),
      chatKey: String(r.chat_key),
      sinceTs: Number(r.since_ts),
      newestId: Number(r.newest_id),
      oldestId: Number(r.oldest_id),
      syncedAt: r.synced_at === null || r.synced_at === undefined ? null : Number(r.synced_at),
      createdBy: String(r.created_by),
      messages: Number(r.messages ?? 0),
    };
  }

  private static readonly SELECT = `SELECT c.*, (SELECT COUNT(*) FROM indexed_messages m WHERE m.account_id = c.account_id AND m.chat_key = c.chat_key) AS messages FROM indexed_chats c`;

  get(accountId: string, chatKey: string): IndexedChat | null {
    const row = this.storage.db.prepare(`${IndexStore.SELECT} WHERE c.account_id = ? AND c.chat_key = ?`).get(accountId, chatKey) as Row | undefined;
    return row ? this.map(row) : null;
  }

  list(accountIds: string[]): IndexedChat[] {
    if (accountIds.length === 0) return [];
    const marks = accountIds.map(() => '?').join(', ');
    return (this.storage.db.prepare(`${IndexStore.SELECT} WHERE c.account_id IN (${marks}) ORDER BY c.account_id, c.chat_key`).all(...accountIds) as Row[]).map(r => this.map(r));
  }

  /** Stores chat state after a completed pass. */
  saveState(state: { accountId: string; chatKey: string; sinceTs: number; newestId: number; oldestId: number; createdBy: string }): void {
    this.storage.db
      .prepare(
        `INSERT INTO indexed_chats (account_id, chat_key, since_ts, newest_id, oldest_id, synced_at, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, chat_key) DO UPDATE SET
           since_ts = excluded.since_ts, newest_id = excluded.newest_id, oldest_id = excluded.oldest_id, synced_at = excluded.synced_at`,
      )
      .run(state.accountId, state.chatKey, state.sinceTs, state.newestId, state.oldestId, this.now(), state.createdBy, this.now());
  }

  /** Inserts or updates one message batch and returns the number of new rows. */
  upsert(accountId: string, chatKey: string, messages: MessageDto[]): number {
    if (messages.length === 0) return 0;
    const db = this.storage.db;
    const find = db.prepare('SELECT rowid, dto FROM indexed_messages WHERE account_id = ? AND chat_key = ? AND message_id = ?');
    const insert = db.prepare('INSERT INTO indexed_messages (account_id, chat_key, message_id, date, dto) VALUES (?, ?, ?, ?, ?)');
    const update = db.prepare('UPDATE indexed_messages SET date = ?, dto = ? WHERE rowid = ?');
    const ftsInsert = db.prepare('INSERT INTO indexed_fts (rowid, text) VALUES (?, ?)');
    const ftsDelete = db.prepare('DELETE FROM indexed_fts WHERE rowid = ?');

    return this.storage.transaction(() => {
      let added = 0;
      for (const m of messages) {
        const dto = JSON.stringify(m);
        const existing = find.get(accountId, chatKey, m.id) as Row | undefined;
        if (!existing) {
          const rowid = Number(insert.run(accountId, chatKey, m.id, m.date, dto).lastInsertRowid);
          if (m.text) ftsInsert.run(rowid, m.text);
          added++;
          continue;
        }
        const rowid = Number(existing.rowid);
        const before = (JSON.parse(String(existing.dto)) as MessageDto).text;
        update.run(m.date, dto, rowid);
        if (before !== m.text) {
          ftsDelete.run(rowid);
          if (m.text) ftsInsert.run(rowid, m.text);
        }
      }
      return added;
    });
  }

  remove(accountId: string, chatKey: string): number {
    return this.storage.transaction(() => {
      // A message-deletion trigger removes its search text.
      const removed = Number(this.storage.db.prepare('DELETE FROM indexed_messages WHERE account_id = ? AND chat_key = ?').run(accountId, chatKey).changes);
      this.storage.db.prepare('DELETE FROM indexed_chats WHERE account_id = ? AND chat_key = ?').run(accountId, chatKey);
      return removed;
    });
  }

  search(params: {
    targets: Array<{ accountId: string; chatKey: string }>;
    match: string;
    shortTerms?: string[];
    minDate?: number;
    maxDate?: number;
    limit: number;
    offset: number;
  }): { messages: Array<{ accountId: string; message: MessageDto }>; total: number } {
    if (params.targets.length === 0) return { messages: [], total: 0 };
    const where = [`indexed_fts MATCH ?`, `(${params.targets.map(() => '(m.account_id = ? AND m.chat_key = ?)').join(' OR ')})`];
    const args: Array<string | number> = [params.match, ...params.targets.flatMap(t => [t.accountId, t.chatKey])];
    if (params.minDate !== undefined) {
      where.push('m.date >= ?');
      args.push(params.minDate);
    }
    if (params.maxDate !== undefined) {
      where.push('m.date <= ?');
      args.push(params.maxDate);
    }
    // Apply every short word before counting and paginating candidates.
    for (const term of params.shortTerms ?? []) {
      where.push("instr(tg_lower(json_extract(m.dto, '$.text')), ?) > 0");
      args.push(term);
    }
    const from = `FROM indexed_fts JOIN indexed_messages m ON m.rowid = indexed_fts.rowid WHERE ${where.join(' AND ')}`;
    const total = Number((this.storage.db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...args) as Row).n);
    const rows = this.storage.db.prepare(`SELECT m.account_id, m.dto ${from} ORDER BY m.date DESC, m.message_id DESC, m.account_id, m.chat_key LIMIT ? OFFSET ?`).all(...args, params.limit, params.offset) as Row[];
    return { messages: rows.map(r => ({ accountId: String(r.account_id), message: JSON.parse(String(r.dto)) as MessageDto })), total };
  }
}

/** Long query words use FTS; short words are checked against candidates. */
export function buildMatch(query: string): { match: string; short: string[] } {
  const terms = query
    .split(/\s+/)
    .map(t => t.replace(/^["'«»]+|["'«»]+$/g, ''))
    .filter(Boolean);
  const long = terms.filter(t => [...t].length >= MIN_TERM);
  if (long.length === 0) {
    throw new GatewayError('INVALID_ARGUMENT', `The local index needs at least one query word of ${MIN_TERM} or more characters.`);
  }
  return {
    // Quote every word as a literal FTS5 substring to disable query operators.
    match: long.map(t => `"${t.split('"').join('""')}"`).join(' '),
    short: terms.filter(t => [...t].length < MIN_TERM).map(t => t.toLowerCase()),
  };
}

export interface IndexJobParams {
  accountId: string;
  chatKey: string;
  /** Index messages newer than this Unix timestamp. */
  sinceTs: number;
}

export interface IndexJobResult extends Record<string, unknown> {
  added: number;
  scanned: number;
  messages: number;
  sinceTs: number;
  /** A per-run cap stopped this job; the next run reads the remainder. */
  partial: boolean;
}

export interface LocalIndexDeps {
  storage: Storage;
  store: IndexStore;
  history: HistoryService;
  now?: () => number;
  /** Maximum messages per job run. */
  maxPerRun?: number;
}

export class LocalIndexService {
  private readonly now: () => number;
  private readonly maxPerRun: number;

  constructor(private readonly deps: LocalIndexDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.maxPerRun = deps.maxPerRun ?? INDEX_MAX_PER_RUN;
  }

  /**
   * Indexing job: refresh the history head (new messages and recent counters),
   * then extend the tail if the requested period exceeds
   * the currently covered range.
   *
   * Chat state always describes continuous coverage from the newest message
   * to `sinceTs`. If interrupted by a cap or shutdown,
   * save completed coverage so the next run can resume.
   */
  async run(context: JobContext): Promise<IndexJobResult> {
    const params = context.job.params as unknown as IndexJobParams;
    const chat = this.deps.storage.entities.get(params.accountId, params.chatKey);
    if (!chat) {
      throw new GatewayError('CHAT_NOT_FOUND', `Chat ${params.chatKey} is not in the cache of account ${params.accountId}. Resolve it with tg_resolve first.`);
    }
    const call: TgCallOptions = { priority: 'background' };
    const state = this.deps.store.get(params.accountId, params.chatKey);
    const refreshFrom = Math.floor(this.now() / 1000) - REFRESH_WINDOW_SEC;

    let scanned = 0;
    let added = 0;
    let partial = false;

    interface Walk {
      /** Pass reached its boundary: a date or previously indexed messages. */
      complete: boolean;
      highId: number;
      lowId: number;
      lowDate: number | null;
    }

    const walk = async (startOffset: number, minDate: number, stopAt?: (m: MessageDto) => boolean): Promise<Walk> => {
      const result: Walk = { complete: false, highId: 0, lowId: 0, lowDate: null };
      let offsetId = startOffset;
      for (;;) {
        if (context.stopping()) return result;
        if (scanned >= this.maxPerRun) {
          partial = true;
          return result;
        }
        const page = await this.deps.history.page(params.accountId, chat, { limit: PAGE_MAX, offsetId, minDate }, call);
        scanned += page.messages.length;
        added += this.deps.store.upsert(
          params.accountId,
          params.chatKey,
          page.messages.filter(m => m.service === null),
        );
        for (const m of page.messages) {
          result.highId = Math.max(result.highId, m.id);
          result.lowId = result.lowId === 0 ? m.id : Math.min(result.lowId, m.id);
          result.lowDate = result.lowDate === null ? m.date : Math.min(result.lowDate, m.date);
        }
        context.progress({ scanned, added });
        if (page.nextOffsetId === null || (stopAt && page.messages.some(stopAt))) {
          result.complete = true;
          return result;
        }
        offsetId = page.nextOffsetId;
      }
    };

    const save = (sinceTs: number, newestId: number, oldestId: number): void => {
      this.deps.store.saveState({ accountId: params.accountId, chatKey: params.chatKey, sinceTs, newestId, oldestId, createdBy: state?.createdBy ?? context.job.userId });
    };

    if (!state) {
      // First run: all history back to the period start.
      const first = await walk(0, params.sinceTs);
      if (first.complete) save(params.sinceTs, first.highId, first.lowId);
      else if (first.lowDate !== null) save(first.lowDate, first.highId, first.lowId);
    } else {
      // Head: read through known messages until all recent messages are refreshed.
      const head = await walk(0, state.sinceTs, m => m.id <= state.newestId && m.date < refreshFrom);
      if (head.complete) {
        let since = state.sinceTs;
        let oldest = state.oldestId === 0 ? head.lowId : head.lowId === 0 ? state.oldestId : Math.min(state.oldestId, head.lowId);
        const newest = Math.max(state.newestId, head.highId);
        save(since, newest, oldest);
        // Tail: the requested period was extended.
        if (params.sinceTs < since && !context.stopping()) {
          const tail = await walk(oldest, params.sinceTs);
          if (tail.lowId !== 0) oldest = Math.min(oldest === 0 ? tail.lowId : oldest, tail.lowId);
          if (tail.complete) since = params.sinceTs;
          else if (tail.lowDate !== null) since = Math.min(since, tail.lowDate);
          save(since, newest, oldest);
        }
      } else if (head.lowDate !== null) {
        // New messages exceeded the cap; only the recent range remains continuously covered.
        save(head.lowDate, head.highId, head.lowId);
      }
    }

    const after = this.deps.store.get(params.accountId, params.chatKey);
    return { added, scanned, messages: after?.messages ?? 0, sinceTs: after?.sinceTs ?? params.sinceTs, partial };
  }

  /** Index search; callers have already checked access to `chats`. */
  search(
    chats: Array<{ accountId: string; chat: EntityRecord }>,
    params: { query: string; minDate?: number; maxDate?: number; limit: number; offset: number },
  ): { messages: Array<{ accountId: string; message: MessageDto }>; total: number } {
    const { match, short } = buildMatch(params.query);
    const targets = chats.map(c => ({ accountId: c.accountId, chatKey: c.chat.peerKey }));
    return this.deps.store.search({ targets, match, shortTerms: short, minDate: params.minDate, maxDate: params.maxDate, limit: params.limit, offset: params.offset });
  }
}
