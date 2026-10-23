import { RPCMessageToError } from 'teleproto/errors';
import { describe, expect, it } from 'vitest';
import { classifyError, floodInfo, GatewayError, telegramErrorCode } from '../errors.js';
import { DeadlineError } from '../time.js';

/** Wait seconds; null for errors unrelated to waiting. */
const waitSeconds = (err: unknown): number | null => floodInfo(err)?.seconds ?? null;

describe('floodInfo: wait seconds', () => {
  it('reads seconds from a library error', () => {
    expect(waitSeconds({ seconds: 42, errorMessage: 'FLOOD_WAIT_42', message: 'A wait of 42 seconds is required' })).toBe(42);
  });

  it('parses seconds from the error text', () => {
    expect(waitSeconds(new Error('420: FLOOD_WAIT_17 (caused by messages.Search)'))).toBe(17);
    expect(waitSeconds(new Error('FLOOD_PREMIUM_WAIT_5'))).toBe(5);
    expect(waitSeconds(new Error('SLOWMODE_WAIT_30'))).toBe(30);
  });

  it('returns 0 for FLOOD_WAIT without seconds', () => {
    expect(waitSeconds(new Error('FLOOD_WAIT'))).toBe(0);
  });

  it('does not treat unrelated errors with a seconds field as waits', () => {
    expect(waitSeconds({ seconds: 3, errorMessage: 'PHONE_MIGRATE_2', message: 'migrate' })).toBeNull();
    expect(waitSeconds(new Error('CHANNEL_PRIVATE'))).toBeNull();
    expect(waitSeconds(null)).toBeNull();
  });
});

describe('classifyError', () => {
  it('returns FLOOD_WAIT retryAfter and prohibits retry', () => {
    const e = classifyError({ seconds: 300, errorMessage: 'FLOOD_WAIT_300', message: 'wait' });
    expect(e.code).toBe('FLOOD_WAIT');
    expect(e.retryAfter).toBe(300);
    expect(e.message).toContain('Do NOT retry');
  });

  it('classifies Telegram errors by meaning', () => {
    expect(classifyError(new Error('CHANNEL_PRIVATE')).code).toBe('CHAT_PRIVATE');
    expect(classifyError(new Error('USERNAME_NOT_OCCUPIED')).code).toBe('CHAT_NOT_FOUND');
    expect(classifyError(new Error('MSG_ID_INVALID')).code).toBe('MESSAGE_NOT_FOUND');
    expect(classifyError(new Error('INVITE_HASH_EXPIRED')).code).toBe('INVITE_INVALID');
    expect(classifyError(new Error('PEER_FLOOD')).code).toBe('PEER_FLOOD');
    expect(classifyError(new Error('ALLOW_PAYMENT_REQUIRED')).code).toBe('PAYMENT_REQUIRED');
    expect(classifyError(new Error('CHAT_WRITE_FORBIDDEN')).code).toBe('WRITE_FORBIDDEN');
    expect(classifyError(new Error('AUTH_KEY_DUPLICATED')).code).toBe('ACCOUNT_UNAUTHORIZED');
  });

  it('marks a timed-out write outcome as unknown', () => {
    const read = classifyError(new DeadlineError('messages.GetHistory', 1000));
    expect(read.code).toBe('TIMEOUT');
    expect(read.outcomeUnknown).toBe(false);
    const write = classifyError(new DeadlineError('messages.SendMessage', 1000), { write: true });
    expect(write.outcomeUnknown).toBe(true);
    expect(write.message).toContain('UNKNOWN');
  });

  it('preserves the Telegram code of an unknown error', () => {
    const e = classifyError({ errorMessage: 'SOMETHING_NEW_HAPPENED', message: '400: SOMETHING_NEW_HAPPENED' });
    expect(e.code).toBe('TELEGRAM_ERROR');
    expect(e.telegramCode).toBe('SOMETHING_NEW_HAPPENED');
  });

  it('returns GatewayError unchanged', () => {
    const original = new GatewayError('ACCESS_DENIED', 'nope');
    expect(classifyError(original)).toBe(original);
  });

  it('telegramErrorCode extracts the code from text', () => {
    expect(telegramErrorCode(new Error('400: CHANNEL_INVALID (caused by channels.GetFullChannel)'))).toBe('CHANNEL_INVALID');
    expect(telegramErrorCode(new Error('socket hang up'))).toBeUndefined();
  });
});

