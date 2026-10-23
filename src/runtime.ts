/**
 * Composes storage, limiter, client pool, and call gateway once per
 * process. Explicit dependencies allow test substitution.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ClientPool, type ClientFactory } from './core/clientPool.js';
import { loadSessionSecret, requireApiCredentials, type GatewayConfig } from './core/config.js';
import { AccountLimiter, type LimiterOptions } from './core/limiter.js';
import { createLogger, type Logger } from './core/log.js';
import { createFatalHandler, type ExitProcess } from './core/recovery.js';
import { TgGateway, type Tg } from './core/tg.js';
import type { Storage } from './storage/port.js';
import { openStorage } from './storage/sqlite.js';

export interface Runtime {
  config: GatewayConfig;
  storage: Storage;
  limiter: AccountLimiter;
  pool: ClientPool;
  tg: Tg;
  log: Logger;
  /** Stops queues and closes clients and the database. */
  close(): Promise<void>;
}

export interface RuntimeOverrides {
  storage?: Storage;
  clientFactory?: ClientFactory;
  sessionSecret?: string;
  exit?: ExitProcess;
  limiter?: Partial<LimiterOptions>;
  /** Grace period between rejecting waiting calls and exiting after a hang. */
  fatalGraceMs?: number;
  log?: Logger;
}

export function createRuntime(config: GatewayConfig, overrides: RuntimeOverrides = {}): Runtime {
  const log = overrides.log ?? createLogger('gateway');
  let storage = overrides.storage;
  if (!storage) {
    mkdirSync(dirname(config.dbPath), { recursive: true, mode: 0o700 });
    storage = openStorage(config.dbPath);
  }
  const store = storage;

  // Externally supplied storage is closed by its creator.
  const ownsStorage = overrides.storage === undefined;
  let limiterRef: AccountLimiter | null = null;
  const fatal = createFatalHandler({
    exit: overrides.exit,
    log: log.child('recovery'),
    // Let rejected calls record their outcomes before the process exits.
    prepare: () => limiterRef?.shutdown(),
    graceMs: overrides.fatalGraceMs ?? 300,
    beforeExit: () => {
      if (ownsStorage) store.close();
    },
  });

  const limiter = new AccountLimiter({ onFatal: fatal, log: log.child('limiter'), ...overrides.limiter });
  limiterRef = limiter;

  const pool = new ClientPool({
    storage: store,
    credentials: () => ({
      ...requireApiCredentials(config),
      sessionSecret: overrides.sessionSecret ?? loadSessionSecret(config.home),
    }),
    factory: overrides.clientFactory,
    onFatal: fatal,
    log: log.child('pool'),
  });

  const tg = new TgGateway({ pool, limiter, entities: store.entities, log: log.child('tg') });

  return {
    config,
    storage: store,
    limiter,
    pool,
    tg,
    log,
    close: async () => {
      limiter.shutdown();
      await pool.destroyAll();
      if (ownsStorage) store.close();
    },
  };
}
