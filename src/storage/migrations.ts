/**
 * Schema migrations. The array index plus one is the version (PRAGMA user_version).
 * Published migration statements stay unchanged; add new migrations at the end.
 */
export const MIGRATIONS: string[] = [
  // 1: users, accounts, sessions, entity cache, audit, tasks
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    token_sha256 TEXT NOT NULL UNIQUE,
    telegram_id TEXT,
    default_account TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    tg_user_id TEXT,
    username TEXT,
    display_name TEXT,
    status TEXT NOT NULL DEFAULT 'needs_login',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE account_access (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (account_id, user_id)
  );

  CREATE TABLE sessions (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    iv TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE entities (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    peer_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    access_hash TEXT,
    username TEXT,
    title TEXT,
    meta TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, peer_key)
  );
  CREATE INDEX entities_username ON entities(account_id, username);

  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    user_id TEXT,
    account_id TEXT,
    tool TEXT NOT NULL,
    args TEXT NOT NULL DEFAULT '{}',
    peer_key TEXT,
    result_count INTEGER,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    flood_wait_seconds INTEGER
  );
  CREATE INDEX audit_ts ON audit(ts);

  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    account_id TEXT,
    kind TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT 'queued',
    progress TEXT NOT NULL DEFAULT '{}',
    result TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX jobs_state ON jobs(state);

  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,

  // 2: access scopes beyond the default rules
  `
  CREATE TABLE scope_rules (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    -- chat key or lowercase username without @
    target TEXT NOT NULL,
    effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
    -- rule source: owner (owner CLI) or task:<id> (a task opened the conversation)
    source TEXT NOT NULL DEFAULT 'owner',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, account_id, target, source)
  );
  `,

  // 3: automation: watchers, inbox, approvals, rules, write journal, agent launch queue
  `
  CREATE TABLE watches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    chat_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, account_id, chat_key)
  );

  -- One poll per account/chat pair, regardless of how many users watch it.
  CREATE TABLE watch_state (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    chat_key TEXT NOT NULL,
    last_seen_id INTEGER NOT NULL DEFAULT 0,
    baseline_done INTEGER NOT NULL DEFAULT 0,
    next_poll_at INTEGER NOT NULL DEFAULT 0,
    interval_ms INTEGER NOT NULL DEFAULT 60000,
    last_poll_at INTEGER,
    last_error TEXT,
    PRIMARY KEY (account_id, chat_key)
  );

  CREATE TABLE inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    account_id TEXT,
    chat_key TEXT,
    message_id INTEGER,
    payload TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX inbox_user ON inbox(user_id, id);

  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id TEXT,
    kind TEXT NOT NULL,
    -- request source: tool, rule:<id>, or task:<id>
    source TEXT NOT NULL,
    payload TEXT NOT NULL,
    preview TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    bot_chat_id TEXT,
    bot_message_id INTEGER,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE INDEX approvals_state ON approvals(state);

  CREATE TABLE rules (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    chat_key TEXT NOT NULL,
    config TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE rule_fires (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
    chat_key TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    UNIQUE (rule_id, chat_key, message_id)
  );

  -- Telegram write journal: daily caps and one reply per post per account (decision 18).
  CREATE TABLE writes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    chat_key TEXT NOT NULL,
    post_id INTEGER,
    sent_message_id INTEGER,
    source TEXT NOT NULL
  );
  CREATE UNIQUE INDEX writes_one_reply ON writes(account_id, chat_key, post_id) WHERE kind = 'reply' AND post_id IS NOT NULL;
  CREATE INDEX writes_account_ts ON writes(account_id, ts);

  CREATE TABLE runner_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    run_after INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    claimed_at INTEGER,
    finished_at INTEGER,
    exit_code INTEGER,
    output TEXT
  );
  CREATE INDEX runner_jobs_user ON runner_jobs(user_id, state);

  -- Restricted tokens issued to a launched agent for a single task.
  CREATE TABLE scoped_tokens (
    token_sha256 TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `,

  // 4: tasks: the gateway stores goals, constraints, conversations, and state (decisions 10 and 13)
  `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- gateway account handling the conversation
    account_id TEXT,
    via TEXT NOT NULL,
    peer_key TEXT NOT NULL,
    peer_label TEXT NOT NULL,
    goal TEXT NOT NULL,
    limits TEXT NOT NULL DEFAULT '',
    ask_me_before TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL,
    deadline_at INTEGER NOT NULL,
    max_messages INTEGER NOT NULL,
    reminder_after_ms INTEGER,
    reminder_sent INTEGER NOT NULL DEFAULT 0,
    messages_sent INTEGER NOT NULL DEFAULT 0,
    last_seen_id INTEGER NOT NULL DEFAULT 0,
    next_poll_at INTEGER NOT NULL DEFAULT 0,
    last_activity_at INTEGER NOT NULL DEFAULT 0,
    question TEXT,
    question_message_id INTEGER,
    summary TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX tasks_state ON tasks(state);

  CREATE TABLE task_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    -- peer: contact; agent: sent by gateway; owner: owner instruction; system: internal record
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    tg_message_id INTEGER
  );
  CREATE INDEX task_messages_task ON task_messages(task_id, id);
  `,

  // 5: daily participant counts and a local message index with full-text search
  `
  CREATE TABLE chat_snapshots (
    chat_key TEXT NOT NULL,
    -- UTC date, YYYY-MM-DD: one snapshot per chat per day
    day TEXT NOT NULL,
    ts INTEGER NOT NULL,
    members INTEGER NOT NULL,
    PRIMARY KEY (chat_key, day)
  );

  CREATE TABLE indexed_chats (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    chat_key TEXT NOT NULL,
    -- index is complete for messages newer than this timestamp (Unix seconds)
    since_ts INTEGER NOT NULL,
    newest_id INTEGER NOT NULL DEFAULT 0,
    oldest_id INTEGER NOT NULL DEFAULT 0,
    synced_at INTEGER,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, chat_key)
  );

  CREATE TABLE indexed_messages (
    rowid INTEGER PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    chat_key TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    date INTEGER NOT NULL,
    -- normalized message (MessageDto), as returned by read tools
    dto TEXT NOT NULL,
    UNIQUE (account_id, chat_key, message_id)
  );
  CREATE INDEX indexed_messages_date ON indexed_messages(account_id, chat_key, date);

  -- Trigrams: 'bicycle' also matches 'bicycles'; matching is case-insensitive.
  CREATE VIRTUAL TABLE indexed_fts USING fts5(text, tokenize='trigram');

  -- Search text must not outlive its message, including on account deletion.
  CREATE TRIGGER indexed_messages_delete AFTER DELETE ON indexed_messages BEGIN
    DELETE FROM indexed_fts WHERE rowid = old.rowid;
  END;
  `,

  // 6: pure MCP gateway (decision 25): remove watchers, inbox, rules, agent launches, and tasks.
  // Keep confirmation requests (approvals) and the write journal (writes).
  `
  DROP TABLE IF EXISTS task_messages;
  DROP TABLE IF EXISTS tasks;
  DROP TABLE IF EXISTS scoped_tokens;
  DROP TABLE IF EXISTS runner_jobs;
  DROP TABLE IF EXISTS rule_fires;
  DROP TABLE IF EXISTS rules;
  DROP TABLE IF EXISTS inbox;
  DROP TABLE IF EXISTS watch_state;
  DROP TABLE IF EXISTS watches;
  `,

  // 7: remaining bot and task fields. User Telegram IDs and
  // bot messages are unnecessary (decision 23); request, journal, and scope sources
  // are always the same, while task-created scopes are removed (decision 25).
  `
  ALTER TABLE users DROP COLUMN telegram_id;
  ALTER TABLE approvals DROP COLUMN bot_chat_id;
  ALTER TABLE approvals DROP COLUMN bot_message_id;
  ALTER TABLE approvals DROP COLUMN source;
  ALTER TABLE writes DROP COLUMN source;

  CREATE TABLE scope_rules_v7 (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    -- chat key, lowercase username without @, or internal private-chat mode target
    target TEXT NOT NULL,
    effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, account_id, target)
  );
  INSERT INTO scope_rules_v7 (user_id, account_id, target, effect, created_at)
    SELECT user_id, account_id, target, effect, created_at FROM scope_rules WHERE source = 'owner';
  DROP TABLE scope_rules;
  ALTER TABLE scope_rules_v7 RENAME TO scope_rules;
  `,

  // 8: remove the one-reply-per-post-per-account cap (decision 29); the owner decides reply frequency.
  `
  DROP INDEX IF EXISTS writes_one_reply;
  `,
];
