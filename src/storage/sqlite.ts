/**
 * SQLite storage using built-in `node:sqlite` (decision 19).
 * A single file without external services. PRAGMA user_version versions the schema.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Sealed } from '../core/crypto.js';
import type { PeerKind } from '../core/chatId.js';
import type {
  AccountRecord,
  AccountStatus,
  AccountsRepo,
  AuditEntry,
  AuditRepo,
  EntitiesRepo,
  EntityRecord,
  JobRecord,
  JobState,
  JobsRepo,
  KvRepo,
  ScopeEffect,
  ScopeRule,
  ScopesRepo,
  SessionsRepo,
  Storage,
  UserRecord,
  UsersRepo,
} from './port.js';
import { MIGRATIONS } from './migrations.js';

type Row = Record<string, unknown>;

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function strOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function num(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
}

function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export interface SqliteStorageOptions {
  /** File path, or ':memory:' for tests. */
  path: string;
  now?: () => number;
}

export class SqliteStorage implements Storage {
  readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly statements = new Map<string, StatementSync>();
  private txDepth = 0;
  private closed = false;

  readonly users: UsersRepo;
  readonly accounts: AccountsRepo;
  readonly sessions: SessionsRepo;
  readonly entities: EntitiesRepo;
  readonly audit: AuditRepo;
  readonly jobs: JobsRepo;
  readonly scopes: ScopesRepo;
  readonly kv: KvRepo;

  constructor(options: SqliteStorageOptions) {
    this.db = new DatabaseSync(options.path);
    this.now = options.now ?? (() => Date.now());
    this.db.exec('PRAGMA foreign_keys = ON');
    if (options.path !== ':memory:') {
      // Set the busy timeout first: the daemon and owner commands open the database concurrently.
      this.db.exec('PRAGMA busy_timeout = 5000');
      this.db.exec('PRAGMA journal_mode = WAL');
    }
    this.migrate();

    this.users = this.createUsersRepo();
    this.accounts = this.createAccountsRepo();
    this.sessions = this.createSessionsRepo();
    this.entities = this.createEntitiesRepo();
    this.audit = this.createAuditRepo();
    this.jobs = this.createJobsRepo();
    this.scopes = this.createScopesRepo();
    this.kv = this.createKvRepo();
  }

