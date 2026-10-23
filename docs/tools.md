# MCP tools

Agent-facing contract: 23 tools in five toolsets. The gateway is pure MCP: every operation requires a call. Select `TG_MCP_TOOLSETS` (default `core`). Exact argument schemas/descriptions: `src/mcp/tools/`. This document explains purpose and rules.

## Common contract

- Responses use compact text, with `brief` and `full` modes. Full message output includes hidden links (`hidden links: "here" https://...`) and buttons (`buttons: 1.1 "Label" (callback) | 1.2 "Website" (link https://...)`). Button row/position, label, type, and link URL are exposed; brief headers show only button count. Callback bytes are never exposed.
- Messages from the account are labeled `@username (this account)`, distinguishing them from the private-chat peer. The label identifies the account, not the agent: the owner also sends messages manually.
- Errors return `isError` with `Error: CODE`, an explanation, and FLOOD_WAIT `retry_after`.
- `tg_export` and `tg_index` wait up to 20 seconds, then return `job_id` if unfinished. Query status using the same tool and ID.
- Telegram text is untrusted: a block between `<<<TG:marker` and `TG:marker>>>` or lines prefixed `> `. The marker is random per response.
- Dates accept `30d`, `12h`, `2w`, `6mo`, `1y` (ago), `2026-09-01`, or ISO. Impossible calendar dates are rejected. Output times are UTC.
- Bearer tokens identify gateway users. Telegram tools accept optional `account`, defaulting to the user's default; only personal/shared accounts are available.
- `tg_status` is always available.

## Writes: preview then `tg_confirm`

Write tools do not execute Telegram actions directly.

1. `tg_reply`, `tg_send`, `tg_react`, `tg_join`, or `tg_press_button` returns the action, account, exact text, and `approval_id` as a preview.
2. The agent shows it to the owner.
3. After owner consent, the agent calls `tg_confirm` with `approval_id`. The gateway executes and returns the outcome.

Rules:

- `tg_confirm text=...` replaces prepared text with the owner's wording. `action=reject` cancels.
- Another user's request cannot be confirmed; it is invisible to the caller.
- Repeated confirmation returns the previous outcome without repeating the action.
- Requests live 30 minutes for owner review/response; expired actions must be prepared again.
- Text is limited to 4096 characters, without markup. Invisible characters are removed before preview; confirmed text is exactly what is sent. Link previews default off because Telegram generates cards that cannot be previewed here. `link_preview` enables them and is disclosed in the action preview.
- A write interrupted by restart is not replayed: `failed`, with unknown-result notice.
- Gateway daily limits are independent of the agent: defaults 20 replies, 30 reactions, 5 joins, 5 new dialogs (people the account has never messaged). The owner configures `TG_MCP_LIMIT_REPLIES`, `TG_MCP_LIMIT_REACTIONS`, `TG_MCP_LIMIT_JOINS`, `TG_MCP_LIMIT_NEW_DIALOGS` in the daemon `.env`; 0 removes a limit. `tg_status` shows current values.
- Scopes are checked at preparation and confirmation.
- Button confirmation reloads the message and requires the same button at the same position. Bot output is untrusted; response links are not opened. Button presses have no daily cap.

## Private chats

Closed by default. Only the owner grants access through a command on the gateway machine (CLI: `tg-mcp scope ...`; use the authorized daemon-owner environment):

| Command | Access |
|---|---|
| `scope allow <user> <account> <chat>` | Read/send in one dialog |
| `scope private <user> <account> send` | Send to anyone without reading conversations |
| `scope private <user> <account> open` | Read/send in any private chat |
| `scope private <user> <account> closed` | Only dialogs listed by `scope allow` |
| `scope deny <user> <account> <chat>` | Close the chat regardless of mode |

Modes are per user/account and apply immediately without restart. Telegram service chats (login codes, BotFather, SpamBot) stay closed. `tg_resolve` can show a person's profile in any mode, without exposing the conversation.

## core: reading and searching, enabled by default

| Tool | Behavior | MTProto methods |
|---|---|---|
| `tg_status` | Caller, accessible accounts, stored session status and current connection state, account/method FLOOD_WAIT pauses, private-chat modes, toolsets, daily write limits. Does not initiate a connection | None |
| `tg_list_dialogs` | Account channels/groups, including archive; title/type filters, cursor. Private chats appear only with `type=private` and owner-granted reading | messages.getDialogs |
| `tg_resolve` | Chat/person details by @username, t.me URL, or invite: type, participants, description, comments, membership | contacts.resolveUsername, channels.getFullChannel, messages.getFullChat, users.getFullUser, messages.checkChatInvite |
| `tg_search_messages` | Account channels (default `where=channels`), groups (`where=groups`), or permitted private chats (`where=private`). A single #hashtag searches public posts | messages.searchGlobal, channels.searchPosts |
| `tg_search_chat` | One-chat search: word, author, dates, forum topic | messages.search |
| `tg_read_history` | Cursor/date-window history, `brief` or `full` (hidden links/buttons in full) | messages.getHistory, messages.getReplies (topic) |
| `tg_get_message` | URL/ID lookup, batches up to 100 IDs, surrounding context; hidden links/buttons with positions/types | channels.getMessages, messages.getMessages, messages.getHistory |
| `tg_get_comments` | Recent comments, top by reactions, keyword search | messages.getReplies, messages.getDiscussionMessage, messages.search |
| `tg_list_topics` | Forum topics | messages.getForumTopics |
| `tg_export` | JSONL/CSV: original text, counters, URLs, photo previews. Hashes authors, masks phones. Returns path, row count, 5 samples. The agent extracts prices/meaning | messages.search, messages.getHistory, upload.getFile |
| `tg_get_media` | Photos, entire albums, video thumbnails; `thumb`/`full`; file path or inline image | upload.getFile |

