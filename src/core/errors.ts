/**
 * Gateway errors. Telegram errors become GatewayError with a code
 * and an agent-readable explanation of what happened and what to do.
 */
import { DeadlineError } from './time.js';

export type GatewayErrorCode =
  | 'FLOOD_WAIT'
  | 'TIMEOUT'
  | 'CHAT_PRIVATE'
  | 'CHAT_NOT_FOUND'
  | 'MESSAGE_NOT_FOUND'
  | 'COMMENTS_UNAVAILABLE'
  | 'INVITE_INVALID'
  | 'JOIN_REQUIRED'
  | 'WRITE_FORBIDDEN'
  | 'PEER_FLOOD'
  | 'PAYMENT_REQUIRED'
  | 'ACCOUNT_UNAUTHORIZED'
  | 'ACCOUNT_FROZEN'
  | 'ACCESS_DENIED'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'LIMIT_REACHED'
  | 'UNAVAILABLE'
  | 'TELEGRAM_ERROR';

export interface GatewayErrorOptions {
  retryAfter?: number;
  /** A write may have been applied; the outcome is unknown. */
  outcomeUnknown?: boolean;
  /** Original Telegram error code, e.g. CHANNEL_PRIVATE. */
  telegramCode?: string;
  cause?: unknown;
}

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly retryAfter?: number;
  readonly outcomeUnknown: boolean;
  readonly telegramCode?: string;

  constructor(code: GatewayErrorCode, message: string, options: GatewayErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'GatewayError';
    this.code = code;
    this.retryAfter = options.retryAfter;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
    this.telegramCode = options.telegramCode;
  }
}

interface TelegramErrorLike {
  seconds?: number;
  message?: string;
  errorMessage?: string;
}

function errorText(err: unknown): string {
  const e = err as TelegramErrorLike | null;
  if (!e || typeof e !== 'object') return typeof err === 'string' ? err : '';
  const parts = [e.errorMessage, e.message].filter((p): p is string => typeof p === 'string' && p.length > 0);
  return parts.join(' ');
}

export interface FloodInfo {
  /** Wait seconds; 0 if the wait type is known but seconds cannot be parsed. */
  seconds: number;
  /**
   * account: account/method limit; chat: slow mode affecting one chat,
   * without pausing the account's other calls.
   */
  scope: 'account' | 'chat';
}

const SLOWMODE_TEXT = /A wait of (\d+) seconds is required before sending another message in this chat/;
const WAIT_TEXT = /A wait of (\d+) seconds is required/;
const WAIT_CODE = /(?:FLOOD_PREMIUM_WAIT|FLOOD_TEST_PHONE_WAIT|FLOOD_WAIT)[_ ]?(\d+)/;
const SLOWMODE_CODE = /SLOWMODE_WAIT[_ ]?(\d+)/;

/**
 * Parse wait errors. teleproto stores the server code in
 * `errorMessage` (`FLOOD_WAIT_17`), seconds in `seconds`, and a
 * code-free explanation in `message`. Base 420 errors have
 * `errorMessage` equal to `FLOOD`. Parse both forms and codes embedded
 * in text, as seen in logs.
 */
export function floodInfo(err: unknown): FloodInfo | null {
  const e = err as TelegramErrorLike | null;
  if (!e || typeof e !== 'object') return null;
  const text = errorText(err);

  const slowText = text.match(SLOWMODE_TEXT);
  if (slowText) return { seconds: parseInt(slowText[1]!, 10), scope: 'chat' };
  const slowCode = text.match(SLOWMODE_CODE);
  if (slowCode) return { seconds: parseInt(slowCode[1]!, 10), scope: 'chat' };

  const hasSeconds = typeof e.seconds === 'number' && Number.isFinite(e.seconds) && e.seconds >= 0;
  // Base 420 error without a dedicated class. MSG_WAIT also has FLOOD but no seconds; it is not a wait.
  if (e.errorMessage === 'FLOOD' && hasSeconds) return { seconds: e.seconds!, scope: 'account' };

  const waitCode = text.match(WAIT_CODE);
  if (waitCode) return { seconds: parseInt(waitCode[1]!, 10), scope: 'account' };
  const waitText = text.match(WAIT_TEXT);
  if (waitText) return { seconds: parseInt(waitText[1]!, 10), scope: 'account' };
  if (/FLOOD_PREMIUM_WAIT|FLOOD_TEST_PHONE_WAIT|FLOOD_WAIT/.test(text)) return { seconds: hasSeconds ? e.seconds! : 0, scope: 'account' };
  return null;
}

