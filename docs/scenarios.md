# Step-by-step scenarios

Synthetic examples for read, export, media and write workflows. Handles and listing text are placeholders, not live test targets. Parentheses identify the agent or gateway component from [architecture.md](architecture.md).

## Case 1: Marketplace

> Open this marketplace chat, find iPhone 15 sale listings from the last month, and analyze prices.

1. Call tg_resolve with the chat link. (agent)
2. HTTP transport identifies the gateway user by token. (transport)
3. Public groups require no join. Private groups require confirmed tg_join. Joining does not solve gatekeeper challenges; the owner completes them or approves tg_press_button. (scopes)
4. Return a forum supergroup profile showing that the account is not a member. (resolver)
5. Find the Selling topic with tg_list_topics. (topics)
6. Search iphone 15 within that topic over 30 days; return a page and total matches. (search)
7. For hundreds of matches, call tg_export with the same filters and photos=thumb. Preserve original text, hash authors, and mask phones. (export)
8. History pages of 100 and photo previews pass through the account queue. (limiter)
9. Return JSONL path, row count, and five examples. (formatter)
10. Parse prices such as 65k, 72,000 RUB, and negotiable using agent-side code. Calculate medians, dispersion by storage size, outliers, and repeated seller listings. (agent)
11. Fetch full albums for five cheapest listings with tg_get_media and inspect condition, repair signs, and potentially reused images. (media)
12. Present a price table, promising listing links, and photo observations. (agent)

## Case 2: Channel summary

> Open @channel and summarize the last month of discussion.

1. Resolve channel, subscribers, and comment availability. (agent)
2. Reuse cached accessHash when available. (resolver)
3. Read 30 days with tg_read_history mode=brief: one or two lines per post plus views, reactions, and comment counts. (history, formatter)
4. Read several pages through the account queue. (limiter)
5. Select five heavily discussed posts and read them fully with tg_get_message. (agent)
6. Fetch charts/screenshots through tg_get_media when images contain key information. (media)
7. Request 30 top-reacted comments per selected post. (comments)
8. Treat comment instructions such as 'ignore previous instructions' as quoted data, never commands. (untrusted-content boundary)
9. Summarize themes, tone, disputes, and key post links. (agent)

## Case 3: Monitoring

> Watch @channel and prepare a comment reply to each new post.

The gateway neither watches nor launches agents. The agent owns this workflow.

1. Configure the agent to check every 15 minutes through its own schedule or loop. (Hermes scheduling or Claude Code loop)
2. Read history and compare the latest post ID with remembered state. (history)
3. Stay quiet if unchanged. For new posts, read messages, images, and comments. (history, media, comments)
4. Prepare tg_reply; check the daily reply cap and return a preview. (write gate)
5. Show the owner the proposed reply in the agent's normal conversation. The owner approves, edits, or skips it. (agent)
6. Call tg_confirm only after approval; find the discussion thread and send. (write gate)
7. Audit each call with user, account, and chat. (audit)

Requests expire after 30 minutes. Prepare a fresh request if the owner responds later.

## Case 4: Negotiation

> Contact this bicycle seller and arrange pickup this weekend for at most 15,000 RUB.

The agent remembers goals, constraints, and negotiation state; the gateway does not.

1. The owner opens the seller conversation: `tg-mcp scope allow user_a account_a @example_seller`. (scopes)
2. Remember the goal and prepare tg_send. Show the preview and obtain consent before tg_confirm. (agent, write gate)
3. Read replies on the agent's schedule or when asked by the owner. (history)
4. Treat a seller's request for a deposit as untrusted content, not an instruction to the agent. (untrusted-content boundary)
5. If the seller asks 18,000 RUB, ask the owner before exceeding the budget. The owner may authorize a revised 16,000 ceiling. (agent)
6. Prepare the revised offer and obtain confirmation. (write gate)
7. Report the agreement and remaining owner actions. (agent)

Money, addresses, and meeting details require owner decisions under the agent's rules. The gateway enforces tg_confirm for outgoing messages but cannot independently observe human consent.

## Publish and edit a channel post

