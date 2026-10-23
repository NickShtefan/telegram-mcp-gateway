/**
 * `tg-mcp doctor`: installation checks. Without `--connect`, opens nothing
 * in Telegram. With it, connects accounts only when the daemon is stopped:
 * a second process on the same sessions is forbidden.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ClientFactory } from '../core/clientPool.js';
import { loadSessionSecret, RETIRED_TOOLSETS, type GatewayConfig } from '../core/config.js';
import { acquireLock, isLockHeld } from '../core/lock.js';
import { createLogger } from '../core/log.js';
import { readPrivateMode } from '../policy/scopes.js';
import { createRuntime } from '../runtime.js';
import { DEFAULT_WRITE_LIMITS } from '../services/write.js';
import type { Storage } from '../storage/port.js';
import { describeAccounts, describeUsers } from './admin.js';
import type { CliIo } from './io.js';

export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface Check {
  level: CheckLevel;
  message: string;
}

export interface DoctorOptions {
  config: GatewayConfig;
  storage: Storage;
  io: CliIo;
  connect?: boolean;
  factory?: ClientFactory;
  nodeVersion?: string;
}

const MIN_NODE = [22, 13] as const;

function nodeOk(version: string): boolean {
  const m = version.replace(/^v/, '').match(/^(\d+)\.(\d+)/);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

export async function collectChecks(options: DoctorOptions): Promise<Check[]> {
  const { config, storage } = options;
  const checks: Check[] = [];
  const add = (level: CheckLevel, message: string): void => void checks.push({ level, message });

  const nodeVersion = options.nodeVersion ?? process.version;
  add(nodeOk(nodeVersion) ? 'ok' : 'fail', `Node.js ${nodeVersion} (needs ${MIN_NODE.join('.')} or newer)`);

  const mode = statSync(config.home).mode & 0o777;
  add(
    (mode & 0o077) === 0 ? 'ok' : 'warn',
    `home ${config.home} (mode ${mode.toString(8)}${(mode & 0o077) === 0 ? '' : ': readable by other users, run chmod 700'})`,
  );

  add('ok', `database ${config.dbPath}`);

  if (config.apiId !== null && config.apiHash !== null) add('ok', 'Telegram API credentials are set');
  else add('fail', `Telegram API credentials are missing: put TG_API_ID and TG_API_HASH into ${join(config.home, '.env')}`);

  const keyFromEnv = Boolean(process.env.TG_MCP_SESSION_KEY?.trim());
  const keyFile = join(config.home, 'session.key');
  if (keyFromEnv) add('ok', 'session key comes from TG_MCP_SESSION_KEY');
  else if (existsSync(keyFile)) {
    const keyMode = statSync(keyFile).mode & 0o777;
    add((keyMode & 0o077) === 0 ? 'ok' : 'fail', `session key file (mode ${keyMode.toString(8)})`);
  } else add('warn', 'session key file does not exist yet: it is created on the first login');

  add('ok', `toolsets: ${config.toolsets.join(', ')}`);
  const retired = (process.env.TG_MCP_TOOLSETS ?? '')
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter(t => RETIRED_TOOLSETS.includes(t));
  if (retired.length > 0) add('warn', `toolset "${retired.join(', ')}" no longer exists and is ignored: remove it from TG_MCP_TOOLSETS`);

  if (config.toolsets.includes('write')) {
    const limits = { ...DEFAULT_WRITE_LIMITS, ...config.writeLimits };
    const show = (n: number): string => (n > 0 ? String(n) : 'no limit');
    add(
      'ok',
      `write limits per account per day: replies ${show(limits.repliesPerDay)}, new dialogs ${show(limits.newDialogsPerDay)}, joins ${show(limits.joinsPerDay)}, reactions ${show(limits.reactionsPerDay)}`,
    );
  }

  const users = describeUsers(storage);
  if (users.length === 0) add('warn', 'no gateway users: add one with tg-mcp user add <id>');
  for (const u of users) {
    add(
      u.accounts.length > 0 ? 'ok' : 'warn',
      `user ${u.id}: accounts [${u.accounts.join(', ')}]${u.defaultAccount ? `, default ${u.defaultAccount}` : ''}`,
    );
    for (const accountId of u.accounts) {
      const mode = readPrivateMode(storage, u.id, accountId);
      if (mode !== 'closed') {
        add('ok', `user ${u.id} on account ${accountId}: private chats are ${mode === 'open' ? 'open for reading and sending' : 'open for sending only'} (tg-mcp scope private)`);
      }
    }
  }

  const accounts = describeAccounts(storage);
  if (accounts.length === 0) add('warn', 'no Telegram accounts: log in with tg-mcp login --account <id>');
  for (const a of accounts) {
    const who = a.username ? `@${a.username}` : (a.displayName ?? 'unknown');
    const level: CheckLevel = !a.hasSession || a.status !== 'active' ? 'fail' : a.users.length === 0 ? 'warn' : 'ok';
    add(
      level,
      `account ${a.id}: ${a.hasSession ? `session stored, status ${a.status}, ${who}` : 'no session, run tg-mcp login'}; users [${a.users.join(', ')}]${a.shared ? ' (shared)' : ''}`,
    );
  }

  const daemonRunning = await isLockHeld(config.home);
  add('ok', daemonRunning ? 'daemon is running' : 'daemon is not running');

  if (options.connect) {
    if (daemonRunning) {
      add('warn', 'skipping --connect: the daemon owns the sessions, a second process must not open them');
    } else if (config.apiId === null || config.apiHash === null) {
      add('fail', 'cannot connect without Telegram API credentials');
    } else {
      const runtime = createRuntime(config, {
        storage,
        clientFactory: options.factory,
        sessionSecret: loadSessionSecret(config.home),
        log: createLogger('doctor'),
        // Report hangs as errors without terminating the checking process.
        exit: () => undefined,
      });
      // Hold ownership while checking; the daemon must not start concurrently.
      const lock = await acquireLock(config.home);
      try {
        for (const a of accounts.filter(x => x.hasSession)) {
          try {
            const me = await runtime.tg.whoami(a.id);
            add('ok', `account ${a.id} connects: ${me.username ? '@' + me.username : me.displayName} (id ${me.tgUserId})`);
          } catch (err) {
            add('fail', `account ${a.id} does not connect: ${(err as Error).message}`);
          }
        }
      } finally {
        runtime.limiter.shutdown();
        await runtime.pool.destroyAll();
        await lock.release();
      }
    }
  }

  return checks;
}

export async function runDoctor(options: DoctorOptions): Promise<number> {
  const checks = await collectChecks(options);
  const label: Record<CheckLevel, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };
  for (const c of checks) options.io.out(`${label[c.level]}  ${c.message}`);
  const failed = checks.filter(c => c.level === 'fail').length;
  const warned = checks.filter(c => c.level === 'warn').length;
  options.io.out(failed > 0 ? `${failed} problem(s), ${warned} warning(s).` : `No problems, ${warned} warning(s).`);
  return failed > 0 ? 1 : 0;
}
