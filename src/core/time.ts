/**
 * Deadlines and delays. teleproto promises may never settle after a network
 * failure, so every external await must be time-bounded.
 */

export class DeadlineError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'DeadlineError';
  }
}

/** Node silently reduces setTimeout values above 2^31-1 to 1 ms. */
export const MAX_TIMER_MS = 2_147_483_647;

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const ms = Math.min(Math.max(0, timeoutMs), MAX_TIMER_MS);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(label, timeoutMs)), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.min(Math.max(0, ms), MAX_TIMER_MS)));
}
