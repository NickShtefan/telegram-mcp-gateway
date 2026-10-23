# Architecture

The gateway's current implementation. Agent-facing interface: [tools.md](tools.md).

## Purpose

One process (`tg-mcp serve`) owns the MTProto sessions of connected Telegram accounts and handles MCP tool calls. It is a tool for an agent, not an agent: no model, schedules, or chat monitoring inside. Every Telegram operation responds to a tool call.

## Request flow

1. The agent (Claude Code, Hermes, Codex, OpenCode) sends JSON-RPC to `http://127.0.0.1:7777/mcp` with a bearer token. Stdio-only clients launch `tg-mcp stdio`, which proxies the same messages to the daemon.
2. The daemon resolves the gateway user from the token and creates a request-scoped MCP server with that user's tools (stateless: one request, one server).
3. The tool selects an account (`account` or the default), resolves the chat, and asks scope policy whether reading or writing is allowed.
4. The service constructs an MTProto request and submits it to `Tg`, the only Telegram entry point.
5. `Tg` queues the call in the account's limiter lane; the pooled client executes it. Response chats and users enter that account's entity cache.
6. The response becomes compact text; untrusted text is labeled; the call is audited.

Writes follow the same path twice: preparation stores the request and returns a preview; `tg_confirm` executes it.

## Layers and code

| Layer | Directory | Responsibility |
|---|---|---|
| Transport | `src/transport` | Daemon HTTP server and stdio proxy |
| MCP | `src/mcp` | Tool registry, schemas, response formatter, cursors, agent errors |
| Policy | `src/policy` | Users/account access, chat scopes, untrusted-text labeling, audit |
| Write gate | `src/writegate` | Write requests, confirmation, execution journal |
| Services | `src/services` | Reads, search, comments, topics, dialogs, discovery, statistics, index, export, media, actions, jobs |
| Core | `src/core` | Client pool, limiter, watchdog, login, session encryption, entity cache, configuration, daemon lock |
| Storage | `src/storage` | Storage port and SQLite implementation with migrations |
| CLI | `src/cli` | `serve`, `stdio`, `login`, `doctor`, users, accounts, scopes |
| Installation artifacts | `src/install`, `scripts/install` | Pinned manifest/runtime verification and bounded application archive; no service activation |
| Setup | `src/setup` | Read-only preflight, owner setup worker and launcher, client adapters and handoff |

`core` and `services` do not import `mcp` or `transport`. Dependencies are explicitly injected (`src/runtime.ts`, `src/services/index.ts`), allowing a Telegram double and in-memory database in tests.

[Setup preflight](setup.md) is independent of MCP and does not execute a model, watch Telegram, start services or perform login. `setup preflight` bypasses configuration/storage initialization. Mutating setup stages run only through the owner terminal entry ([owner-setup.md](owner-setup.md)); no administrative MCP/HTTP API is exposed.

## Transport

- **HTTP** (`transport/http.ts`): stateless Streamable HTTP on `127.0.0.1`. Checks `Host` against DNS rebinding and rejects browser `Origin`; body limit 1 MB: an oversized body is read to its end (up to 8 MB extra within 10 s) and answered with 413, otherwise the connection is dropped; only `POST /mcp`. `/healthz` needs no token and reveals no account information. Non-localhost binding requires `TG_MCP_ALLOW_REMOTE=1`.
- **stdio** (`transport/stdio.ts`): reads stdin JSON-RPC, forwards it to the daemon with `TG_MCP_TOKEN`, writes responses to stdout. Opens no sessions itself.
- **Lock** (`core/lock.ts`): POSIX session ownership uses a permanent-inode kernel lease (`core/fileLease.ts`). Stale `daemon.sock` cleanup occurs only while that lease is held; the socket remains a liveness endpoint and excludes still-running older daemons. A killed owner releases the kernel lease without unlinking its file. `flock` has no query operation, so a read-only probe (`isLockHeld`, used by `doctor` and `login`) briefly takes a free lease; acquisition therefore retries a busy lease for about half a second before reporting another owner. Windows uses canonical-directory first-instance named pipes; native execution/ACL qualification remains open. Duplicate session use causes `AUTH_KEY_DUPLICATED`.

## MCP layer

