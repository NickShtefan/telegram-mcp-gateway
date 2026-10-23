/**
 * MTProto call limiter. Every Telegram call goes through it.
 *
 * - one queue/lane per account session: 60 requests/minute and 500 ms
 *   between calls;
 * - deadline INSIDE the lane: a hung call shuts down all lanes when time expires,
 *   and the process exits on a hang;
 * - account pause on FLOOD_WAIT, retries within the limit;
 * - wait budget: when the pause exceeds what the caller can wait,
 *   return retry_after immediately rather than hanging;
 * - agent calls take priority over background export/index jobs.
 */
import { classifyError, floodInfo, GatewayError } from './errors.js';
import { createLogger, type Logger } from './log.js';
import { DeadlineError, MAX_TIMER_MS, withTimeout } from './time.js';
import { AsyncLocalStorage } from 'node:async_hooks';

export type Priority = 'interactive' | 'background';

export interface LimiterOptions {
  /** Minimum spacing between calls on the same account. */
  minIntervalMs?: number;
  /** Calls per account per minute. */
  perMinute?: number;
  /** Nobody waits through FLOOD_WAIT above this limit, including background jobs. */
  floodCapSeconds?: number;
  maxFloodRetries?: number;
  /** Default call deadline when options do not specify one. */
  defaultDeadlineMs?: number;
  /** Agent call budget for waiting on the queue and pauses before starting. */
  interactiveWaitBudgetMs?: number;
  /** Default pause seconds when FLOOD_WAIT carries no number. */
  unknownFloodSeconds?: number;
  /** Hung call requires process exit (see core/recovery.ts). */
  onFatal: (reason: string) => void;
  log?: Logger;
  now?: () => number;
}

export interface CallOptions {
  /** Private library authentication only: preserve control exceptions and nested lane ownership. */
  authentication?: boolean;
  /** Call name for logs/errors, e.g. `messages.GetHistory`. */
  label: string;
  priority?: Priority;
  deadlineMs?: number;
  waitBudgetMs?: number;
  /** The call mutates Telegram state; timeout means an unknown outcome. */
  write?: boolean;
}

export interface LaneStatus {
  queued: number;
  callsInWindow: number;
  perMinute: number;
  /** Remaining account FLOOD_WAIT seconds; 0 if not paused. */
  floodWaitSeconds: number;
  /** Long method-specific pauses; other account methods remain available. */
  pausedMethods: Array<{ label: string; seconds: number }>;
}

interface Item {
  authentication: boolean;
  op: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  label: string;
  priority: Priority;
  deadlineMs: number;
  /** Latest time at which the call may start. */
  startBy: number;
  write: boolean;
  retries: number;
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

interface Lane {
  queue: Item[];
  running: boolean;
  lastCallAt: number;
  windowStart: number;
  windowCount: number;
  floodWaitUntil: number;
  /** Long method pauses: method name -> end time. */
  methodPausedUntil: Map<string, number>;
  /** Wake the lane loop for new work or shutdown. */
  wake: (() => void) | null;
}

const WINDOW_MS = 60_000;

export class AccountLimiter {
  private readonly context = new AsyncLocalStorage<{ accountId: string; lane: Lane; active: boolean; authentication: boolean; tail: Promise<void> }>();
  private readonly lanes = new Map<string, Lane>();
  private readonly minIntervalMs: number;
  private readonly perMinute: number;
  private readonly floodCapSeconds: number;
  private readonly maxFloodRetries: number;
  private readonly defaultDeadlineMs: number;
  private readonly interactiveWaitBudgetMs: number;
  private readonly unknownFloodSeconds: number;
  private readonly onFatal: (reason: string) => void;
  private readonly log: Logger;
  private readonly now: () => number;
  private stopped = false;

