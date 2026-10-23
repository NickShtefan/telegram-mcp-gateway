/**
 * Gateway logger: stderr ONLY. Any stdout line in stdio mode
 * breaks JSON-RPC. Gateway code never uses `console.log`.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** Fields whose values must never be logged. */
const SECRET_KEY = /token|hash|session|password|secret|authorization|api_?key|^key$/i;

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(tag: string): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  write?: (line: string) => void;
  now?: () => Date;
}

export function parseLogLevel(raw: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  const v = (raw ?? '').trim().toLowerCase();
  return Object.hasOwn(ORDER, v) ? (v as LogLevel) : fallback;
}

export function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_KEY.test(key)) {
      out[key] = '[redacted]';
    } else if (value instanceof Error) {
      out[key] = value.message;
    } else if (typeof value === 'bigint') {
      out[key] = value.toString();
    } else {
      out[key] = value;
    }
  }
  return out;
}

function safeStringify(fields: Record<string, unknown>): string {
  try {
    return JSON.stringify(fields, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return '{"log":"unserializable fields"}';
  }
}

export function createLogger(tag: string, options: LoggerOptions = {}): Logger {
  const level = options.level ?? parseLogLevel(process.env.TG_MCP_LOG_LEVEL);
  const write = options.write ?? ((line: string) => void process.stderr.write(line + '\n'));
  const now = options.now ?? (() => new Date());

  const emit = (lvl: Exclude<LogLevel, 'silent'>, message: string, fields?: Record<string, unknown>): void => {
    if (ORDER[lvl] < ORDER[level]) return;
    const suffix = fields && Object.keys(fields).length > 0 ? ' ' + safeStringify(redactFields(fields)) : '';
    write(`${now().toISOString()} ${lvl.toUpperCase()} [${tag}] ${message}${suffix}`);
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (sub: string) => createLogger(`${tag}:${sub}`, { level, write, now }),
  };
}

/**
 * Redirect `console.log/info/debug` to stderr. Invoke as the first entry-point
 * statement before importing teleproto, so third-party code cannot pollute stdout.
 */
export function redirectConsoleToStderr(): void {
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(args.map(a => (typeof a === 'string' ? a : safeInspect(a))).join(' ') + '\n');
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}

function safeInspect(value: unknown): string {
  try {
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  } catch {
    return String(value);
  }
}