/** Uppercase Telegram error code, if present in text. */
export function telegramErrorCode(err: unknown): string | undefined {
  const e = err as TelegramErrorLike | null;
  if (e && typeof e === 'object' && typeof e.errorMessage === 'string' && e.errorMessage) {
    return e.errorMessage;
  }
  const m = errorText(err).match(/\b([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+)\b/);
  return m ? m[1] : undefined;
}

interface Rule {
  match: RegExp;
  code: GatewayErrorCode;
  message: string;
}

const RULES: Rule[] = [
  {
    match: /CHANNEL_PRIVATE|CHAT_ADMIN_REQUIRED|CHANNEL_PUBLIC_GROUP_NA/,
    code: 'CHAT_PRIVATE',
    message:
      'This chat is private or the account is not a member. The owner has to join it first (joining goes through tg_join with confirmation).',
  },
  {
    match: /USERNAME_NOT_OCCUPIED|USERNAME_INVALID|CHANNEL_INVALID|PEER_ID_INVALID|CHAT_ID_INVALID|USER_ID_INVALID|INPUT_USER_DEACTIVATED/,
    code: 'CHAT_NOT_FOUND',
    message: 'Chat or user not found. Check the username or link, then resolve it again with tg_resolve.',
  },
  {
    match: /MSG_ID_INVALID|MESSAGE_ID_INVALID/,
    code: 'MESSAGE_NOT_FOUND',
    message: 'Message not found: it was deleted, or comments are disabled for this post.',
  },
  {
    match: /REACTION_INVALID|REACTION_EMPTY|REACTIONS_TOO_MANY/,
    code: 'INVALID_ARGUMENT',
    message: 'This reaction is not allowed here: the chat permits only some emoji (or none), and custom or paid reactions are not supported. Try a common one.',
  },
  {
    match: /INVITE_HASH_EXPIRED|INVITE_HASH_INVALID|INVITE_HASH_EMPTY/,
    code: 'INVITE_INVALID',
    message: 'The invite link is invalid or expired.',
  },
  {
    match: /USER_NOT_PARTICIPANT|CHANNEL_JOIN_REQUIRED/,
    code: 'JOIN_REQUIRED',
    message: 'The account has to be a member of this chat for this action.',
  },
  {
    match: /PEER_FLOOD/,
    code: 'PEER_FLOOD',
    message:
      'Telegram restricted this account from messaging people who are not its contacts (PEER_FLOOD). Stop writing to new people and tell the owner.',
  },
  {
    match: /ALLOW_PAYMENT_REQUIRED|PRIVACY_PREMIUM_REQUIRED|PAYMENT_REQUIRED|STARS_|BALANCE_TOO_LOW/,
    code: 'PAYMENT_REQUIRED',
    message:
      'This action costs Telegram Stars or needs Premium. The gateway never pays automatically: ask the owner.',
  },
  {
    match: /CHAT_WRITE_FORBIDDEN|USER_BANNED_IN_CHANNEL|CHAT_RESTRICTED|CHAT_SEND_PLAIN_FORBIDDEN|USER_IS_BLOCKED|YOU_BLOCKED_USER|CHAT_GUEST_SEND_FORBIDDEN|SEND_AS_PEER_INVALID/,
    code: 'WRITE_FORBIDDEN',
    message: 'The account is not allowed to write here.',
  },
  {
    // INPUT_USER_DEACTIVATED refers to the deleted peer, not this account.
    match: /AUTH_KEY_UNREGISTERED|AUTH_KEY_DUPLICATED|SESSION_REVOKED|SESSION_EXPIRED|(?<!INPUT_)USER_DEACTIVATED|AUTH_KEY_INVALID/,
    code: 'ACCOUNT_UNAUTHORIZED',
    message: 'The Telegram session of this account is no longer valid. The owner has to log in again (tg-mcp login).',
  },
  {
    match: /FROZEN_/,
    code: 'ACCOUNT_FROZEN',
    message: 'This Telegram account is frozen by Telegram (read-only). Tell the owner: the appeal goes through @SpamBot.',
  },
];

/** Convert any error to GatewayError; return classified errors unchanged. */
export function classifyError(err: unknown, context: { write?: boolean } = {}): GatewayError {
  if (err instanceof GatewayError) return err;

  if (err instanceof DeadlineError) {
    return new GatewayError(
      'TIMEOUT',
      context.write
        ? `${err.message}. The outcome is UNKNOWN: the action may already have been applied. Check before repeating it.`
        : `${err.message}. Try again later or narrow the request.`,
      { outcomeUnknown: context.write === true, cause: err },
    );
  }

  const flood = floodInfo(err);
  if (flood) {
    return new GatewayError(
      'FLOOD_WAIT',
      flood.scope === 'chat'
        ? `Slow mode in this chat: wait ${flood.seconds} seconds before sending another message here. Other chats are not affected.`
        : `Telegram rate limit: wait ${flood.seconds} seconds. Do NOT retry before retry_after.`,
      { retryAfter: flood.seconds, telegramCode: telegramErrorCode(err), cause: err },
    );
  }

  const text = errorText(err);
  for (const rule of RULES) {
    if (rule.match.test(text)) {
      return new GatewayError(rule.code, rule.message, { telegramCode: telegramErrorCode(err), cause: err });
    }
  }

  const code = telegramErrorCode(err);
  const detail = code ?? (text || 'unknown error');
  return new GatewayError('TELEGRAM_ERROR', `Telegram error: ${detail}`, { telegramCode: code, cause: err });
}

export function isGatewayError(err: unknown, code?: GatewayErrorCode): err is GatewayError {
  return err instanceof GatewayError && (code === undefined || err.code === code);
}
