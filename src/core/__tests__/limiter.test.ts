import { RPCMessageToError } from 'teleproto/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayError } from '../errors.js';
import { AccountLimiter } from '../limiter.js';
import { createLogger } from '../log.js';
import { createFatalHandler } from '../recovery.js';

const silent = createLogger('test', { level: 'silent' });

function makeLimiter(overrides: Partial<ConstructorParameters<typeof AccountLimiter>[0]> = {}) {
  const onFatal = vi.fn();
  const limiter = new AccountLimiter({ onFatal, log: silent, ...overrides });
  return { limiter, onFatal };
}

function floodError(seconds: number): Error {
  return Object.assign(new Error(`A wait of ${seconds} seconds is required`), {
    seconds,
    errorMessage: `FLOOD_WAIT_${seconds}`,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AccountLimiter: lane and pauses', () => {
  it('serializes account calls with spacing between them', async () => {
    const { limiter } = makeLimiter({ minIntervalMs: 500 });
    const starts: number[] = [];
    let active = 0;
    let maxActive = 0;
    const op = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      starts.push(Date.now());
      await new Promise(r => setTimeout(r, 100));
      active--;
      return starts.length;
    };

    const all = Promise.all([1, 2, 3].map(() => limiter.run('a', op, { label: 'op' })));
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(all).resolves.toEqual([1, 2, 3]);
    expect(maxActive).toBe(1);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(500);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(500);
  });

  it('does not block unrelated accounts', async () => {
    const { limiter } = makeLimiter();
    const order: string[] = [];
    const slow = limiter.run('a', async () => {
      await new Promise(r => setTimeout(r, 5_000));
      order.push('a');
    }, { label: 'slow' });
    const fast = limiter.run('b', async () => {
      order.push('b');
    }, { label: 'fast' });
    await vi.advanceTimersByTimeAsync(10);
    await fast;
    expect(order).toEqual(['b']);
    await vi.advanceTimersByTimeAsync(5_000);
    await slow;
    expect(order).toEqual(['b', 'a']);
  });

  it('prioritizes agent calls over queued background work', async () => {
    const { limiter } = makeLimiter({ minIntervalMs: 0 });
    const order: string[] = [];
    const mk = (name: string) => async () => {
      order.push(name);
      await new Promise(r => setTimeout(r, 10));
    };
    const p = [
      limiter.run('a', mk('bg1'), { label: 'bg1', priority: 'background' }),
      limiter.run('a', mk('bg2'), { label: 'bg2', priority: 'background' }),
      limiter.run('a', mk('bg3'), { label: 'bg3', priority: 'background' }),
      limiter.run('a', mk('agent1'), { label: 'agent1' }),
      limiter.run('a', mk('agent2'), { label: 'agent2' }),
    ];
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all(p);
    // bg1 was already running; the rest reorder: agent first, then background.
    expect(order).toEqual(['bg1', 'agent1', 'agent2', 'bg2', 'bg3']);
  });

  it('enforces calls per minute', async () => {
    const { limiter } = makeLimiter({ minIntervalMs: 0, perMinute: 3, interactiveWaitBudgetMs: 120_000 });
    const times: number[] = [];
    const p = Promise.all(
      [1, 2, 3, 4].map(() => limiter.run('a', async () => void times.push(Date.now()), { label: 'op' })),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(times).toHaveLength(3);
    expect(limiter.status('a').callsInWindow).toBe(3);
    await vi.advanceTimersByTimeAsync(60_000);
    await p;
    expect(times).toHaveLength(4);
    expect(times[3]! - times[0]!).toBeGreaterThanOrEqual(60_000);
  });
});

describe('AccountLimiter: FLOOD_WAIT', () => {
  it('waits through a short pause and retries', async () => {
    const { limiter } = makeLimiter();
    let calls = 0;
    const p = limiter.run('a', async () => {
      calls++;
      if (calls === 1) throw floodError(5);
      return 'ok';
    }, { label: 'messages.Search' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(1);
    expect(limiter.status('a').floodWaitSeconds).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(p).resolves.toBe('ok');
    expect(calls).toBe(2);
  });

  it('retries a nested authentication FLOOD_WAIT under its owner instead of the blocked lane queue', async () => {
    const { limiter, onFatal } = makeLimiter({ minIntervalMs: 0, maxFloodRetries: 2 });
    const auth = { authentication: true, write: true };
    let nested = 0;
    const outer = limiter.run('a', () => limiter.run('a', async () => {
      if (++nested === 1) throw floodError(2);
      return 'config';
    }, { label: 'help.GetConfig', ...auth }), { label: 'auth.SendCode', ...auth });
    const unrelated = limiter.run('a', async () => 'unrelated', { label: 'unrelated' });
    // Re-entering the lane queue would wait behind its own parent until its budget expires.
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(outer).resolves.toBe('config');
    await expect(unrelated).resolves.toBe('unrelated');
    expect(nested).toBe(2);
    expect(onFatal).not.toHaveBeenCalled();
    expect(limiter.status('a').queued).toBe(0);
  });

  it('rejects a nested authentication FLOOD_WAIT beyond its retries without stalling the owner', async () => {
    const { limiter, onFatal } = makeLimiter({ minIntervalMs: 0, maxFloodRetries: 1 });
    const auth = { authentication: true, write: true };
    const nested = vi.fn(async () => { throw floodError(2); });
    const outer = limiter.run('a', () => limiter.run('a', nested, { label: 'help.GetConfig', ...auth }), { label: 'auth.SendCode', ...auth });
    const rejected = expect(outer).rejects.toMatchObject({ code: 'FLOOD_WAIT', retryAfter: 2 });
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(nested).toHaveBeenCalledTimes(2);
    expect(onFatal).not.toHaveBeenCalled();
  });

  it('returns retry_after without waiting beyond the budget', async () => {
    const { limiter } = makeLimiter({ interactiveWaitBudgetMs: 15_000 });
    const p = limiter.run('a', async () => {
      throw floodError(120);
    }, { label: 'contacts.ResolveUsername' });
    const assertion = expect(p).rejects.toMatchObject({ code: 'FLOOD_WAIT', retryAfter: 120 });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });

  it('immediately rejects another agent call while the account is paused', async () => {
    const { limiter } = makeLimiter();
    const first = limiter.run('a', async () => {
      throw floodError(200);
    }, { label: 'first' });
    first.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);

    const op = vi.fn(async () => 'never');
    await expect(limiter.run('a', op, { label: 'second' })).rejects.toMatchObject({ code: 'FLOOD_WAIT' });
    expect(op).not.toHaveBeenCalled();
    const err = (await limiter.run('a', op, { label: 'third' }).catch((e: unknown) => e)) as GatewayError;
    expect(err.retryAfter).toBeGreaterThan(190);
    expect(err.retryAfter).toBeLessThanOrEqual(200);
  });

  it('background work waits up to the pause limit, then skips', async () => {
    const { limiter } = makeLimiter({ floodCapSeconds: 300 });
    let calls = 0;
    const waited = limiter.run('a', async () => {
      calls++;
      if (calls === 1) throw floodError(120);
      return 'done';
    }, { label: 'bg', priority: 'background' });
    await vi.advanceTimersByTimeAsync(121_000);
    await expect(waited).resolves.toBe('done');

    const skipped = limiter.run('b', async () => {
      throw floodError(301);
    }, { label: 'bg-long', priority: 'background' });
    const assertion = expect(skipped).rejects.toMatchObject({ code: 'FLOOD_WAIT', retryAfter: 301 });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });

  it('uses the default pause for FLOOD_WAIT without seconds', async () => {
    const { limiter } = makeLimiter({ unknownFloodSeconds: 30, interactiveWaitBudgetMs: 1_000 });
    const p = limiter.run('a', async () => {
      throw new Error('FLOOD_WAIT');
    }, { label: 'op' });
    const assertion = expect(p).rejects.toMatchObject({ code: 'FLOOD_WAIT', retryAfter: 30 });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });

  it('does not apply one account pause to another', async () => {
    const { limiter } = makeLimiter({ interactiveWaitBudgetMs: 1_000 });
    const paused = limiter.run('a', async () => {
      throw floodError(100);
    }, { label: 'op' });
    const assertion = expect(paused).rejects.toMatchObject({ code: 'FLOOD_WAIT', retryAfter: 100 });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(limiter.status('a').floodWaitSeconds).toBeGreaterThan(0);
    expect(limiter.status('b').floodWaitSeconds).toBe(0);
    await expect(limiter.run('b', async () => 'ok', { label: 'op' })).resolves.toBe('ok');
  });
});

describe('AccountLimiter: real teleproto errors', () => {
  const real = (message: string, method: string): Error =>
    RPCMessageToError({ errorCode: 420, errorMessage: message } as never, { className: method } as never) as Error;

  it('waits through a short teleproto FLOOD_WAIT and retries', async () => {
    const { limiter } = makeLimiter();
    let calls = 0;
    const p = limiter.run('a', async () => {
      calls++;
      if (calls === 1) throw real('FLOOD_WAIT_5', 'messages.GetHistory');
      return 'ok';
    }, { label: 'messages.GetHistory' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(limiter.status('a').floodWaitSeconds).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(p).resolves.toBe('ok');
    expect(calls).toBe(2);
  });

  it('a long pause blocks only the affected method', async () => {
    const { limiter } = makeLimiter({ floodCapSeconds: 300 });
    const first = limiter.run('a', async () => {
      throw real('FLOOD_WAIT_3600', 'contacts.ResolveUsername');
    }, { label: 'contacts.ResolveUsername' });
    const rejected = expect(first).rejects.toMatchObject({ code: 'FLOOD_WAIT', retryAfter: 3600 });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;

    const op = vi.fn(async () => 'never');
    const again = (await limiter.run('a', op, { label: 'contacts.ResolveUsername' }).catch((e: unknown) => e)) as GatewayError;
    expect(again.code).toBe('FLOOD_WAIT');
    expect(again.message).toContain('Other kinds of requests still work');
    expect(op).not.toHaveBeenCalled();

    const other = limiter.run('a', async () => 'history', { label: 'messages.GetHistory' });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(other).resolves.toBe('history');

    const status = limiter.status('a');
    expect(status.floodWaitSeconds).toBe(0);
    expect(status.pausedMethods).toHaveLength(1);
    expect(status.pausedMethods[0]).toMatchObject({ label: 'contacts.ResolveUsername' });

    await vi.advanceTimersByTimeAsync(3_600_000);
    await expect(limiter.run('a', async () => 'resolved', { label: 'contacts.ResolveUsername' })).resolves.toBe('resolved');
    expect(limiter.status('a').pausedMethods).toEqual([]);
  });

  it('chat slow mode neither pauses the account nor retries', async () => {
    const { limiter } = makeLimiter();
    const op = vi.fn(async () => {
      throw real('SLOWMODE_WAIT_30', 'messages.SendMessage');
    });
    const p = limiter.run('a', op, { label: 'messages.SendMessage', write: true });
    const rejected = expect(p).rejects.toMatchObject({ code: 'FLOOD_WAIT', retryAfter: 30 });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(op).toHaveBeenCalledTimes(1);
    expect(limiter.status('a').floodWaitSeconds).toBe(0);
    const other = limiter.run('a', async () => 'ok', { label: 'messages.GetHistory' });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(other).resolves.toBe('ok');
  });
});

describe('AccountLimiter: deadlines and hangs', () => {
  it('a hung call returns TIMEOUT and shuts down every lane before restart', async () => {
    const { limiter, onFatal } = makeLimiter({ defaultDeadlineMs: 20_000 });
    const hung = limiter.run('a', () => new Promise<never>(() => undefined), { label: 'messages.GetHistory' });
    const hungAssertion = expect(hung).rejects.toMatchObject({ code: 'TIMEOUT', outcomeUnknown: false });
    const nextOp = vi.fn(async () => 'after');
    const next = expect(limiter.run('a', nextOp, { label: 'next', waitBudgetMs: 60_000 })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(20_001);
    await hungAssertion;
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0]![0]).toContain('messages.GetHistory');
    await vi.advanceTimersByTimeAsync(1_000);
    await next;
    expect(nextOp).not.toHaveBeenCalled();
    await expect(limiter.run('b', nextOp, { label: 'other account' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('a write timeout reports an unknown outcome', async () => {
    const { limiter } = makeLimiter();
    const p = limiter.run('a', () => new Promise<never>(() => undefined), { label: 'messages.SendMessage', write: true, deadlineMs: 1_000 });
    const assertion = expect(p).rejects.toMatchObject({ code: 'TIMEOUT', outcomeUnknown: true });
    await vi.advanceTimersByTimeAsync(1_001);
    await assertion;
  });

  it('a call exceeding its queue budget fails independently', async () => {
    const { limiter } = makeLimiter({ interactiveWaitBudgetMs: 2_000 });
    const long = limiter.run('a', () => new Promise(r => setTimeout(() => r('long'), 10_000)), { label: 'long' });
    const op = vi.fn(async () => 'queued');
    const queued = limiter.run('a', op, { label: 'queued' });
    const assertion = expect(queued).rejects.toMatchObject({ code: 'FLOOD_WAIT' });
    await vi.advanceTimersByTimeAsync(2_100);
    await assertion;
    expect(op).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(long).resolves.toBe('long');
  });

  it('classifies Telegram errors', async () => {
    const { limiter } = makeLimiter();
    await expect(
      limiter.run('a', async () => {
        throw new Error('CHANNEL_PRIVATE');
      }, { label: 'op' }),
    ).rejects.toMatchObject({ code: 'CHAT_PRIVATE' });
  });

  it('shutdown rejects queued and new calls', async () => {
    const { limiter } = makeLimiter();
    const running = limiter.run('a', () => new Promise(r => setTimeout(() => r('x'), 1_000)), { label: 'running' });
    const queued = limiter.run('a', async () => 'y', { label: 'queued' });
    const assertion = expect(queued).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    limiter.shutdown();
    await assertion;
    await expect(limiter.run('a', async () => 'z', { label: 'late' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(running).resolves.toBe('x');
  });
});

describe('recovery', () => {
  it('the fatal handler exits once with code 1', () => {
    const exit = vi.fn();
    const beforeExit = vi.fn();
    const fatal = createFatalHandler({ exit, beforeExit, log: silent });
    fatal('hung call');
    fatal('second');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(beforeExit).toHaveBeenCalledTimes(1);
  });

  it('waiting calls receive errors and can record them before exit', async () => {
    const exit = vi.fn();
    const order: string[] = [];
    const fatal = createFatalHandler({ exit, log: silent, graceMs: 300, prepare: () => order.push('prepare'), beforeExit: () => order.push('beforeExit') });
    fatal('hung call');
    expect(order).toEqual(['prepare']);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(order).toEqual(['prepare', 'beforeExit']);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