/** An error exactly as the library constructs it from a Telegram response. */
function realTelegramError(code: number, message: string, method = 'messages.Search'): Error {
  return RPCMessageToError({ errorCode: code, errorMessage: message } as never, { className: method } as never) as Error;
}

describe('actual MTProto library errors (teleproto)', () => {
  it('real FLOOD_WAIT carries the server code in errorMessage and seconds in its field', () => {
    const err = realTelegramError(420, 'FLOOD_WAIT_42');
    expect(err.constructor.name).toBe('FloodWaitError');
    expect(err as unknown as { errorMessage: string; seconds: number }).toMatchObject({ errorMessage: 'FLOOD_WAIT_42', seconds: 42 });
    // The message lacks the code: classification must not depend on it.
    expect(err.message).not.toContain('FLOOD_WAIT');
    expect(floodInfo(err)).toEqual({ seconds: 42, scope: 'account' });
    // A base 420 error with errorMessage FLOOD is recognized too.
    expect(floodInfo({ errorMessage: 'FLOOD', seconds: 42, message: 'A wait of 42 seconds is required' })).toEqual({ seconds: 42, scope: 'account' });
    expect(classifyError(err)).toMatchObject({ code: 'FLOOD_WAIT', retryAfter: 42 });
    expect(floodInfo(realTelegramError(420, 'FLOOD_PREMIUM_WAIT_7'))).toEqual({ seconds: 7, scope: 'account' });
  });

  it('slow mode pauses one chat rather than the account', () => {
    const err = realTelegramError(420, 'SLOWMODE_WAIT_30', 'messages.SendMessage');
    expect(floodInfo(err)).toEqual({ seconds: 30, scope: 'chat' });
    const classified = classifyError(err);
    expect(classified).toMatchObject({ code: 'FLOOD_WAIT', retryAfter: 30 });
    expect(classified.message).toContain('Slow mode in this chat');
  });

  it('does not classify MSG_WAIT_FAILED as a pause', () => {
    const err = realTelegramError(420, 'MSG_WAIT_FAILED');
    expect(floodInfo(err)).toBeNull();
    expect(classifyError(err).code).toBe('TELEGRAM_ERROR');
  });

  it('does not confuse a deleted peer with session loss', () => {
    expect(classifyError(realTelegramError(400, 'INPUT_USER_DEACTIVATED')).code).toBe('CHAT_NOT_FOUND');
    expect(classifyError(realTelegramError(401, 'USER_DEACTIVATED')).code).toBe('ACCOUNT_UNAUTHORIZED');
    expect(classifyError(realTelegramError(401, 'AUTH_KEY_UNREGISTERED')).code).toBe('ACCOUNT_UNAUTHORIZED');
  });

  it('handles revoked sessions, frozen accounts, and keys owned by another process', () => {
    expect(classifyError(realTelegramError(401, 'SESSION_REVOKED')).code).toBe('ACCOUNT_UNAUTHORIZED');
    expect(classifyError(realTelegramError(406, 'AUTH_KEY_DUPLICATED')).code).toBe('ACCOUNT_UNAUTHORIZED');
    expect(classifyError(realTelegramError(420, 'FROZEN_METHOD_INVALID')).code).toBe('ACCOUNT_FROZEN');
    expect(classifyError(realTelegramError(400, 'PEER_FLOOD')).code).toBe('PEER_FLOOD');
    expect(classifyError(realTelegramError(400, 'REACTION_INVALID')).code).toBe('INVALID_ARGUMENT');
    // Codes unknown to the library remain available.
    const unknown = classifyError(realTelegramError(400, 'SOME_BRAND_NEW_ERROR_7'));
    expect(unknown).toMatchObject({ code: 'TELEGRAM_ERROR', telegramCode: 'SOME_BRAND_NEW_ERROR_7' });
  });

  it('preserves Telegram codes for write-outcome consumers', () => {
    expect(classifyError(realTelegramError(400, 'USER_ALREADY_PARTICIPANT')).telegramCode).toBe('USER_ALREADY_PARTICIPANT');
    expect(classifyError(realTelegramError(400, 'INVITE_REQUEST_SENT')).telegramCode).toBe('INVITE_REQUEST_SENT');
    expect(classifyError(realTelegramError(400, 'CHANNEL_PRIVATE')).code).toBe('CHAT_PRIVATE');
  });
});
