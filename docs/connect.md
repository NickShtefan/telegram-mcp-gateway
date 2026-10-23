# Client connections

Start one daemon and connect each client to its Streamable HTTP endpoint (default `http://127.0.0.1:7777/mcp`). Stdio clients can launch the proxy instead. Client configuration below uses placeholders; never commit real bearer tokens.

Managed installation provides a separate service identity and owner setup; fresh platform/client qualification and broader owner management remain pending. Administration examples describe the current CLI and must run in the authorized daemon-owner environment. They do not define a universal sudo policy.

## Users and accounts

```bash
tg-mcp user add user_a --account account_a
tg-mcp account grant account_a user_b
```

The new user's token is printed once; the database stores its hash. Give each client its own user's token. Put it in `TG_MCP_TOKEN` through a private environment or credential store.

## Claude Code

An isolated headless configuration file:

```json
{
  "mcpServers": {
    "telegram": {
      "type": "http",
      "url": "http://127.0.0.1:7777/mcp",
      "headers": { "Authorization": "Bearer ${TG_MCP_TOKEN}" }
    }
  }
}
```

Pass the file to `claude -p --strict-mcp-config --mcp-config <config-file>`. Configure client permissions so each `tg_confirm` call requires owner approval. Allowing other tools does not authorize confirmation.

## Codex

```toml
[mcp_servers.telegram]
url = "http://127.0.0.1:7777/mcp"
bearer_token_env_var = "TG_MCP_TOKEN"
tool_timeout_sec = 90
```

The timeout allows export/index calls to wait up to 20 seconds before returning a job ID. A one-off run can provide these settings through `codex exec -c` without editing the user's configuration.

## OpenCode

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "telegram": {
      "type": "remote",
      "url": "http://127.0.0.1:7777/mcp",
      "headers": { "Authorization": "Bearer {env:TG_MCP_TOKEN}" }
    }
  }
}
```

A model provider must also be configured to run an agent. MCP connection checks alone do not prove a full `opencode run` scenario.

## Any stdio client

```json
{
  "command": "tg-mcp",
  "args": ["stdio"],
  "env": { "TG_MCP_TOKEN": "<user-token>" }
}
```

The proxy opens no MTProto sessions. Set `TG_MCP_URL` for a non-default endpoint. Only JSON-RPC goes to stdout; logs go to stderr.

## Toolsets and private conversations

Set `TG_MCP_TOOLSETS=core,discover,analytics,index,write` in the daemon's private configuration to enable all five toolsets. Enable only those needed; restart the daemon after changing its configuration.

Private chats are closed by default. Owner commands, effective immediately:

```bash
tg-mcp scope allow user_a account_a @example_seller
tg-mcp scope private user_a account_a send
tg-mcp scope private user_a account_a closed
tg-mcp scope remove user_a account_a @example_seller
```

`send` permits sending without conversation reading; `open` also exposes every private conversation on that account. Daily write limits and confirmation still apply. Service chats remain closed.

## Agent-owned workflows

The gateway does not schedule work. A client can reread history, compare post IDs with its own memory, and prepare a summary or reply. Show a write preview to the owner; send only after consent through `tg_confirm`. Requests expire after 30 minutes, so prepare a fresh request when approval arrives later.

See [tools.md](tools.md), [architecture.md](architecture.md), [risks.md](risks.md) and [scenarios.md](scenarios.md). These examples define connection contracts, not a claim that every client/platform combination has passed release testing.
