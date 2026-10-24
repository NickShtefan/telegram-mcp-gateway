/**
 * Telegram login: QR or phone/code, with 2FA when required. Invoked only through
 * `tg-mcp login`, never tools: the agent cannot see the verification code.
 *
 * Login always uses a fresh client with an empty session and a string phone number.
 * Do not call `connect()` before `start()`: teleproto must handle DC migration itself.
 */
import type { ClientFactory, AccountIdentity } from './clientPool.js';
import { classifyError, GatewayError } from './errors.js';
import type { Logger } from './log.js';
import { withTimeout } from './time.js';
import { AccountLimiter } from './limiter.js';
import { queueLoginCalls } from './tg.js';

export interface LoginPrompts {
  code(): Promise<string>;
  /** Two-factor password; hint is the owner-configured password hint. */
  password(hint?: string): Promise<string>;
}

export interface LoginOptions {
  factory: ClientFactory;
  apiId: number;
  apiHash: string;
  phone?: string;
  /** Human-only QR display. A fresh token replaces the previous code. */
  qrCode?: (code: { token: Buffer; expires: number }) => Promise<void>;
  signal?: AbortSignal;
  prompts: LoginPrompts;
  log: Logger;
  /** Time allowed for a human to enter a code or password. */
  inputTimeoutMs?: number;
  /** Maximum invalid code/password attempts before aborting login. */
  maxAttempts?: number;
  accountId?: string;
  /** A hung auth call or cleanup must terminate the worker, never release its lease in process. */
  onFatal?: () => never;
  /**
   * Store the authorized result before the login client is closed. A failed or
   * hung close terminates the process, which would otherwise lose the session
   * and leave Telegram with an orphan authorization. Errors propagate unchanged.
   */
  persist?: (result: LoginResult) => Promise<void> | void;
  cleanupTimeoutMs?: number;
  connectTimeoutMs?: number;
}

export interface LoginResult {
  /** Session string: never log it; encrypt and store it. */
  session: string;
  identity: AccountIdentity;
}

interface MeLike {
  id?: unknown;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  const phone = digits.startsWith('+') ? digits : `+${digits}`;
  if (!/^\+\d{7,15}$/.test(phone)) {
    throw new GatewayError('INVALID_ARGUMENT', 'Phone number must be in international format, for example +79991234567.');
  }
  return phone;
}

export async function loginAccount(options: LoginOptions): Promise<LoginResult> {
  const inputTimeoutMs = options.inputTimeoutMs ?? 5 * 60_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const phone = options.qrCode ? undefined : normalizePhone(options.phone ?? '');
  const client = options.factory({ session: '', apiId: options.apiId, apiHash: options.apiHash, log: options.log });
  const fatal = options.onFatal ?? (() => process.exit(1));
  const limiter = new AccountLimiter({ onFatal: () => fatal(), log: options.log, maxFloodRetries: 0 });
  const restore = queueLoginCalls(client, options.accountId ?? 'login', limiter, fatal, options.connectTimeoutMs);

  let persisting = false;
  let errors = 0;
  let lastError: Error | null = null;
  // Input canceled (Ctrl-C, timeout): teleproto swallows this error and asks again.
  let aborted: Error | null = null;
  const ask = async (label: string, prompt: () => Promise<string>): Promise<string> => {
    try {
      return await withTimeout(prompt(), inputTimeoutMs, label);
    } catch (err) {
      aborted = err instanceof GatewayError ? err : new GatewayError('UNAVAILABLE', `Login cancelled: ${(err as Error).message}`);
      throw aborted;
    }
  };

  try {
    const password = (hint?: string): Promise<string> => ask('2FA password input', () => options.prompts.password(hint));
    const onError = async (err: Error): Promise<boolean> => {
      errors++;
      lastError = aborted ?? err;
      options.log.warn('login step failed', { error: lastError.message, attempt: errors });
      return aborted !== null || classifyError(err).code === 'FLOOD_WAIT' || errors >= maxAttempts;
    };
    if (options.qrCode) {
      const signal = AbortSignal.any([AbortSignal.timeout(inputTimeoutMs), ...(options.signal ? [options.signal] : [])]);
      await client.connect();
      await client.signInUserWithQrCode({ apiId: options.apiId, apiHash: options.apiHash }, {
        qrCode: options.qrCode, password, onError, abortSignal: signal,
      });
    } else await client.start({
      phoneNumber: phone!,
      // Codes are digits: drop pasted spaces/newlines; passwords stay verbatim.
      phoneCode: async () => (await ask('phone code input', () => options.prompts.code())).replace(/\s/g, ''),
      password,
      // Without this, teleproto silently signs up unregistered numbers and accepts Telegram terms.
      firstAndLastNames: async () => {
        aborted = new GatewayError('INVALID_ARGUMENT', 'This phone number has no Telegram account. The gateway does not register new accounts.');
        throw aborted;
      },
      onError,
    });

    if (aborted) throw aborted;

    const me = (await client.getMe()) as MeLike | null;
    if (!me || me.id === undefined || me.id === null) {
      throw lastError ?? new GatewayError('ACCOUNT_UNAUTHORIZED', 'Login did not complete: Telegram did not authorize the session.');
    }

    const session = String(client.session.save() ?? '');
    if (!session) {
      throw new GatewayError('ACCOUNT_UNAUTHORIZED', 'Login completed, but the session is empty.');
    }

    const result: LoginResult = {
      session,
      identity: {
        tgUserId: String(me.id),
        username: me.username ?? null,
        displayName: [me.firstName, me.lastName].filter(Boolean).join(' ').trim() || null,
      },
    };
    persisting = true;
    await options.persist?.(result);
    return result;
  } catch (err) {
    throw persisting ? err : classifyError(aborted ?? lastError ?? err);
  } finally {
    // Always close the login client; the daemon opens its own client with the session.
    // A client that may still be live shares the new auth key: terminate, never continue.
    let closed = false;
    try {
      await withTimeout(client.destroy(), options.cleanupTimeoutMs ?? 5_000, 'client.destroy');
      closed = true;
    } catch { /* terminate below */ } finally { limiter.shutdown(); restore(); }
    if (!closed) fatal();
  }
}
