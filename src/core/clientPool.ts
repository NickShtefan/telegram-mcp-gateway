/**
 * teleproto client pool: one connection per account; concurrent attempts
 * are coalesced, connect is time-bounded, and connection is non-interactive
 * with `getMe` verification.
 *
 * Never create a second client on the same session: AUTH_KEY_DUPLICATED.
 */
import { TelegramClient } from 'teleproto';
import { Logger as GramLogger } from 'teleproto/extensions';
import { LogLevel as GramLogLevel } from 'teleproto/extensions/Logger';
import { StringSession } from 'teleproto/sessions';
import { Raw } from 'teleproto/events';
import { UpdateConnectionState } from 'teleproto/network';
import { unseal } from './crypto.js';
import { classifyError, GatewayError } from './errors.js';
import { createLogger, type Logger } from './log.js';
import { DeadlineError, withTimeout } from './time.js';
import type { Storage } from '../storage/port.js';

export interface ClientParams {
  session: string;
  apiId: number;
  apiHash: string;
  log: Logger;
}

export type ClientFactory = (params: ClientParams) => TelegramClient;

export type ConnectionState = 'not_connected' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'restart_required';

/** teleproto logger routed through the gateway logger to stderr. */
class StderrGramLogger extends GramLogger {
  constructor(private readonly sink: Logger) {
    super(GramLogLevel.WARN);
  }

  // The base logger uses console.log/stdout; this method replaces it completely.
  override log(level: GramLogLevel, message: string, error?: unknown): void {
    const text = error === undefined ? message : `${message}: ${error instanceof Error ? error.message : String(error)}`;
    if (level === GramLogLevel.ERROR) this.sink.error(text);
    else if (level === GramLogLevel.WARN) this.sink.warn(text);
    else this.sink.debug(text);
  }
}

export const defaultClientFactory: ClientFactory = ({ session, apiId, apiHash, log }) =>
  new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 5,
    // The gateway limiter handles FLOOD_WAIT; teleproto must not sleep silently.
    floodSleepThreshold: 0,
    baseLogger: new StderrGramLogger(log),
  });

export interface AccountIdentity {
  tgUserId: string;
  username: string | null;
  displayName: string | null;
}

export interface PoolCredentials {
  apiId: number;
  apiHash: string;
  /** Secret used to decrypt sessions. */
  sessionSecret: string;
}

export interface ClientPoolOptions {
  storage: Storage;
  /**
   * Request credentials on the first connection rather than pool creation:
   * commands not using Telegram can work without them.
   */
  credentials: () => PoolCredentials;
  factory?: ClientFactory;
  connectTimeoutMs?: number;
  /** Connection hung: the process must exit. */
  onFatal: (reason: string) => void;
  log?: Logger;
}

interface MeLike {
  id?: unknown;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

export class ClientPool {
  private readonly clients = new Map<string, TelegramClient>();
  private readonly pending = new Map<string, Promise<TelegramClient>>();
  private readonly identities = new Map<string, AccountIdentity>();
  private readonly connectionHandlers = new Map<string, () => void>();
  private restartRequested = false;
  private readonly factory: ClientFactory;
  private readonly connectTimeoutMs: number;
  private readonly log: Logger;

  constructor(private readonly options: ClientPoolOptions) {
    this.factory = options.factory ?? defaultClientFactory;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
    this.log = options.log ?? createLogger('pool');
  }

  async getClient(accountId: string): Promise<TelegramClient> {
    if (this.restartIfDisconnected(accountId)) throw this.unavailable();
    const existing = this.clients.get(accountId);
    if (existing) return existing;

    const pending = this.pending.get(accountId);
    if (pending) {
      const client = await pending;
      if (this.restartIfDisconnected(accountId)) throw this.unavailable();
      return client;
    }

    const connecting = this.connect(accountId);
    this.pending.set(accountId, connecting);
    try {
      const client = await connecting;
      if (this.restartIfDisconnected(accountId)) throw this.unavailable();
      return client;
    } finally {
      this.pending.delete(accountId);
    }
  }

  /** Local transport state only: inspecting it never connects or calls Telegram. */
  connectionState(accountId: string): ConnectionState {
    if (this.restartRequested) return 'restart_required';
    const client = this.clients.get(accountId);
    if (!client) return this.pending.has(accountId) ? 'connecting' : 'not_connected';
    // Pinned teleproto distinguishes terminal dead from temporary reconnecting.
    // client.disconnected alone is true for both, so it cannot decide recovery.
    const state = client._sender?.lifecycle;
    if (state === 'dead') return 'restart_required';
    return state ?? (client.connected ? 'connected' : 'disconnected');
  }

