/**
 * Parse human-facing `tg-mcp` commands: login, diagnostics, users,
 * and accounts. `serve` and `stdio` start daemon/proxy for agents.
 */
import { parseArgs } from 'node:util';
import { loadConfig, type GatewayConfig } from '../core/config.js';
import { GatewayError } from '../core/errors.js';
import type { PrivateMode } from '../policy/scopes.js';
import type { Storage } from '../storage/port.js';
import { openStorage } from '../storage/sqlite.js';
import {
  addUser,
  describeAccounts,
  describeUsers,
  getPrivateMode,
  grantAccount,
  listScopes,
  removeAccount,
  removeScope,
  removeUser,
  revokeAccount,
  rotateToken,
  setDefaultAccount,
  setPrivateMode,
  setScope,
} from './admin.js';
import { runDoctor } from './doctor.js';
import { terminalIo, type CliIo } from './io.js';
import { runLogin } from './login.js';
import { runServe } from './serve.js';
import { createLogger } from '../core/log.js';
import { DEFAULT_HOST, DEFAULT_PORT } from '../core/config.js';
import { runStdioProxy } from '../transport/stdio.js';
import { runSetup, type SetupCliDeps } from './setup.js';

const VERSION = '0.2.0';

const HELP = `tg-mcp ${VERSION}: Telegram MCP gateway

Usage:
  tg-mcp setup preflight [--json] [--port <n>] [--client none|codex|claude|opencode|hermes]  inspect without changing gateway state
  tg-mcp serve [--host <h>] [--port <n>] [--toolsets core,...] [--files-dir <path>]
                                                   run the daemon that owns the Telegram sessions
  tg-mcp stdio [--url <http://127.0.0.1:7777/mcp>] stdio MCP server for agents: proxies to the daemon, token in TG_MCP_TOKEN
  tg-mcp login --account <id> [--phone <number>]   log in to a Telegram account (code and 2FA are asked interactively)
  tg-mcp doctor [--connect]                        check the installation; --connect also opens the sessions
  tg-mcp user add <id> [--account <id>]... [--default-account <id>]
  tg-mcp user list
  tg-mcp user token <id>                           issue a new token (the old one stops working)
  tg-mcp user default <id> <account>
  tg-mcp user remove <id>
  tg-mcp account list
  tg-mcp account grant <account> <user>
  tg-mcp account revoke <account> <user>
  tg-mcp account remove <account>
  tg-mcp scope list <user> <account>
  tg-mcp scope allow|deny <user> <account> <chat>  open a private chat to a user, or close any chat
  tg-mcp scope remove <user> <account> <chat>
  tg-mcp scope private <user> <account> [closed|send|open]  private chats: closed (default), send only, or read and write

State lives in TG_MCP_HOME (default ~/.tg-mcp). Telegram API credentials go to <home>/.env as TG_API_ID and TG_API_HASH.`;

export interface CliDeps {
  io?: CliIo;
  env?: NodeJS.ProcessEnv;
  /** Tests inject ready configuration/storage instead of disk files. */
  config?: GatewayConfig;
  storage?: Storage;
  setup?: SetupCliDeps;
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new GatewayError('INVALID_ARGUMENT', `Missing ${what}. Run "tg-mcp help" for usage.`);
  return value;
}

export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const io = deps.io ?? terminalIo;
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    io.out(HELP);
    return 0;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    io.out(VERSION);
    return 0;
  }

  // These read-only commands must never create TG_MCP_HOME or initialize SQLite.
  if (command === 'setup') return runSetup(rest, io, deps.setup);

  if (command === 'stdio') {
    // The proxy runs as the agent user and never touches the gateway home.
    const env = deps.env ?? process.env;
    try {
      const { values } = parseArgs({ args: rest, options: { url: { type: 'string' } } });
      const token = env.TG_MCP_TOKEN?.trim();
      if (!token) throw new GatewayError('INVALID_ARGUMENT', 'TG_MCP_TOKEN is not set: the stdio proxy needs your gateway token.');
      const url = values.url ?? env.TG_MCP_URL?.trim() ?? `http://${DEFAULT_HOST}:${env.TG_MCP_PORT?.trim() || DEFAULT_PORT}/mcp`;
      await runStdioProxy({ url, token, input: process.stdin, output: process.stdout, log: createLogger('stdio') });
      return 0;
    } catch (err) {
      io.err(`error: ${(err as Error).message}`);
      return 1;
    }
  }

  let storage: Storage | null = null;
  const ownsStorage = deps.storage === undefined;
  try {
    const config = deps.config ?? loadConfig(deps.env ?? process.env);
    const getStorage = (): Storage => {
      storage ??= deps.storage ?? openStorage(config.dbPath);
      return storage;
    };

    switch (command) {
      case 'serve': {
        const { values } = parseArgs({
          args: rest,
          options: {
            host: { type: 'string' },
            port: { type: 'string' },
            toolsets: { type: 'string' },
            'files-dir': { type: 'string' },
            'allow-origin': { type: 'string', multiple: true },
          },
        });
        const port = values.port !== undefined ? Number(values.port) : undefined;
        if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
          throw new GatewayError('INVALID_ARGUMENT', '--port must be a number between 1 and 65535.');
        }
        return await runServe({
          config,
          io,
          version: VERSION,
          host: values.host,
          port,
          toolsets: values.toolsets,
          filesDir: values['files-dir'],
          allowedOrigins: values['allow-origin'],
        });
      }

      case 'login': {
        const { values } = parseArgs({
          args: rest,
          options: { account: { type: 'string' }, phone: { type: 'string' } },
        });
        await runLogin({ config, storage: getStorage(), io, account: need(values.account, '--account'), phone: values.phone });
        return 0;
      }

      case 'doctor': {
        const { values } = parseArgs({ args: rest, options: { connect: { type: 'boolean', default: false } } });
        return await runDoctor({ config, storage: getStorage(), io, connect: values.connect });
      }

      case 'user':
        return userCommand(rest, getStorage(), io);

      case 'account':
        return accountCommand(rest, getStorage(), io);

      case 'scope':
        return scopeCommand(rest, getStorage(), io);

      default:
        throw new GatewayError('INVALID_ARGUMENT', `Unknown command "${command}". Run "tg-mcp help" for usage.`);
    }
  } catch (err) {
    io.err(`error: ${(err as Error).message}`);
    return 1;
  } finally {
    if (ownsStorage) (storage as Storage | null)?.close();
  }
}