- **Tools** (`mcp/tools/`): 23 tools in `core`, `discover`, `analytics`, `index`, `write`. Select toolsets with `TG_MCP_TOOLSETS`; `tg_status` is always available. A test verifies flat schemas (strings, numbers, booleans, enums, arrays).
- **Framework** (`mcp/tool.ts`): shared audit/error wrapper returning `isError`, code, explanation, and `retry_after`.
- **Formatter** (`mcp/format.ts`): compact text rather than JSON, with one message header and body. `brief` and `full` modes.
- **Cursors** (`mcp/cursor.ts`): Telegram position encoded as opaque `next_cursor`.
- **Server instructions** (`mcp/server.ts`): short client-provided agent context: untrusted text is data, and writes require owner consent.

## Policies

- **Users/access** (`policy/access.ts`): bearer token identifies the user; only its hash is stored. Users see personal/shared accounts.
- **Scopes** (`policy/scopes.ts`): channels/groups are open; private chats require owner permission individually (`scope allow`) or per user/account (`scope private`: `send` for send-only, `open` for read/write). `deny` overrides other rules. Telegram service chats (login codes, BotFather, SpamBot) are always closed.
- **Untrusted text** (`policy/envelope.ts`): Telegram text is enclosed by a random marker, new for each response. Invisible characters and newlines are removed from titles/names.
- **Audit** (`policy/audit.ts`): time, user, account, tool, arguments without secrets, chat, result count, duration, error code. Retained for 90 days.

## Two-step writes

Code: `src/writegate/` and `services/write.ts`.

1. `tg_reply`, `tg_send`, `tg_react`, `tg_join`, or `tg_press_button` checks scopes/limits, stores the request, and returns a preview with `approval_id`.
2. The agent shows the preview to the owner.
3. `tg_confirm` rechecks scopes/limits, sends the action to Telegram, and journals its outcome.

Requests expire after 30 minutes. Repeated confirmation never executes twice; another user's request cannot be confirmed; a write interrupted by restart is not replayed (outcome unknown). The journal supplies daily limits for replies, new dialogs, joins, and reactions (owner-configurable).

## Services

| File | Responsibility |
|---|---|
| `links.ts` | Chat/message references: `@username`, ID, `t.me`, `t.me/c/`, invites, `tg://` |
| `resolve.ts` | Entity-cache/`contacts.ResolveUsername` resolution; chat details |
| `history.ts` | Cursor/date-window history, message IDs, surrounding context, complete albums |
| `messages.ts` | Canonical message: author, counters, media, forwarding, forum topic, hidden links, inline buttons. Private-chat messages lack a sender: `out` identifies the account; otherwise the peer authored it |
| `search.ts` | Account channels/groups/private chats, public-post hashtags, one-chat search |
| `comments.ts` | Discussion-group post comments: pages, top reactions, search |
| `topics.ts` | Forum topics |
| `dialogs.ts` | Account dialogs including archived chats |
| `discover.ts` | Channel name search, similar channels, forwarding sources |
| `stats.ts` | Public channel counters and daily participant-count snapshots |
| `localIndex.ts` | SQLite trigram FTS5 search; short terms filter before counts and pagination |
| `export.ts` | JSONL/CSV export: authors hashed, phone numbers masked (`phones.ts`) |
| `media.ts` | Photos, albums, video thumbnails in the shared directory; metadata and actual full-file size checks, cache checks and directory quotas |
| `write.ts` | Replies, sends, reactions, joins and limits; inline-button press with message revalidation |
| `buttons.ts` | Keyboard button type/label/URL, row/position lookup, verification fingerprint |
| `jobs.ts` | Long-running export/index jobs, database state, restart continuation |

## Core