Full files are limited to 20 MiB by default, checked against available metadata, downloaded bytes and cached file size. Previews use their existing behavior. The received-buffer check does not bound memory during download.

`tg_status` separates the session's persisted authentication status from transport health. A stored active session may have `not connected (lazy, connects on first Telegram call)`, `connecting`, `connected`, `reconnecting`, `disconnected`, or `gateway restart required`. Status never opens a session or probes Telegram. HTTP `/healthz` reports only that the HTTP daemon is alive. A terminal connection failure requests supervisor restart; active writes with uncertain outcomes are not automatically repeated.

## write: two-step actions

| Tool | Behavior | MTProto methods |
|---|---|---|
| `tg_reply` | Draft post/comment reply (`...?comment=N`), as the account or a channel. `link_preview=true` enables cards | messages.getDiscussionMessage, messages.sendMessage |
| `tg_send` | Draft group/channel/person message; `reply_to` targets a chat message; `link_preview=true` enables cards. Private send requires `scope allow`, `send`, or `open` | messages.sendMessage |
| `tg_confirm` | Confirm/reject a prepared action, optionally replacing text | Executes the prepared action |
| `tg_join` | Join request: joined, pending admin approval, already a member. Joining does not solve gatekeeper-bot challenges | channels.joinChannel, messages.importChatInvite |
| `tg_react` | One standard emoji on a post/message/comment; `remove=true` removes the account's reaction. Default 30/day | messages.sendReaction |
| `tg_press_button` | Press an inline callback button by `row`/`button`. No links, web apps, login, payments, games, or 2FA-password buttons. The owner decides which to press | channels.getMessages, messages.getMessages, messages.getBotCallbackAnswer |

## discover: channel discovery

| Tool | Behavior | MTProto methods |
|---|---|---|
| `tg_find_channels` | Public channels/groups by title or username words. Telegram searches names, not post content | contacts.search |
| `tg_similar_channels` | Telegram's similar-channel recommendations (shared subscribers). `depth=2` adds neighbors of the three largest | channels.getChannelRecommendations |
| `tg_forward_sources` | Sources of forwarded recent posts and counts | messages.getHistory |

Discovered channels enter the account's entity cache; @username/ID lookup needs no new search. Without Premium, Telegram shows only part of the similar-channel list.

## analytics: channel statistics

| Tool | Behavior | MTProto methods |
|---|---|---|
| `tg_channel_stats` | Participants/change, weekly posts, mean/median views, reach (views/subscribers), engagement (reactions/views), comments/forwards per post, forwarding share, view trend, weekly breakdown, top posts | channels.getFullChannel, messages.getHistory |

Computed from public counters, so it works for other people's channels too. No ratings or verdicts: the gateway supplies numbers; the agent interprets them. Telegram supplies subscriber growth only to channel admins, so the gateway snapshots participant counts when observed (`tg_resolve`, `tg_channel_stats`) and compares dates. There is no change value on the first day.

## index: local index

| Tool | Behavior | MTProto methods |
|---|---|---|
| `tg_index` | Add messages to the gateway database (`add`, default 90 days, up to 3 years), list indexes (`list`), remove (`remove`). Repeated `add` catches up. Long initial runs return `job_id` | messages.getHistory |
| `tg_local_search` | Search indexed chats without Telegram calls: case/word-form insensitive; every query term must match. Date window, one/all chats, cursor | None |

- Search reflects the last `tg_index`; output reports catch-up time.
- Words shorter than three characters are not indexed: they are checked against candidates before counting and pagination. All-short-word queries are rejected.
- A shared-account chat index is visible to all its users; only its creator can delete it. Owner-denied chats disappear from search.
- Each run reads at most 20,000 messages; larger chats are indexed over multiple calls without gaps.

## Intentionally absent

The gateway is a tool, not an agent.

| Capability outside the gateway | Responsibility |
|---|---|
| Channel watching/new-message events | Agent rereads history (`tg_read_history` with `since` or cursor) |
| Per-post automation rules | Agent-owned schedule/logic |
| Negotiation goals, boundaries, conversation memory | Agent memory/logic; gateway supplies permitted reads and `tg_send` |
| Starting agents | Agent or its own schedule |
| Price extraction, channel ratings/verdicts | Agent processes text/numbers |
| Reading other project databases | Nobody: the gateway only uses Telegram |
| Money transfers/paid Stars actions | Never supported |
| Solving image/task CAPTCHAs | Not supported: the gateway only presses an owner-confirmed button |