  /** Schema version after migrations. */
  schemaVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as Row | undefined;
    return num(row?.user_version);
  }

  private migrate(): void {
    const current = this.schemaVersion();
    for (let version = current; version < MIGRATIONS.length; version++) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        // Another process may have applied the migration while this one waited for the lock.
        if (this.schemaVersion() > version) {
          this.db.exec('COMMIT');
          continue;
        }
        this.db.exec(MIGRATIONS[version]!);
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw new Error(`storage migration ${version + 1} failed: ${(err as Error).message}`);
      }
    }
  }

  /** Prepared statements are cached by query text. */
  prepare(sql: string): StatementSync {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      // Nested calls run inside the outer transaction.
      return fn();
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth++;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.db.close();
  }

  // ---------- users ----------

  private createUsersRepo(): UsersRepo {
    const map = (row: Row): UserRecord => ({
      id: str(row.id),
      tokenSha256: str(row.token_sha256),
      defaultAccount: strOrNull(row.default_account),
      createdAt: num(row.created_at),
    });
    return {
      create: user => {
        this.prepare('INSERT INTO users (id, token_sha256, default_account, created_at) VALUES (?, ?, ?, ?)').run(
          user.id,
          user.tokenSha256,
          user.defaultAccount ?? null,
          this.now(),
        );
        return map(this.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as Row);
      },
      get: id => {
        const row = this.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
        return row ? map(row) : null;
      },
      findByTokenHash: hash => {
        const row = this.prepare('SELECT * FROM users WHERE token_sha256 = ?').get(hash) as Row | undefined;
        return row ? map(row) : null;
      },
      list: () => (this.prepare('SELECT * FROM users ORDER BY id').all() as Row[]).map(map),
      update: (id, patch) => {
        if (patch.tokenSha256 !== undefined) {
          this.prepare('UPDATE users SET token_sha256 = ? WHERE id = ?').run(patch.tokenSha256, id);
        }
        if (patch.defaultAccount !== undefined) {
          this.prepare('UPDATE users SET default_account = ? WHERE id = ?').run(patch.defaultAccount, id);
        }
      },
      remove: id => {
        this.prepare('DELETE FROM users WHERE id = ?').run(id);
      },
    };
  }

  // ---------- accounts ----------

  private createAccountsRepo(): AccountsRepo {
    const map = (row: Row): AccountRecord => ({
      id: str(row.id),
      tgUserId: strOrNull(row.tg_user_id),
      username: strOrNull(row.username),
      displayName: strOrNull(row.display_name),
      status: str(row.status) as AccountStatus,
      createdAt: num(row.created_at),
      updatedAt: num(row.updated_at),
    });
    const get = (id: string): AccountRecord | null => {
      const row = this.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Row | undefined;
      return row ? map(row) : null;
    };
    return {
      upsert: account => {
        const existing = get(account.id);
        const now = this.now();
        if (!existing) {
          this.prepare(
            'INSERT INTO accounts (id, tg_user_id, username, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ).run(
            account.id,
            account.tgUserId ?? null,
            account.username ?? null,
            account.displayName ?? null,
            account.status ?? 'needs_login',
            now,
            now,
          );
        } else {
          this.prepare(
            'UPDATE accounts SET tg_user_id = ?, username = ?, display_name = ?, status = ?, updated_at = ? WHERE id = ?',
          ).run(
            account.tgUserId !== undefined ? account.tgUserId : existing.tgUserId,
            account.username !== undefined ? account.username : existing.username,
            account.displayName !== undefined ? account.displayName : existing.displayName,
            account.status ?? existing.status,
            now,
            account.id,
          );
        }
        return get(account.id)!;
      },
      get,
      list: () => (this.prepare('SELECT * FROM accounts ORDER BY id').all() as Row[]).map(map),
      setStatus: (id, status) => {
        this.prepare('UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?').run(status, this.now(), id);
      },
      remove: id => {
        this.prepare('DELETE FROM accounts WHERE id = ?').run(id);
      },
      grant: (accountId, userId) => {
        this.prepare('INSERT OR IGNORE INTO account_access (account_id, user_id) VALUES (?, ?)').run(accountId, userId);
      },
      revoke: (accountId, userId) => {
        this.prepare('DELETE FROM account_access WHERE account_id = ? AND user_id = ?').run(accountId, userId);
      },
      hasAccess: (userId, accountId) =>
        this.prepare('SELECT 1 AS ok FROM account_access WHERE account_id = ? AND user_id = ?').get(accountId, userId) !==
        undefined,
      accountsOf: userId =>
        (
          this.prepare(
            'SELECT a.* FROM accounts a JOIN account_access x ON x.account_id = a.id WHERE x.user_id = ? ORDER BY a.id',
          ).all(userId) as Row[]
        ).map(map),
      usersOf: accountId =>
        (this.prepare('SELECT user_id FROM account_access WHERE account_id = ? ORDER BY user_id').all(accountId) as Row[]).map(
          r => str(r.user_id),
        ),
    };
  }

  // ---------- sessions ----------

  private createSessionsRepo(): SessionsRepo {
    return {
      put: (accountId, sealed: Sealed) => {
        this.prepare(
          `INSERT INTO sessions (account_id, data, iv, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET data = excluded.data, iv = excluded.iv, updated_at = excluded.updated_at`,
        ).run(accountId, sealed.data, sealed.iv, this.now());
      },
      get: accountId => {
        const row = this.prepare('SELECT data, iv FROM sessions WHERE account_id = ?').get(accountId) as Row | undefined;
        return row ? { data: str(row.data), iv: str(row.iv) } : null;
      },
    };
  }

  // ---------- entities ----------

  private createEntitiesRepo(): EntitiesRepo {
    const map = (row: Row): EntityRecord => ({
      accountId: str(row.account_id),
      peerKey: str(row.peer_key),
      kind: str(row.kind) as PeerKind,
      accessHash: strOrNull(row.access_hash),
      username: strOrNull(row.username),
      title: strOrNull(row.title),
      meta: parseJson<Record<string, unknown>>(row.meta, {}),
      updatedAt: num(row.updated_at),
    });
    const put = (entity: Omit<EntityRecord, 'updatedAt'>): void => {
      // A username belongs to one chat; remove it from the old chat when another claims it.
      // Otherwise requests and approved messages could target the former chat.
      if (entity.username) {
        this.prepare('UPDATE entities SET username = NULL WHERE account_id = ? AND username = ? AND peer_key != ?').run(
          entity.accountId,
          entity.username.toLowerCase(),
          entity.peerKey,
        );
      }
      // Do not overwrite accessHash and username with missing values: partial
      // (min) objects omit them and must not damage the cache.
      this.prepare(
        `INSERT INTO entities (account_id, peer_key, kind, access_hash, username, title, meta, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, peer_key) DO UPDATE SET
           kind = excluded.kind,
           access_hash = COALESCE(excluded.access_hash, entities.access_hash),
           -- Partial (min) objects omit usernames and preserve cached values. Full
           -- objects store the supplied username, clearing names that were removed.
           username = CASE WHEN excluded.meta = '{}' THEN COALESCE(excluded.username, entities.username) ELSE excluded.username END,
           title = COALESCE(excluded.title, entities.title),
           meta = CASE WHEN excluded.meta = '{}' THEN entities.meta ELSE excluded.meta END,
           updated_at = excluded.updated_at`,
      ).run(
        entity.accountId,
        entity.peerKey,
        entity.kind,
        entity.accessHash,
        entity.username ? entity.username.toLowerCase() : null,
        entity.title,
        JSON.stringify(entity.meta ?? {}),
        this.now(),
      );
    };
    return {
      put,
      putMany: entities => {
        if (entities.length === 0) return;
        this.transaction(() => {
          for (const e of entities) put(e);
        });
      },
      get: (accountId, peerKey) => {
        const row = this.prepare('SELECT * FROM entities WHERE account_id = ? AND peer_key = ?').get(accountId, peerKey) as
          | Row
          | undefined;
        return row ? map(row) : null;
      },
      getByUsername: (accountId, username) => {
        const row = this.prepare(
          'SELECT * FROM entities WHERE account_id = ? AND username = ? ORDER BY updated_at DESC LIMIT 1',
        ).get(accountId, username.replace(/^@/, '').toLowerCase()) as Row | undefined;
        return row ? map(row) : null;
      },
      remove: (accountId, peerKey) => {
        this.prepare('DELETE FROM entities WHERE account_id = ? AND peer_key = ?').run(accountId, peerKey);
      },
    };
  }

  // ---------- audit ----------

  private createAuditRepo(): AuditRepo {
    const map = (row: Row): AuditEntry => ({
      id: num(row.id),
      ts: num(row.ts),
      userId: strOrNull(row.user_id),
      accountId: strOrNull(row.account_id),
      tool: str(row.tool),
      args: parseJson<Record<string, unknown>>(row.args, {}),
      peerKey: strOrNull(row.peer_key),
      resultCount: numOrNull(row.result_count),
      durationMs: num(row.duration_ms),
      errorCode: strOrNull(row.error_code),
      floodWaitSeconds: numOrNull(row.flood_wait_seconds),
    });
    return {
      add: entry => {
        const result = this.prepare(
          `INSERT INTO audit (ts, user_id, account_id, tool, args, peer_key, result_count, duration_ms, error_code, flood_wait_seconds)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          entry.ts,
          entry.userId,
          entry.accountId,
          entry.tool,
          JSON.stringify(entry.args ?? {}),
          entry.peerKey,
          entry.resultCount,
          entry.durationMs,
          entry.errorCode,
          entry.floodWaitSeconds,
        );
        return num(result.lastInsertRowid);
      },
      recent: (filter = {}) => {
        const where: string[] = [];
        const params: Array<string | number> = [];
        if (filter.userId) {
          where.push('user_id = ?');
          params.push(filter.userId);
        }
        if (filter.accountId) {
          where.push('account_id = ?');
          params.push(filter.accountId);
        }
        if (filter.tool) {
          where.push('tool = ?');
          params.push(filter.tool);
        }
        const sql = `SELECT * FROM audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
        params.push(Math.min(Math.max(1, filter.limit ?? 50), 1000));
        return (this.prepare(sql).all(...params) as Row[]).map(map);
      },
      prune: olderThanTs => num(this.prepare('DELETE FROM audit WHERE ts < ?').run(olderThanTs).changes),
    };
  }

  // ---------- jobs ----------

  private createJobsRepo(): JobsRepo {
    const map = (row: Row): JobRecord => ({
      id: str(row.id),
      userId: str(row.user_id),
      accountId: strOrNull(row.account_id),
      kind: str(row.kind),
      params: parseJson<Record<string, unknown>>(row.params, {}),
      state: str(row.state) as JobState,
      progress: parseJson<Record<string, unknown>>(row.progress, {}),
      result: parseJson<Record<string, unknown> | null>(row.result, null),
      error: strOrNull(row.error),
      createdAt: num(row.created_at),
      updatedAt: num(row.updated_at),
    });
    const get = (id: string): JobRecord | null => {
      const row = this.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined;
      return row ? map(row) : null;
    };
    return {
      create: job => {
        const now = this.now();
        this.prepare(
          `INSERT INTO jobs (id, user_id, account_id, kind, params, state, progress, result, error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'queued', '{}', NULL, NULL, ?, ?)`,
        ).run(job.id, job.userId, job.accountId ?? null, job.kind, JSON.stringify(job.params), now, now);
        return get(job.id)!;
      },
      get,
      update: (id, patch) => {
        const sets: string[] = ['updated_at = ?'];
        const params: Array<string | number | null> = [this.now()];
        if (patch.state !== undefined) {
          sets.push('state = ?');
          params.push(patch.state);
        }
        if (patch.progress !== undefined) {
          sets.push('progress = ?');
          params.push(JSON.stringify(patch.progress));
        }
        if (patch.result !== undefined) {
          sets.push('result = ?');
          params.push(patch.result === null ? null : JSON.stringify(patch.result));
        }
        if (patch.error !== undefined) {
          sets.push('error = ?');
          params.push(patch.error);
        }
        params.push(id);
        this.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      },
      list: (filter = {}) => {
        const where: string[] = [];
        const params: Array<string | number> = [];
        if (filter.userId) {
          where.push('user_id = ?');
          params.push(filter.userId);
        }
        if (filter.state) {
          where.push('state = ?');
          params.push(filter.state);
        }
        const order = filter.oldestFirst ? 'created_at ASC, rowid ASC' : 'created_at DESC, rowid DESC';
        const sql = `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ?`;
        params.push(Math.min(Math.max(1, filter.limit ?? 50), 500));
        return (this.prepare(sql).all(...params) as Row[]).map(map);
      },
      requeueRunning: () =>
        num(
          this.prepare("UPDATE jobs SET state = 'queued', updated_at = ? WHERE state = 'running'").run(this.now()).changes,
        ),
    };
  }

  // ---------- scopes ----------

  private createScopesRepo(): ScopesRepo {
    const map = (row: Row): ScopeRule => ({
      userId: str(row.user_id),
      accountId: str(row.account_id),
      target: str(row.target),
      effect: str(row.effect) as ScopeEffect,
      createdAt: num(row.created_at),
    });
    return {
      put: rule => {
        this.prepare(
          `INSERT INTO scope_rules (user_id, account_id, target, effect, created_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, account_id, target) DO UPDATE SET effect = excluded.effect`,
        ).run(rule.userId, rule.accountId, rule.target.replace(/^@/, '').toLowerCase(), rule.effect, this.now());
      },
      list: (userId, accountId) =>
        (
          this.prepare('SELECT * FROM scope_rules WHERE user_id = ? AND account_id = ? ORDER BY target').all(
            userId,
            accountId,
          ) as Row[]
        ).map(map),
      remove: (userId, accountId, target) =>
        num(
          this.prepare('DELETE FROM scope_rules WHERE user_id = ? AND account_id = ? AND target = ?').run(
            userId,
            accountId,
            target.replace(/^@/, '').toLowerCase(),
          ).changes,
        ),
    };
  }

  // ---------- kv ----------

  private createKvRepo(): KvRepo {
    return {
      get: key => {
        const row = this.prepare('SELECT value FROM kv WHERE key = ?').get(key) as Row | undefined;
        return row ? str(row.value) : null;
      },
      set: (key, value) => {
        this.prepare(
          'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        ).run(key, value);
      },
    };
  }
}

export function openStorage(path: string, now?: () => number): SqliteStorage {
  return new SqliteStorage({ path, now });
}
