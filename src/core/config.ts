/**
 * Gateway configuration. All state is in the gateway home directory
 * (`TG_MCP_HOME`, default `~/.tg-mcp`): database, session encryption key,
 * and `.env`. On the lab machine this is a separate macOS user's home
 * and is inaccessible to agents (decision 17).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomToken } from './crypto.js';
import { GatewayError } from './errors.js';

export interface GatewayConfig {
  home: string;
  dbPath: string;
  /** Export/image directory readable by agents. */
  filesDir: string;
  host: string;
  port: number;
  toolsets: string[];
  apiId: number | null;
  apiHash: string | null;
  /** Owner-configured daily write limits. Missing values use defaults. */
  writeLimits: WriteLimitsConfig;
}

/** Per-account daily write limits; 0 removes a limit. */
export interface WriteLimitsConfig {
  repliesPerDay?: number;
  newDialogsPerDay?: number;
  joinsPerDay?: number;
  reactionsPerDay?: number;
}

const WRITE_LIMIT_ENV: Record<keyof WriteLimitsConfig, string> = {
  repliesPerDay: 'TG_MCP_LIMIT_REPLIES',
  newDialogsPerDay: 'TG_MCP_LIMIT_NEW_DIALOGS',
  joinsPerDay: 'TG_MCP_LIMIT_JOINS',
  reactionsPerDay: 'TG_MCP_LIMIT_REACTIONS',
};

export const DEFAULT_PORT = 7777;
export const DEFAULT_HOST = '127.0.0.1';
const KNOWN_TOOLSETS = ['core', 'discover', 'analytics', 'index', 'write'] as const;
/** Removed toolsets are skipped so old .env files do not crash startup. */
export const RETIRED_TOOLSETS: readonly string[] = ['automate'];

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(expandHome(env.TG_MCP_HOME?.trim() || '~/.tg-mcp'));
}

/** Load `<home>/.env` without overriding existing environment variables. */
function loadEnvFile(home: string, env: NodeJS.ProcessEnv = process.env): void {
  const path = join(home, '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
}

export function parseToolsets(raw: string | undefined): string[] {
  const requested = (raw ?? 'core')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
    .filter(s => !RETIRED_TOOLSETS.includes(s));
  const unknown = requested.filter(t => !(KNOWN_TOOLSETS as readonly string[]).includes(t));
  if (unknown.length > 0) {
    // A typo must not silently reduce the available toolsets.
    throw new GatewayError(
      'INVALID_ARGUMENT',
      `Unknown toolset(s): ${unknown.join(', ')}. Known: ${KNOWN_TOOLSETS.join(', ')}.`,
    );
  }
  return [...new Set(requested.length > 0 ? requested : ['core'])];
}

function parseWriteLimits(env: NodeJS.ProcessEnv = process.env): WriteLimitsConfig {
  const limits: WriteLimitsConfig = {};
  for (const [key, name] of Object.entries(WRITE_LIMIT_ENV) as Array<[keyof WriteLimitsConfig, string]>) {
    const raw = (env[name] ?? '').trim();
    if (raw === '') continue;
    // Invalid numbers must not silently restore defaults or disable limits.
    if (!/^\d{1,6}$/.test(raw)) {
      throw new GatewayError('INVALID_ARGUMENT', `${name} must be a whole number of actions per day (0 turns the limit off), got "${raw}".`);
    }
    limits[key] = Number(raw);
  }
  return limits;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const home = resolveHome(env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  loadEnvFile(home, env);

  const apiIdRaw = (env.TG_API_ID ?? env.API_ID ?? '').trim();
  const apiId = /^\d+$/.test(apiIdRaw) ? Number(apiIdRaw) : null;
  const apiHash = (env.TG_API_HASH ?? env.API_HASH ?? '').trim() || null;

  const portRaw = (env.TG_MCP_PORT ?? '').trim();
  const port = /^\d+$/.test(portRaw) && Number(portRaw) > 0 && Number(portRaw) < 65536 ? Number(portRaw) : DEFAULT_PORT;

  return {
    home,
    dbPath: resolve(expandHome(env.TG_MCP_DB?.trim() || join(home, 'gateway.sqlite'))),
    filesDir: resolve(expandHome(env.TG_MCP_FILES_DIR?.trim() || join(home, 'files'))),
    host: env.TG_MCP_HOST?.trim() || DEFAULT_HOST,
    port,
    toolsets: parseToolsets(env.TG_MCP_TOOLSETS),
    apiId,
    apiHash,
    writeLimits: parseWriteLimits(env),
  };
}

export function requireApiCredentials(config: GatewayConfig): { apiId: number; apiHash: string } {
  if (config.apiId === null || config.apiHash === null) {
    throw new GatewayError(
      'INVALID_ARGUMENT',
      `Telegram API credentials are missing. Put TG_API_ID and TG_API_HASH (from my.telegram.org) into ${join(config.home, '.env')}.`,
    );
  }
  return { apiId: config.apiId, apiHash: config.apiHash };
}

/**
 * Session encryption secret from `TG_MCP_SESSION_KEY`, otherwise
 * `<home>/session.key`; create it with mode 0600 on first use.
 */
export function loadSessionSecret(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.TG_MCP_SESSION_KEY?.trim();
  if (fromEnv) return fromEnv;

  const path = join(home, 'session.key');
  if (existsSync(path)) {
    const value = readFileSync(path, 'utf8').trim();
    if (!value) throw new GatewayError('INVALID_ARGUMENT', `Session key file ${path} is empty.`);
    return value;
  }
  const secret = randomToken(32);
  try {
    // wx: use a key created concurrently by another process; never overwrite it.
    writeFileSync(path, secret + '\n', { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return readFileSync(path, 'utf8').trim();
  }
  chmodSync(path, 0o600);
  return secret;
}