- **Client pool** (`clientPool.ts`): one teleproto client per account, lazy connection, coalesced concurrent attempts, 30-second connect limit. Local connection state distinguishes lazy, connecting, connected, reconnecting and terminal disconnection. A filtered connection-state event forwards a terminal sender failure to the process watchdog, including background retry exhaustion with no pending tool call. Normal reconnects, authorization-key recovery and orderly shutdown do not request restart. A terminal client is never replaced within the same process. Library logging goes to stderr.
- **Limiter** (`limiter.ts`): one sequential lane per account, 500 ms spacing, 60 calls/minute. Per-call deadlines: 20 seconds, 60 for downloads. FLOOD_WAIT up to five minutes pauses the account and is waited within the wait budget (15 seconds for agent calls); above five minutes, only the affected method is closed and the agent immediately receives `retry_after`. Chat slow mode is not an account pause. Agent calls take priority over background jobs.
- **Watchdog** (`recovery.ts`): a timed-out MTProto call cannot be safely canceled. A permanently disconnected sender also requires a new process. Waiting calls fail, the process exits with code 1, and a configured supervisor restarts it. Retry reads only after restart; do not replay writes with an unknown outcome. An in-flight write whose transport dies is reported with an unknown outcome. Connection inspection and tg_status make no Telegram requests.
- **Login** (`auth.ts`): phone, code, and 2FA password in `tg-mcp login`. The agent cannot see the code. Unregistered numbers are not signed up. Whitespace is dropped from the code; passwords are used verbatim. The caller persists the authorized session before the login client closes, because a failed or hung close terminates the process (a possibly live client shares the new auth key).
- **Sessions** (`crypto.ts`): session strings are AES-256-GCM encrypted with `session.key` (or `TG_MCP_SESSION_KEY`) and stored in SQLite.
- **Entities** (`entities.ts`, `entities` table): accessHash is session-bound, so each account has its own cache. Reduces tightly limited `contacts.ResolveUsername` calls.
- **Errors** (`errors.ts`): Telegram errors become `GatewayError` codes and actionable explanations.
- **Shared files** (`safeFs.ts`, `windowsAcl.ts`): agent files are written and read without following symlinks, only in directories writable exclusively by the daemon. POSIX checks the owner and mode bits of every directory from the files root down. Windows has no such bits: every directory in the chain is lstat-checked for symbolic links and junctions on each use, and its ACL is attested once per process and file identity by one fixed PowerShell process per batch of new directories (owner and every write-capable allow entry limited to Administrators, SYSTEM and the daemon's own identity; no reparse point). New Windows files must be the empty single-link file the path names after an exclusive create, and reads require a single-link regular file whose open handle matches the path, because Windows has no `O_NOFOLLOW`. A refused directory is not remembered across calls, so a corrected ACL takes effect on the next call; within one media call the chat directory is checked once before the first Telegram download, a refusal skips every later fetch of that call without contacting Telegram, and an export stops downloading photo previews after the first refusal and reports it.

## Storage

One SQLite file (`gateway.sqlite`), built-in `node:sqlite`, schema versioned in `storage/migrations.ts`.

| Tables | Data |
|---|---|
| `users`, `accounts`, `account_access` | Gateway users/token hashes, Telegram accounts, account grants |
| `sessions` | Encrypted account sessions |
| `entities` | Per-account chats/users cache |
| `scope_rules` | Chat access rules/private-chat mode |
| `approvals` | Write requests/outcomes; resolved requests retained 7 days |
| `writes` | Executed-write journal for limits |
| `jobs` | Export/index jobs |
| `chat_snapshots` | Daily participant counts |
| `indexed_chats`, `indexed_messages`, `indexed_fts` | Chat indexing state, messages, full-text search |
| `audit` | Tool-call journal |
| `kv` | Small state (export author-hash salt) |

Agent files live separately in the shared directory: `exports/<user>/` and `media/<account>/<chat>/`.

## Autonomous daemon housekeeping

Without a tool call, the daemon only maintains existing account connections; it does not query Telegram. Once a minute it expires write requests; every six hours it removes old audit records. Agents start export/index jobs; interrupted jobs resume after restart.

## Deployment boundary

Keep daemon credentials, database and session key inaccessible to agent shells. Managed installation implements a separate service identity with protected code/runtime and owner setup. Fresh OS/service/client qualification and broader owner management remain pending. Running everything under the same user cannot enforce this boundary. HTTP tokens enforce logical account access, not OS separation. Shared exports/media must be readable by authorized clients without exposing account state.

The current session lock combines a POSIX kernel lease with a compatibility socket. The [platform provisioning components](install-platforms.md) require actual OS/ACL/service qualification on the full target-platform matrix.
