import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seal, sha256Hex, unseal } from '../../core/crypto.js';
import { MIGRATIONS } from '../migrations.js';
import { SqliteStorage } from '../sqlite.js';

let clock = 1_000;
let storage: SqliteStorage;

beforeEach(() => {
  clock = 1_000;
  storage = new SqliteStorage({ path: ':memory:', now: () => clock });
});

afterEach(() => {
  storage.close();
});

describe('SqliteStorage: schema', () => {
  it('applies all migrations', () => {
    expect(storage.schemaVersion()).toBe(MIGRATIONS.length);
  });

  it('retains write tables and removes automation tables after migrations', () => {
    const tables = (storage.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(t => t.name);
    expect(tables).toEqual(expect.arrayContaining(['approvals', 'writes', 'chat_snapshots', 'indexed_chats', 'indexed_messages']));
    for (const gone of ['watches', 'watch_state', 'inbox', 'rules', 'rule_fires', 'runner_jobs', 'scoped_tokens', 'tasks', 'task_messages']) {
      expect(tables, gone).not.toContain(gone);
    }
  });

  it('migrations 7 and 8 remove bot and task remnants and the single-reply cap while preserving owner scopes, approvals, and the write journal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgmcp-migrate-'));
    const path = join(dir, 'gateway.sqlite');
    try {
      // Database left by version 6.
      const old = new DatabaseSync(path);
      old.exec('PRAGMA foreign_keys = ON');
      for (const sql of MIGRATIONS.slice(0, 6)) old.exec(sql);
      old.exec('PRAGMA user_version = 6');
      old.exec(`
        INSERT INTO users (id, token_sha256, telegram_id, default_account, created_at) VALUES ('user_a', 'h1', '111', 'agent', 1);
        INSERT INTO accounts (id, status, created_at, updated_at) VALUES ('agent', 'active', 1, 1);
        INSERT INTO account_access (account_id, user_id) VALUES ('agent', 'user_a');
        INSERT INTO scope_rules (user_id, account_id, target, effect, source, created_at) VALUES
          ('user_a', 'agent', 'seller', 'allow', 'owner', 2),
          ('user_a', 'agent', '-1000000000500', 'deny', 'owner', 3),
          ('user_a', 'agent', '*private-send', 'allow', 'owner', 4),
          ('user_a', 'agent', '-1000000000500', 'allow', 'task:t1', 5),
          ('user_a', 'agent', 'stranger', 'allow', 'task:t1', 6);
        INSERT INTO approvals (id, user_id, account_id, kind, source, payload, preview, state, result, bot_chat_id, bot_message_id, created_at, expires_at, decided_at)
          VALUES ('ap_1', 'user_a', 'agent', 'reply', 'tool', '{"text":"hi"}', 'Reply', 'executed', '{"summary":"Sent"}', '123', 7, 10, 20, 15);
        INSERT INTO writes (ts, user_id, account_id, kind, chat_key, post_id, sent_message_id, source)
          VALUES (10, 'user_a', 'agent', 'reply', '-1000000000500', 10, 77, 'tool'), (11, 'user_a', 'agent', 'send', '42', NULL, 78, 'task:t1');
      `);
      old.close();

      const upgraded = new SqliteStorage({ path, now: () => 1_000 });
      try {
        expect(upgraded.schemaVersion()).toBe(MIGRATIONS.length);
        const columns = (table: string): string[] => (upgraded.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name);
        expect(columns('users')).toEqual(['id', 'token_sha256', 'default_account', 'created_at']);
        expect(columns('approvals')).not.toEqual(expect.arrayContaining(['source', 'bot_chat_id', 'bot_message_id']));
        expect(columns('writes')).not.toContain('source');
        expect(columns('scope_rules')).toEqual(['user_id', 'account_id', 'target', 'effect', 'created_at']);

        // Owner scopes survive, including private-chat mode; task-created access disappears.
        expect(upgraded.scopes.list('user_a', 'agent').map(r => `${r.effect} ${r.target}`)).toEqual(['allow *private-send', 'deny -1000000000500', 'allow seller']);
        expect(upgraded.users.get('user_a')).toMatchObject({ tokenSha256: 'h1', defaultAccount: 'agent' });
        expect(upgraded.db.prepare("SELECT state, result FROM approvals WHERE id = 'ap_1'").get()).toMatchObject({ state: 'executed', result: '{"summary":"Sent"}' });
        expect((upgraded.db.prepare('SELECT COUNT(*) AS n FROM writes').get() as { n: number }).n).toBe(2);
        // Migration 8: the database allows multiple replies to the same post.
        upgraded.db.prepare("INSERT INTO writes (ts, user_id, account_id, kind, chat_key, post_id, sent_message_id) VALUES (12, 'user_a', 'agent', 'reply', '-1000000000500', 10, 79)").run();
        expect((upgraded.db.prepare("SELECT COUNT(*) AS n FROM writes WHERE kind = 'reply' AND post_id = 10").get() as { n: number }).n).toBe(2);
        // One rule per target: another write updates it instead of adding a duplicate.
        upgraded.scopes.put({ userId: 'user_a', accountId: 'agent', target: '@Seller', effect: 'deny' });
        expect(upgraded.scopes.list('user_a', 'agent').filter(r => r.target === 'seller')).toEqual([expect.objectContaining({ effect: 'deny' })]);
        // User deletion cascades survive the table rebuild.
        upgraded.users.remove('user_a');
        expect(upgraded.scopes.list('user_a', 'agent')).toEqual([]);
      } finally {
        upgraded.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('provides FTS5 through node:sqlite', () => {
    storage.db.exec('CREATE VIRTUAL TABLE fts_probe USING fts5(body)');
    storage.db.prepare('INSERT INTO fts_probe (body) VALUES (?)').run('selling an inexpensive bicycle');
    const rows = storage.db.prepare("SELECT body FROM fts_probe WHERE fts_probe MATCH 'bicycle'").all();
    expect(rows).toHaveLength(1);
  });
});

describe('SqliteStorage: users and accounts', () => {
  it('finds users by token hash without storing the token', () => {
    const token = 'user-token';
    storage.users.create({ id: 'user_a', tokenSha256: sha256Hex(token) });
    expect(storage.users.findByTokenHash(sha256Hex(token))?.id).toBe('user_a');
    expect(storage.users.findByTokenHash(sha256Hex('other'))).toBeNull();
    expect(JSON.stringify(storage.users.list())).not.toContain(token);
  });

  it('rejects two users with the same token', () => {
    storage.users.create({ id: 'a', tokenSha256: 'h' });
    expect(() => storage.users.create({ id: 'b', tokenSha256: 'h' })).toThrow();
  });

  it('handles access to owned, unowned, and shared accounts', () => {
    storage.users.create({ id: 'user_a', tokenSha256: 'h1' });
    storage.users.create({ id: 'user_b', tokenSha256: 'h2' });
    for (const id of ['user_a', 'user_b', 'agent']) storage.accounts.upsert({ id });
    storage.accounts.grant('user_a', 'user_a');
    storage.accounts.grant('user_b', 'user_b');
    storage.accounts.grant('agent', 'user_a');
    storage.accounts.grant('agent', 'user_b');
    storage.accounts.grant('agent', 'user_b'); // Repeated grants are harmless.

    expect(storage.accounts.hasAccess('user_a', 'user_a')).toBe(true);
    expect(storage.accounts.hasAccess('user_a', 'user_b')).toBe(false);
    expect(storage.accounts.hasAccess('user_b', 'agent')).toBe(true);
    expect(storage.accounts.accountsOf('user_b').map(a => a.id)).toEqual(['agent', 'user_b']);
    expect(storage.accounts.usersOf('agent')).toEqual(['user_a', 'user_b']);

    storage.accounts.revoke('agent', 'user_b');
    expect(storage.accounts.hasAccess('user_b', 'agent')).toBe(false);
  });

  it('upserts only the supplied account fields', () => {
    storage.accounts.upsert({ id: 'agent', username: 'agent_bot_like', status: 'active' });
    clock = 2_000;
    const updated = storage.accounts.upsert({ id: 'agent', tgUserId: '42' });
    expect(updated).toMatchObject({ username: 'agent_bot_like', tgUserId: '42', status: 'active', createdAt: 1_000, updatedAt: 2_000 });
  });

  it('removes sessions, grants, and entity caches when deleting an account', () => {
    storage.users.create({ id: 'user_a', tokenSha256: 'h1' });
    storage.accounts.upsert({ id: 'agent' });
    storage.accounts.grant('agent', 'user_a');
    storage.sessions.put('agent', seal('session', 'k'));
    storage.entities.put({ accountId: 'agent', peerKey: '-1001', kind: 'channel', accessHash: '9', username: 'chan', title: 'Chan', meta: {} });
    storage.accounts.remove('agent');
    expect(storage.sessions.get('agent')).toBeNull();
    expect(storage.entities.get('agent', '-1001')).toBeNull();
    expect(storage.accounts.accountsOf('user_a')).toEqual([]);
  });
});

describe('SqliteStorage: sessions', () => {
  it('stores sessions only in encrypted form', () => {
    storage.accounts.upsert({ id: 'agent' });
    storage.sessions.put('agent', seal('1BQA-plain-session', 'key'));
    const raw = JSON.stringify(storage.db.prepare('SELECT * FROM sessions').all());
    expect(raw).not.toContain('1BQA-plain-session');
    expect(unseal(storage.sessions.get('agent')!, 'key')).toBe('1BQA-plain-session');
    storage.sessions.put('agent', seal('second', 'key'));
    expect(unseal(storage.sessions.get('agent')!, 'key')).toBe('second');
  });
});

describe('SqliteStorage: entity cache', () => {
  beforeEach(() => {
    storage.accounts.upsert({ id: 'a1' });
    storage.accounts.upsert({ id: 'a2' });
  });

  it('stores accessHash separately for each account', () => {
    storage.entities.put({ accountId: 'a1', peerKey: '-1005', kind: 'channel', accessHash: '111', username: 'News', title: 'News', meta: {} });
    storage.entities.put({ accountId: 'a2', peerKey: '-1005', kind: 'channel', accessHash: '222', username: 'News', title: 'News', meta: {} });
    expect(storage.entities.get('a1', '-1005')?.accessHash).toBe('111');
    expect(storage.entities.get('a2', '-1005')?.accessHash).toBe('222');
    expect(storage.entities.getByUsername('a1', '@NEWS')?.peerKey).toBe('-1005');
  });

  it('does not overwrite accessHash and meta with partial objects', () => {
    storage.entities.put({ accountId: 'a1', peerKey: '77', kind: 'user', accessHash: '555', username: 'seller', title: 'Seller', meta: { bot: false } });
    storage.entities.put({ accountId: 'a1', peerKey: '77', kind: 'user', accessHash: null, username: null, title: 'Seller New', meta: {} });
    expect(storage.entities.get('a1', '77')).toMatchObject({ accessHash: '555', username: 'seller', title: 'Seller New', meta: { bot: false } });
  });

  it('clears a username from its former chat when it moves to another chat', () => {
    storage.entities.put({ accountId: 'a1', peerKey: '-1005', kind: 'channel', accessHash: '1', username: 'shop', title: 'Old shop', meta: { broadcast: true } });
    storage.entities.put({ accountId: 'a2', peerKey: '-1005', kind: 'channel', accessHash: '2', username: 'shop', title: 'Old shop', meta: { broadcast: true } });
    storage.entities.put({ accountId: 'a1', peerKey: '-1009', kind: 'channel', accessHash: '3', username: 'Shop', title: 'New shop', meta: { broadcast: true } });
    expect(storage.entities.getByUsername('a1', 'shop')?.peerKey).toBe('-1009');
    expect(storage.entities.get('a1', '-1005')?.username).toBeNull();
    // Another account's cache learns about the change independently.
    expect(storage.entities.get('a2', '-1005')?.username).toBe('shop');
  });

  it('clears missing usernames on full objects but preserves them on partial objects', () => {
    storage.entities.put({ accountId: 'a1', peerKey: '-1005', kind: 'channel', accessHash: '1', username: 'shop', title: 'Shop', meta: { broadcast: true } });
    storage.entities.put({ accountId: 'a1', peerKey: '-1005', kind: 'channel', accessHash: null, username: null, title: 'Shop', meta: {} });
    expect(storage.entities.get('a1', '-1005')?.username).toBe('shop');
    storage.entities.put({ accountId: 'a1', peerKey: '-1005', kind: 'channel', accessHash: '1', username: null, title: 'Shop', meta: { broadcast: true } });
    expect(storage.entities.get('a1', '-1005')?.username).toBeNull();
    expect(storage.entities.getByUsername('a1', 'shop')).toBeNull();
  });

  it('writes a batch with putMany', () => {
    storage.entities.putMany(
      Array.from({ length: 50 }, (_, i) => ({ accountId: 'a1', peerKey: String(i + 1), kind: 'user' as const, accessHash: String(i), username: null, title: null, meta: {} })),
    );
    expect(storage.entities.get('a1', '1')?.kind).toBe('user');
    expect(storage.entities.get('a1', '50')?.accessHash).toBe('49');
  });
});

describe('SqliteStorage: audit, jobs, kv, and transactions', () => {
  it('filters audit by user and removes old entries', () => {
    const base = { accountId: 'agent', args: { chat: '@x' }, peerKey: '-1001', resultCount: 3, durationMs: 12, errorCode: null, floodWaitSeconds: null };
    storage.audit.add({ ...base, ts: 100, userId: 'user_a', tool: 'tg_read_history' });
    storage.audit.add({ ...base, ts: 200, userId: 'user_b', tool: 'tg_resolve', errorCode: 'FLOOD_WAIT', floodWaitSeconds: 30 });
    expect(storage.audit.recent({ userId: 'user_a' }).map(e => e.tool)).toEqual(['tg_read_history']);
    expect(storage.audit.recent()[0]).toMatchObject({ tool: 'tg_resolve', errorCode: 'FLOOD_WAIT', floodWaitSeconds: 30, args: { chat: '@x' } });
    expect(storage.audit.prune(150)).toBe(1);
    expect(storage.audit.recent()).toHaveLength(1);
  });

  it('advances job states and requeues interrupted jobs after restart', () => {
    storage.jobs.create({ id: 'j1', userId: 'user_a', accountId: 'agent', kind: 'export', params: { chat: '-1001' } });
    storage.jobs.update('j1', { state: 'running', progress: { done: 100, total: 400 } });
    expect(storage.jobs.get('j1')).toMatchObject({ state: 'running', progress: { done: 100, total: 400 }, result: null });
    expect(storage.jobs.requeueRunning()).toBe(1);
    expect(storage.jobs.get('j1')?.state).toBe('queued');
    storage.jobs.update('j1', { state: 'done', result: { path: '/tmp/x.jsonl', rows: 400 } });
    expect(storage.jobs.list({ userId: 'user_a', state: 'done' })).toHaveLength(1);
    expect(storage.jobs.list({ userId: 'user_b' })).toHaveLength(0);
  });

  it('reads the job queue oldest first', () => {
    for (let i = 1; i <= 60; i++) {
      clock += 10;
      storage.jobs.create({ id: `job_${i}`, userId: 'user_a', kind: 'export', params: {} });
    }
    expect(storage.jobs.list({ state: 'queued', limit: 1, oldestFirst: true })[0]!.id).toBe('job_1');
    expect(storage.jobs.list({ state: 'queued', limit: 1 })[0]!.id).toBe('job_60');
  });

  it('allows repeated close calls', () => {
    const other = new SqliteStorage({ path: ':memory:' });
    other.close();
    expect(() => other.close()).not.toThrow();
  });

  it('stores and replaces kv values', () => {
    expect(storage.kv.get('k')).toBeNull();
    storage.kv.set('k', '1');
    storage.kv.set('k', '2');
    expect(storage.kv.get('k')).toBe('2');
  });

  it('rolls back a transaction on failure', () => {
    expect(() =>
      storage.transaction(() => {
        storage.kv.set('tx', 'value');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(storage.kv.get('tx')).toBeNull();
    storage.transaction(() => storage.transaction(() => storage.kv.set('nested', 'ok')));
    expect(storage.kv.get('nested')).toBe('ok');
  });
});
