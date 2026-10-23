/**
 * The sole Telegram entry point for services. Every MTProto call passes
 * through the account limiter with a deadline; no direct queue bypasses.
 */
import type { Api, TelegramClient } from 'teleproto';
import type { ClientPool, AccountIdentity } from './clientPool.js';
import { harvestEntities } from './entities.js';
import { GatewayError, isGatewayError } from './errors.js';
import type { AccountLimiter, CallOptions, LaneStatus } from './limiter.js';
import { createLogger, type Logger } from './log.js';
import type { EntitiesRepo } from '../storage/port.js';
import { DeadlineError, withTimeout } from './time.js';

export type TgCallOptions = Partial<CallOptions>;

/** Authentication library calls also enter the same core queue/deadline boundary. */
export function queueLoginCalls(client: TelegramClient, accountId: string, limiter: AccountLimiter, fatal: () => never, connectTimeoutMs = 30_000): () => void {
  const original = client.invoke;
  if (typeof original !== 'function') return () => undefined;
  const invoke = original.bind(client);
  const connect = client.connect;
  if (typeof connect === 'function') client.connect = (async () => {
    try { return await withTimeout(connect.call(client), connectTimeoutMs, 'auth connection'); }
    catch (err) { if (err instanceof DeadlineError) return fatal(); throw err; }
  }) as TelegramClient['connect'];
  client.invoke = (async (request: Api.AnyRequest, dcId?: number, options?: Api.ApiCallOptions) => limiter.run(accountId, () => invoke(request, dcId, options), {
    label: (request as { className?: string }).className ?? 'auth', write: true, authentication: true,
  })) as TelegramClient['invoke'];
  return () => { client.invoke = original; client.connect = connect; };
}

export interface Tg {
  /** MTProto request in the account lane; cache response entities per account. */
  invoke<R extends Api.AnyRequest>(accountId: string, request: R, options?: TgCallOptions): Promise<R['__response']>;
  /** Operation needing the client (file download), in the same lane. */
  withClient<T>(accountId: string, label: string, fn: (client: TelegramClient) => Promise<T>, options?: TgCallOptions): Promise<T>;
  /** Account identity; connect lazily if necessary. */
  whoami(accountId: string): Promise<AccountIdentity>;
  laneStatus(accountId: string): LaneStatus;
}

export interface TgGatewayOptions {
  pool: ClientPool;
  limiter: AccountLimiter;
  entities: EntitiesRepo;
  log?: Logger;
}

export class TgGateway implements Tg {
  private readonly log: Logger;

  constructor(private readonly options: TgGatewayOptions) {
    this.log = options.log ?? createLogger('tg');
  }

  async invoke<R extends Api.AnyRequest>(accountId: string, request: R, options: TgCallOptions = {}): Promise<R['__response']> {
    const label = options.label ?? (request as { className?: string }).className ?? 'invoke';
    const result = await this.run(accountId, label, client => client.invoke(request), options);
    this.remember(accountId, result);
    return result;
  }

  withClient<T>(accountId: string, label: string, fn: (client: TelegramClient) => Promise<T>, options: TgCallOptions = {}): Promise<T> {
    return this.run(accountId, label, fn, options);
  }

  async whoami(accountId: string): Promise<AccountIdentity> {
    await this.options.pool.getClient(accountId);
    return this.options.pool.identity(accountId)!;
  }

  laneStatus(accountId: string): LaneStatus {
    return this.options.limiter.status(accountId);
  }

  private async run<T>(accountId: string, label: string, fn: (client: TelegramClient) => Promise<T>, options: TgCallOptions): Promise<T> {
    // Connect outside the lane: it has its own deadline and concurrent-attempt coalescing.
    const client = await this.options.pool.getClient(accountId);
    let started = false;
    try {
      return await this.options.limiter.run(accountId, () => {
        started = true;
        return fn(client);
      }, { ...options, label });
    } catch (err) {
      if (isGatewayError(err, 'ACCOUNT_UNAUTHORIZED')) {
        this.log.error('session is no longer valid', { account: accountId, label });
        await this.options.pool.markUnauthorized(accountId);
      } else if ((isGatewayError(err, 'TELEGRAM_ERROR') || isGatewayError(err, 'UNAVAILABLE')) && this.options.pool.restartIfDisconnected(accountId)) {
        throw new GatewayError('UNAVAILABLE', 'The Telegram connection was lost and the gateway is restarting. Retry reads after restart; check Telegram before repeating a write.', {
          cause: err,
          outcomeUnknown: options.write === true && started,
        });
      }
      throw err;
    }
  }

  private remember(accountId: string, result: unknown): void {
    try {
      const entities = harvestEntities(result);
      if (entities.length > 0) {
        this.options.entities.putMany(entities.map(e => ({ accountId, ...e })));
      }
    } catch (err) {
      // Caching is an optimization; a cache failure must not fail the call.
      this.log.warn('entity cache write failed', { account: accountId, error: err as Error });
    }
  }
}
