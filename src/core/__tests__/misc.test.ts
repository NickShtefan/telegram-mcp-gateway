import { describe, expect, it, vi } from 'vitest';
import { randomToken, safeEqualHex, seal, sha256Hex, unseal } from '../crypto.js';
import { createLogger, parseLogLevel, redactFields } from '../log.js';
import { normalizeReactions, reactionKey, totalReactions } from '../reactions.js';
import { DeadlineError, withTimeout } from '../time.js';

describe('crypto', () => {
  it('encrypts and decrypts sessions', () => {
    const sealed = seal('1BQANOTAREALSESSION==', 'secret-key');
    expect(sealed.data).not.toContain('1BQANOTAREALSESSION');
    expect(unseal(sealed, 'secret-key')).toBe('1BQANOTAREALSESSION==');
  });

  it('uses a unique IV for each record', () => {
    expect(seal('same', 'k').iv).not.toBe(seal('same', 'k').iv);
  });

  it('rejects the wrong key and corrupted data', () => {
    const sealed = seal('payload', 'right');
    expect(() => unseal(sealed, 'wrong')).toThrow();
    expect(() => unseal({ ...sealed, data: 'zz' }, 'right')).toThrow();
  });

  it('compares token hashes in constant time', () => {
    const token = randomToken();
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(safeEqualHex(sha256Hex(token), sha256Hex(token))).toBe(true);
    expect(safeEqualHex(sha256Hex(token), sha256Hex(token + 'x'))).toBe(false);
    expect(safeEqualHex('', '')).toBe(false);
  });
});

describe('log', () => {
  it('logs level, tag, and fields', () => {
    const lines: string[] = [];
    const log = createLogger('core', { level: 'debug', write: l => lines.push(l), now: () => new Date(0) });
    log.child('limiter').info('queued', { account: 'agent', n: 2 });
    expect(lines).toEqual(['1970-01-01T00:00:00.000Z INFO [core:limiter] queued {"account":"agent","n":2}']);
  });

  it.each(['constructor', '__proto__', 'toString', 'nonsense', '', undefined])('uses a filtering fallback for invalid level %s', value => {
    const level = parseLogLevel(value);
    expect(level).toBe('info');
    expect(parseLogLevel(value, 'warn')).toBe('warn');
    const lines: string[] = [];
    const log = createLogger('test', { level, write: line => lines.push(line) });
    log.debug('hidden');
    log.info('visible');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('visible');
  });

  it.each(['debug', 'info', 'warn', 'error', 'silent'] as const)('accepts the supported level %s', level => {
    expect(parseLogLevel(` ${level.toUpperCase()} `)).toBe(level);
  });

  it('honors the log level and redacts secrets', () => {
    const lines: string[] = [];
    const log = createLogger('t', { level: 'warn', write: l => lines.push(l) });
    log.info('skipped');
    log.warn('auth', { token: 'abc', apiHash: 'def', sessionString: 'x', user: 'user_a' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('abc');
    expect(lines[0]).not.toContain('def');
    expect(lines[0]).toContain('"user":"user_a"');
    expect(redactFields({ Authorization: 'Bearer 1', n: 1n })).toEqual({ Authorization: '[redacted]', n: '1' });
    expect(parseLogLevel('nonsense')).toBe('info');
  });
});

describe('reactions', () => {
  it('identifies standard, custom, and paid reactions', () => {
    expect(reactionKey({ className: 'ReactionEmoji', emoticon: '👍' })).toBe('👍');
    expect(reactionKey({ className: 'ReactionCustomEmoji', documentId: 5368324170671202286n })).toBe('custom:5368324170671202286');
    expect(reactionKey({ className: 'ReactionPaid' })).toBe('paid');
    expect(reactionKey(null)).toBe('null');
  });

  it('normalizes counters in descending order', () => {
    const reactions = normalizeReactions({
      results: [
        { reaction: { emoticon: '🔥' }, count: 2 },
        null,
        { reaction: { emoticon: '👍' }, count: 7 },
        { reaction: { emoticon: '😡' } },
      ],
    });
    expect(reactions).toEqual([
      { reaction: '👍', count: 7 },
      { reaction: '🔥', count: 2 },
    ]);
    expect(totalReactions(reactions)).toBe(9);
    expect(normalizeReactions(undefined)).toEqual([]);
  });
});

describe('time', () => {
  it('withTimeout returns the result and clears its timer', async () => {
    await expect(withTimeout(Promise.resolve(5), 1000, 'op')).resolves.toBe(5);
  });

  it('withTimeout throws DeadlineError for a hung promise', async () => {
    vi.useFakeTimers();
    try {
      const hung = new Promise<never>(() => undefined);
      const p = withTimeout(hung, 5000, 'messages.GetHistory');
      const assertion = expect(p).rejects.toBeInstanceOf(DeadlineError);
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

});