  /** A terminal sender cannot recover itself. Never create a second client. */
  restartIfDisconnected(accountId: string): boolean {
    if (this.restartRequested) return true;
    if (this.connectionState(accountId) !== 'restart_required') return false;
    this.restartRequested = true;
    this.options.onFatal(`Telegram connection permanently disconnected (account ${accountId})`);
    return true;
  }

  private unavailable(): GatewayError {
    return new GatewayError('UNAVAILABLE', 'The gateway is restarting after losing its Telegram connection. Retry reads after restart; do not automatically repeat writes.');
  }

  private observeConnection(accountId: string, client: TelegramClient): void {
    const event = new Raw({ types: [UpdateConnectionState] });
    const handler = (update: unknown): void => {
      if (this.clients.get(accountId) !== client) return;
      if (update instanceof UpdateConnectionState && update.state === UpdateConnectionState.broken) {
        this.restartIfDisconnected(accountId);
      }
    };
    client.addEventHandler(handler, event);
    this.connectionHandlers.set(accountId, () => client.removeEventHandler(handler, event));
  }

  /** Connected account identity, available after the first connection. */
  identity(accountId: string): AccountIdentity | null {
    return this.identities.get(accountId) ?? null;
  }

  /** Invalidated session: close the client and mark the account. */
  async markUnauthorized(accountId: string): Promise<void> {
    this.options.storage.accounts.setStatus(accountId, 'unauthorized');
    await this.drop(accountId);
  }

  async drop(accountId: string): Promise<void> {
    const client = this.clients.get(accountId);
    this.clients.delete(accountId);
    this.identities.delete(accountId);
    this.connectionHandlers.get(accountId)?.();
    this.connectionHandlers.delete(accountId);
    if (client) await this.destroy(client);
  }

  async destroyAll(): Promise<void> {
    const ids = [...this.clients.keys()];
    await Promise.all(ids.map(id => this.drop(id)));
  }

  private async connect(accountId: string): Promise<TelegramClient> {
    const { storage } = this.options;
    const account = storage.accounts.get(accountId);
    if (!account) {
      throw new GatewayError('NOT_FOUND', `Account "${accountId}" is not configured in the gateway.`);
    }
    const sealed = storage.sessions.get(accountId);
    if (!sealed) {
      throw new GatewayError(
        'ACCOUNT_UNAUTHORIZED',
        `Account "${accountId}" has no Telegram session. The owner has to run: tg-mcp login --account ${accountId}`,
      );
    }

    const credentials = this.options.credentials();

    let session: string;
    try {
      session = unseal(sealed, credentials.sessionSecret);
    } catch {
      throw new GatewayError(
        'ACCOUNT_UNAUTHORIZED',
        `The stored session of account "${accountId}" cannot be decrypted (wrong session key). The owner has to log in again.`,
      );
    }

    const client = this.factory({
      session,
      apiId: credentials.apiId,
      apiHash: credentials.apiHash,
      log: this.log.child(`mtproto:${accountId}`),
    });

    let me: MeLike | null;
    try {
      // connect/getMe share a deadline; either can hang forever without networking.
      me = await withTimeout(
        (async () => {
          await client.connect();
          return (await client.getMe()) as MeLike | null;
        })(),
        this.connectTimeoutMs,
        `connect account ${accountId}`,
      );
    } catch (err) {
      await this.destroy(client);
      if (err instanceof DeadlineError) {
        this.options.onFatal(err.message);
        throw new GatewayError('UNAVAILABLE', `Could not connect account "${accountId}" to Telegram in time.`, { cause: err });
      }
      const classified = classifyError(err);
      if (classified.code === 'ACCOUNT_UNAUTHORIZED') {
        storage.accounts.setStatus(accountId, 'unauthorized');
      }
      throw classified;
    }

    if (!me || me.id === undefined || me.id === null) {
      await this.destroy(client);
      storage.accounts.setStatus(accountId, 'unauthorized');
      throw new GatewayError(
        'ACCOUNT_UNAUTHORIZED',
        `The Telegram session of account "${accountId}" is not authorized. The owner has to run: tg-mcp login --account ${accountId}`,
      );
    }

    const identity: AccountIdentity = {
      tgUserId: String(me.id),
      username: me.username ?? null,
      displayName: [me.firstName, me.lastName].filter(Boolean).join(' ').trim() || null,
    };
    this.identities.set(accountId, identity);
    storage.accounts.upsert({ id: accountId, ...identity, status: 'active' });
    this.clients.set(accountId, client);
    this.observeConnection(accountId, client);
    this.log.info('account connected', { account: accountId, username: identity.username });
    return client;
  }

  /** Use destroy, not disconnect, to avoid a zombie teleproto update loop. */
  private async destroy(client: TelegramClient): Promise<void> {
    try {
      await withTimeout(client.destroy(), 5_000, 'client.destroy');
    } catch {
      // Closing must not crash the caller.
    }
  }
}