  constructor(options: LimiterOptions) {
    this.minIntervalMs = options.minIntervalMs ?? 500;
    this.perMinute = options.perMinute ?? 60;
    this.floodCapSeconds = options.floodCapSeconds ?? 300;
    this.maxFloodRetries = options.maxFloodRetries ?? 3;
    this.defaultDeadlineMs = options.defaultDeadlineMs ?? 20_000;
    this.interactiveWaitBudgetMs = options.interactiveWaitBudgetMs ?? 15_000;
    this.unknownFloodSeconds = options.unknownFloodSeconds ?? 30;
    this.onFatal = options.onFatal;
    this.log = options.log ?? createLogger('limiter');
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Run op in the account lane: sequentially, with spacing, deadline, and
   * FLOOD_WAIT handling. Reject only with GatewayError.
   */
  run<T>(accountId: string, op: () => Promise<T>, options: CallOptions): Promise<T> {
    if (this.stopped) {
      return Promise.reject(new GatewayError('UNAVAILABLE', 'The gateway is shutting down.'));
    }
    const lane = this.lane(accountId);
    const priority = options.priority ?? 'interactive';
    const budget =
      options.waitBudgetMs ??
      (priority === 'interactive' ? this.interactiveWaitBudgetMs : this.floodCapSeconds * 1000 + WINDOW_MS);
    const now = this.now();

    return new Promise<T>((resolve, reject) => {
      const item: Item = {
        authentication: options.authentication ?? false,
        op,
        resolve: resolve as (value: unknown) => void,
        reject,
        label: options.label,
        priority,
        deadlineMs: options.deadlineMs ?? this.defaultDeadlineMs,
        startBy: now + budget,
        write: options.write ?? false,
        retries: 0,
        expiryTimer: null,
      };

      // This method has a long pause; reject immediately without affecting other methods.
      const methodLeft = (lane.methodPausedUntil.get(options.label) ?? 0) - now;
      if (methodLeft > 0) {
        reject(this.pausedError(methodLeft, options.label));
        return;
      }

      // The pause already exceeds the budget; reject without occupying the queue.
      const floodLeft = lane.floodWaitUntil - now;
      if (floodLeft > budget) {
        reject(this.pausedError(floodLeft));
        return;
      }

      const parent = this.context.getStore();
      if (item.authentication && parent?.authentication && parent.active && parent.accountId === accountId && parent.lane === lane) {
        // teleproto DC migration invokes authorization/config RPCs while its
        // outer RPC still owns this lane. Serialize siblings under that owner;
        // descendants get their own context, avoiding a wait behind themselves.
        // A FLOOD_WAIT retry also stays here: the lane queue is blocked behind the parent.
        const work = parent.tail.then(async () => {
          for (let retry = true; retry;) {
            retry = false;
            if (this.stopped || !parent.active) { item.reject(new GatewayError('UNAVAILABLE', 'Authentication operation ended.')); return; }
            let wait: number;
            while (!this.stopped && parent.active && (wait = this.requiredWait(lane, this.now())) > 0) {
              if (wait > item.startBy - this.now()) { item.reject(this.waitTooLongError(lane)); return; }
              await this.interruptibleSleep(lane, wait);
            }
            if (this.stopped || !parent.active) { item.reject(new GatewayError('UNAVAILABLE', 'Authentication operation ended.')); return; }
            await this.execute(accountId, lane, item, () => { retry = true; });
          }
        });
        parent.tail = work.catch(() => undefined);
      } else this.enqueue(accountId, lane, item);
    });
  }

  status(accountId: string): LaneStatus {
    const lane = this.lanes.get(accountId);
    const now = this.now();
    if (!lane) {
      return { queued: 0, callsInWindow: 0, perMinute: this.perMinute, floodWaitSeconds: 0, pausedMethods: [] };
    }
    const pausedMethods: Array<{ label: string; seconds: number }> = [];
    for (const [label, until] of lane.methodPausedUntil) {
      if (until > now) pausedMethods.push({ label, seconds: Math.ceil((until - now) / 1000) });
      else lane.methodPausedUntil.delete(label);
    }
    return {
      queued: lane.queue.length,
      callsInWindow: this.windowCount(lane, now),
      perMinute: this.perMinute,
      floodWaitSeconds: Math.max(0, Math.ceil((lane.floodWaitUntil - now) / 1000)),
      pausedMethods,
    };
  }

  /** Stop accepting calls and reject all queued work. */
  shutdown(): void {
    this.stopped = true;
    for (const lane of this.lanes.values()) {
      for (const item of lane.queue.splice(0)) {
        this.clearExpiry(item);
        item.reject(new GatewayError('UNAVAILABLE', 'The gateway is shutting down.'));
      }
      lane.wake?.();
    }
  }

  // ---------- internals ----------

  private lane(accountId: string): Lane {
    let lane = this.lanes.get(accountId);
    if (!lane) {
      lane = { queue: [], running: false, lastCallAt: 0, windowStart: this.now(), windowCount: 0, floodWaitUntil: 0, methodPausedUntil: new Map(), wake: null };
      this.lanes.set(accountId, lane);
    }
    return lane;
  }

  private enqueue(accountId: string, lane: Lane, item: Item, front = false): void {
    if (front) {
      lane.queue.unshift(item);
    } else if (item.priority === 'interactive') {
      // Agent calls precede background work, but preserve agent FIFO order.
      const firstBackground = lane.queue.findIndex(q => q.priority === 'background');
      if (firstBackground === -1) lane.queue.push(item);
      else lane.queue.splice(firstBackground, 0, item);
    } else {
      lane.queue.push(item);
    }

    this.armExpiry(lane, item);

    if (lane.running) {
      lane.wake?.();
    } else {
      void this.drain(accountId, lane);
    }
  }

  /** Reject a call exceeding its start budget independently of the queue. */
  private armExpiry(lane: Lane, item: Item): void {
    this.clearExpiry(item);
    const ms = Math.max(0, item.startBy - this.now());
    if (ms >= MAX_TIMER_MS) return;
    item.expiryTimer = setTimeout(() => {
      const index = lane.queue.indexOf(item);
      if (index === -1) return;
      lane.queue.splice(index, 1);
      item.reject(this.waitTooLongError(lane));
    }, ms + 1);
    if (typeof item.expiryTimer.unref === 'function') item.expiryTimer.unref();
  }

  private clearExpiry(item: Item): void {
    if (item.expiryTimer) {
      clearTimeout(item.expiryTimer);
      item.expiryTimer = null;
    }
  }

  private async drain(accountId: string, lane: Lane): Promise<void> {
    lane.running = true;
    try {
      while (!this.stopped) {
        const item = lane.queue[0];
        if (!item) break;

        const now = this.now();
        const waitMs = this.requiredWait(lane, now);
        const budgetLeft = item.startBy - now;

        if (waitMs > budgetLeft) {
          lane.queue.shift();
          this.clearExpiry(item);
          item.reject(this.waitTooLongError(lane));
          continue;
        }

        if (waitMs > 0) {
          // Sleep only as long as needed. New work wakes the loop and
          // reselects the queue head (an agent call may now precede background work).
          await this.interruptibleSleep(lane, waitMs);
          continue;
        }

        lane.queue.shift();
        this.clearExpiry(item);
        await this.execute(accountId, lane, item);
      }
    } finally {
      lane.running = false;
      lane.wake = null;
    }
  }

  private requiredWait(lane: Lane, now: number): number {
    let wait = 0;
    if (lane.floodWaitUntil > now) wait = Math.max(wait, lane.floodWaitUntil - now);
    const sinceLast = now - lane.lastCallAt;
    if (lane.lastCallAt > 0 && sinceLast < this.minIntervalMs) wait = Math.max(wait, this.minIntervalMs - sinceLast);
    if (this.windowCount(lane, now) >= this.perMinute) wait = Math.max(wait, lane.windowStart + WINDOW_MS - now);
    return wait;
  }

  private windowCount(lane: Lane, now: number): number {
    if (now - lane.windowStart >= WINDOW_MS) {
      lane.windowStart = now;
      lane.windowCount = 0;
    }
    return lane.windowCount;
  }

  private interruptibleSleep(lane: Lane, ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        lane.wake = null;
        resolve();
      }, Math.min(ms, MAX_TIMER_MS));
      lane.wake = () => {
        clearTimeout(timer);
        lane.wake = null;
        resolve();
      };
    });
  }

  private async execute(accountId: string, lane: Lane, item: Item, retry = (): void => this.enqueue(accountId, lane, item, true)): Promise<void> {
    const startedAt = this.now();
    this.windowCount(lane, startedAt);
    lane.windowCount++;
    lane.lastCallAt = startedAt;

    try {
      // Deadline inside the lane: a hung call releases the lane on timeout.
      const owner = { accountId, lane, active: true, authentication: item.authentication, tail: Promise.resolve() };
      let result: unknown;
      try { result = await withTimeout(this.context.run(owner, item.op), item.deadlineMs, item.label); }
      finally { owner.active = false; }
      item.resolve(result);
    } catch (err) {
      if (err instanceof DeadlineError) {
        this.log.error('call timed out', { account: accountId, label: item.label, deadlineMs: item.deadlineMs });
        item.reject(classifyError(err, { write: item.write }));
        // The original promise is still running. No lane may start more work.
        this.shutdown();
        this.onFatal(`${item.label} did not return in ${item.deadlineMs}ms (account ${accountId})`);
        return;
      }

      const flood = floodInfo(err);
      if (flood !== null) {
        const seconds = flood.seconds > 0 ? flood.seconds : this.unknownFloodSeconds;
        const now = this.now();
        this.log.warn('FLOOD_WAIT', { account: accountId, label: item.label, seconds, scope: flood.scope });

        // One chat's slow mode does not pause the account or warrant a retry.
        if (flood.scope === 'chat') {
          item.reject(classifyError(err, { write: item.write }));
          return;
        }
        // A long pause belongs to one method (e.g. a day for ResolveUsername);
        // other account calls continue, while that method rejects until the pause ends.
        if (seconds > this.floodCapSeconds) {
          lane.methodPausedUntil.set(item.label, now + seconds * 1000);
          item.reject(
            new GatewayError('FLOOD_WAIT', `Telegram rate limit for ${item.label}: wait ${seconds} seconds. Do NOT retry before retry_after. Other kinds of requests still work.`, {
              retryAfter: seconds,
              cause: err,
            }),
          );
          return;
        }
        lane.floodWaitUntil = Math.max(lane.floodWaitUntil, now + seconds * 1000);

        const fitsBudget = seconds * 1000 <= item.startBy - now;
        if (seconds <= this.floodCapSeconds && fitsBudget && item.retries < this.maxFloodRetries) {
          // FLOOD_WAIT means the request was not executed; retry is safe even for writes.
          item.retries++;
          retry();
          return;
        }
        item.reject(
          new GatewayError('FLOOD_WAIT', `Telegram rate limit: wait ${seconds} seconds. Do NOT retry before retry_after.`, {
            retryAfter: seconds,
            cause: err,
          }),
        );
        return;
      }

      // Authentication's library state machine needs the original RPC error
      // (notably errorMessage=SESSION_PASSWORD_NEEDED). Public calls still use
      // gateway classification; flood/deadline policy above is never bypassed.
      item.reject(item.authentication && err instanceof Error ? err : classifyError(err, { write: item.write }));
    }
  }

  private pausedError(floodLeftMs: number, label?: string): GatewayError {
    const seconds = Math.ceil(floodLeftMs / 1000);
    return new GatewayError(
      'FLOOD_WAIT',
      label
        ? `Telegram rate limit for ${label}: ${seconds} more seconds. Do NOT retry before retry_after. Other kinds of requests still work.`
        : `This account is paused by a Telegram rate limit for ${seconds} more seconds. Do NOT retry before retry_after.`,
      { retryAfter: seconds },
    );
  }

  private waitTooLongError(lane: Lane): GatewayError {
    const now = this.now();
    const floodLeft = lane.floodWaitUntil - now;
    if (floodLeft > 0) return this.pausedError(floodLeft);
    const retryAfter = Math.max(1, Math.ceil(this.requiredWait(lane, now) / 1000));
    return new GatewayError(
      'FLOOD_WAIT',
      `The gateway queue for this account is busy (own rate limit of ${this.perMinute} calls per minute). Retry after retry_after seconds.`,
      { retryAfter },
    );
  }
}