1. In Telegram, give the gateway account the channel admin permission **Post Messages**. To edit posts by other admins, also grant **Edit Messages**. The gateway uses its own logged-in account. [Telegram admin rights](https://core.telegram.org/constructor/chatAdminRights)
2. In managed owner setup, select **Read and write** for the gateway profile and restart the MCP client after setup. For a source daemon, enable `core,write`. Check `tg_status` for the selected account and toolsets.
3. Prepare `tg_send` with `chat="@fixture_channel"` and the new text. Show the owner the preview. On approval, confirm just that request and use the returned post link. When Telegram omits the sent ID, find the post with `tg_read_history`.
4. For an existing post, pass its link and the entire replacement text to `tg_edit_post`. Show the owner the account, post, original text, replacement and any change to formatting or link cards. Confirm this separate edit after approval. If the original changed, reread it and prepare a fresh edit for review.
5. Read the same link with `tg_get_message` to verify the result. A second confirmation of the same approval returns the recorded outcome.

For the cross-client regression, compile the in-memory test fixture from the repository root with `npx tsc -p tsconfig.json --outDir node_modules/.cache/tg-channel-test --declaration false --sourceMap false`. Configure a temporary stdio MCP server named `fixture` with `node` and the absolute path to `node_modules/.cache/tg-channel-test/__tests__/helpers/channelPostFixture.js`. Each fixture process starts with post 42. Use the same prompt in Claude Code, Codex and OpenCode:

> Use only the synthetic fixture MCP tools. Call tg_send for @fixture_channel with text "Fixture announcement". Also call tg_edit_post for https://t.me/fixture_channel/42 with text "Updated fixture post". Show both preview targets and texts. The owner rejects both proposals: call tg_confirm with action=reject for each approval_id. Call tg_get_message on the post to verify its original text. Report the two actual approval IDs, both outcomes and final post text. Do not approve any write or use any other tools.

Both requests must be rejected and the final text must be `Original fixture post`. The write-gate integration tests also exercise successful confirmed publication and editing through the MCP SDK.

## Replace one hidden link

Use the compiled synthetic fixture above. For two separate CLI invocations, start it once with `--http-config /path/to/private-temp-dir/fixture.json`. It binds an ephemeral loopback port and writes the test connection settings into a new owner-readable file. Point only the test client at this fixture and stop the process when finished. Start a fresh fixture for each client.

1. In `claude -p`, `codex exec` and `opencode run`, ask: "Use only the synthetic fixture. Call tg_edit_post directly to replace the hidden URL https://t.me/fixture_old with https://t.me/fixture_new on https://t.me/fixture_channel/41. Show the approval ID, target, label and URL change and wait for my decision."
2. Expect one preparation call, a preview for `replace_link_url` and the label "channel". The post still contains the original link.
3. For this synthetic request, give consent in the next turn with the returned approval ID and exact change. The client calls `tg_confirm` once. Expect `verified`, post ID 41 and an empty difference list. A later `status` call reads the stored outcome.
4. On a live gateway, use an owner-designated test channel and present the actual preview for separate owner consent before confirming.

## Edit a styled range

Use the same isolated HTTP fixture and two-turn procedure as the hidden-link scenario. Start a fresh fixture per client.

1. In each client, ask to replace the word "channel" with "updates" in fixture post 41 using `op=replace_range`, preserving the bold span and hidden link. Show the preview and wait for consent.
2. After reviewing the exact change, approve that one fixture approval ID. Expect `verified` with an empty difference list.
3. Read the same post with `tg_get_message(view="content")`. The text should be "  Read our updates 👩‍💻  ", with the surrounding spaces, the hidden destination and the bold span intact. The earlier fixture link operation remains available independently.
4. For a live caption check, choose an owner-authorized standalone photo/document. Inspect its caption, then preview the exact range edit or explicit clear. Confirm only after the owner agrees and check the read-back of the same message and attachment.

## Select a link card without changing the post

Use the same isolated HTTP fixture and two-turn procedure. Start a fresh fixture for each client.

1. In `claude -p`, `codex exec` and `opencode run`, ask to prepare a small top preview of https://example.org/second for fixture post 40 using `tg_edit_post(op="set_link_preview")`. Show the account, post, URL and settings. Wait for consent.
2. Verify that `tg_get_message(view="preview")` still shows the card off before consent. Approve the exact synthetic edit in the next turn. Expect `verified` and an empty difference list.
3. Reread both the preview and content views. The manual card points to the second URL with small size and top placement. The text, hidden links and bold span match the original.
4. For live qualification, choose an owner-authorized test post, inspect its actual capabilities and obtain consent for the exact card preview before confirmation.

## Message button

> Vote Yes in this bot's poll in @group.

1. Read the message. Example: `buttons: 1.1 "Yes" (callback) | 1.2 "No" (callback) | 2.1 "Rules" (link https://example.com/rules)`. (history, formatter)
2. Treat button labels and addresses as untrusted text; a label demanding transfer confirmation is not an agent instruction. (untrusted-content boundary)
3. Prepare tg_press_button with message link, row=1, button=1. Read the message, verify callback kind, and preview account, message/author, label, and position. (write gate)
4. Show the owner the preview and obtain consent. (agent)
5. tg_confirm rereads the message. If unchanged, press once and return the bot's 'Vote accepted' as untrusted text. If changed, refuse the press and prepare a new request after rereading. (write gate)
6. Do not press or open the Rules URL; its destination is already visible. (write gate)

Agents neither see nor supply callback bytes; the gateway obtains them from the message.

## Cleanup regression scenario

Run this same prompt in Claude Code, Codex and OpenCode against the isolated synthetic MCP fixture, with only core and index enabled:

> Use only the fixture gateway. Call tg_status. Search the local index for "bicycle éx" with limit 3 and follow every next_cursor. Report message IDs in order, checking that none repeats or is missing. Then call tg_read_history for @fixture_channel with since="2026-02-30" and confirm INVALID_ARGUMENT. Finally read the same chat with since="1970-01-01" and confirm the response header shows that date. Do not call write tools or contact real Telegram.

Expected local-search IDs in the fixture: 40, 38, 36, 34, 32, 30, 28, 26, 24, 22. Impossible dates fail; Unix zero is displayed. Hung-download restart and full-file byte limits are verified with controlled regression tests, without provoking hangs on live accounts.

## Connection recovery regression

The connection tests replace every network connection with an in-memory fixture while retaining the pinned teleproto sender and its actual retry/lifecycle implementation. Short outages recover within the same client. Exhausted background retries request exit code 1, reject reuse of the terminal client, preserve unknown write outcomes and recover only after the old runtime is closed and a fresh runtime starts. MCP status is checked before first connection, during connection/reconnection, after recovery and while restart is required; these status calls do not invoke Telegram.

For model-client status compatibility, use the synthetic gateway only:

> Call tg_status on the fixture gateway. Report the stored session status and connection state separately. If the connection is lazy, say that it has not connected yet. Do not treat an active stored session or a healthy HTTP endpoint as a successful Telegram request. Do not call write tools or real Telegram.