function userCommand(args: string[], storage: Storage, io: CliIo): number {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'add': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          account: { type: 'string', multiple: true },
          'default-account': { type: 'string' },
        },
      });
      const { user, token } = addUser(storage, {
        id: need(positionals[0], 'user id'),
        accounts: values.account ?? [],
        defaultAccount: values['default-account'] ?? null,
      });
      io.out(`User "${user.id}" created.`);
      io.out(`Token (shown once, the gateway stores only its hash):`);
      io.out(token);
      return 0;
    }
    case 'list': {
      const users = describeUsers(storage);
      if (users.length === 0) io.out('No users.');
      for (const u of users) {
        io.out(
          `${u.id}  accounts: [${u.accounts.join(', ')}]  default: ${u.defaultAccount ?? '-'}`,
        );
      }
      return 0;
    }
    case 'token': {
      const id = need(rest[0], 'user id');
      const token = rotateToken(storage, id);
      io.out(`New token for "${id}" (shown once):`);
      io.out(token);
      return 0;
    }
    case 'default': {
      const id = need(rest[0], 'user id');
      const account = need(rest[1], 'account id');
      setDefaultAccount(storage, id, account);
      io.out(`Default account of "${id}" is now "${account}".`);
      return 0;
    }
    case 'remove': {
      const id = need(rest[0], 'user id');
      removeUser(storage, id);
      io.out(`User "${id}" removed.`);
      return 0;
    }
    default:
      throw new GatewayError('INVALID_ARGUMENT', 'Usage: tg-mcp user add|list|token|default|remove');
  }
}

function accountCommand(args: string[], storage: Storage, io: CliIo): number {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'list': {
      const accounts = describeAccounts(storage);
      if (accounts.length === 0) io.out('No accounts.');
      for (const a of accounts) {
        const who = a.username ? `@${a.username}` : (a.displayName ?? '-');
        io.out(
          `${a.id}  ${a.hasSession ? a.status : 'no session'}  ${who}  users: [${a.users.join(', ')}]${a.shared ? '  shared' : ''}`,
        );
      }
      return 0;
    }
    case 'grant': {
      const account = need(rest[0], 'account id');
      const user = need(rest[1], 'user id');
      grantAccount(storage, account, user);
      io.out(`User "${user}" can now use account "${account}".`);
      return 0;
    }
    case 'revoke': {
      const account = need(rest[0], 'account id');
      const user = need(rest[1], 'user id');
      revokeAccount(storage, account, user);
      io.out(`User "${user}" can no longer use account "${account}".`);
      return 0;
    }
    case 'remove': {
      const account = need(rest[0], 'account id');
      removeAccount(storage, account);
      io.out(`Account "${account}" and its session are removed.`);
      return 0;
    }
    default:
      throw new GatewayError('INVALID_ARGUMENT', 'Usage: tg-mcp account list|grant|revoke|remove');
  }
}

const PRIVATE_MODE_NOTES: Record<PrivateMode, string> = {
  closed: 'closed (the agent reads and writes only the chats opened with "scope allow")',
  send: 'send (the agent can prepare a message to any person, but reads only the chats opened with "scope allow")',
  open: 'open (the agent can read and write any private chat)',
};

function scopeCommand(args: string[], storage: Storage, io: CliIo): number {
  const [sub, user, account, chat] = args;
  switch (sub) {
    case 'list': {
      const rules = listScopes(storage, need(user, 'user id'), need(account, 'account id'));
      io.out(`Private chats: ${PRIVATE_MODE_NOTES[getPrivateMode(storage, user!, account!)]}`);
      if (rules.length === 0) io.out('No rules for single chats: channels and groups are open, Telegram service chats are closed.');
      for (const r of rules) io.out(`${r.effect}  ${/^-?\d+$/.test(r.target) ? r.target : '@' + r.target}`);
      return 0;
    }
    case 'allow':
    case 'deny': {
      const target = setScope(storage, need(user, 'user id'), need(account, 'account id'), need(chat, 'chat'), sub);
      io.out(`${sub === 'allow' ? 'Opened' : 'Closed'} ${target} for user "${user}" on account "${account}".`);
      return 0;
    }
    case 'remove': {
      const removed = removeScope(storage, need(user, 'user id'), need(account, 'account id'), need(chat, 'chat'));
      io.out(removed > 0 ? 'Rule removed.' : 'No such rule.');
      return 0;
    }
    case 'private': {
      // Without a mode, only display the current setting.
      const mode = chat === undefined ? getPrivateMode(storage, need(user, 'user id'), need(account, 'account id')) : setPrivateMode(storage, need(user, 'user id'), need(account, 'account id'), chat);
      io.out(`Private chats for user "${user}" on account "${account}": ${PRIVATE_MODE_NOTES[mode]}`);
      return 0;
    }
    default:
      throw new GatewayError('INVALID_ARGUMENT', 'Usage: tg-mcp scope list|allow|deny|remove|private <user> <account> [chat or mode]');
  }
}
