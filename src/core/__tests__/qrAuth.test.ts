import { Api, type TelegramClient } from 'teleproto';
import { signInUserWithQrCode } from 'teleproto/client/auth';
import bigInt from 'big-integer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountLimiter } from '../limiter.js';
import { queueLoginCalls } from '../tg.js';
import { createLogger } from '../log.js';

const credentials = { apiId: 1, apiHash: 'synthetic' };
const user = new Api.User({ id: bigInt(1001), firstName: 'Fixture' });
const success = () => new Api.auth.LoginTokenSuccess({ authorization: new Api.auth.Authorization({ user }) });
const token = (value: string) => new Api.auth.LoginToken({ token: Buffer.from(value), expires: 2000000000 });
const log = createLogger('qr-test', { level: 'silent' });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function fixture(responses: Array<unknown | Error>) {
  vi.useFakeTimers(); let update: (event: Api.TypeUpdate) => void = () => undefined;
  const fake = {
    invoke: vi.fn(async () => { const value = responses.shift(); if (value instanceof Error) throw value; return value; }),
    addEventHandler: vi.fn((handler: typeof update) => { update = handler; }), removeEventHandler: vi.fn(),
    _switchDC: vi.fn(async () => undefined),
    signInWithPassword: vi.fn(async (_credentials, params) => { await params.password('fixture hint'); return user; }),
  };
  const invoked = fake.invoke;
  const client = fake as unknown as TelegramClient;
  const limiter = new AccountLimiter({ log, minIntervalMs: 0, onFatal: () => { throw new Error('fatal'); } });
  const restore = queueLoginCalls(client, 'login', limiter, () => { throw new Error('fatal'); });
  return { client, fake, invoked, scanned: () => update(new Api.UpdateLoginToken()), close: () => { restore(); limiter.shutdown(); } };
}

describe('pinned QR authentication through the core queue', () => {
  it('refreshes the displayed token after expiry and completes in the same client', async () => {
    const f = fixture([token('first'), token('second'), success()]); const shown: string[] = [];
    try {
      const login = signInUserWithQrCode(f.client, credentials, { qrCode: async code => { shown.push(code.token.toString()); if (shown.length === 2) f.scanned(); }, onError: async () => true });
      await vi.advanceTimersByTimeAsync(0); expect(shown).toEqual(['first']);
      await vi.advanceTimersByTimeAsync(30001); expect(await login).toBe(user);
      expect(shown).toEqual(['first', 'second']); expect(f.fake.removeEventHandler).toHaveBeenCalledOnce();
      expect(f.invoked.mock.calls).toHaveLength(3);
    } finally { f.close(); }
  });
  it('imports a scanned token on the required DC using the same queued client', async () => {
    const f = fixture([token('first'), new Api.auth.LoginTokenMigrateTo({ dcId: 3, token: Buffer.from('migrated') }), success()]);
    try {
      const login = signInUserWithQrCode(f.client, credentials, { qrCode: async () => f.scanned(), onError: async () => true });
      await vi.advanceTimersByTimeAsync(0); expect(await login).toBe(user);
      expect(f.fake._switchDC).toHaveBeenCalledWith(3);
      expect(f.invoked.mock.calls.map(args => (args as unknown as [{ className: string }])[0].className)).toEqual(['auth.ExportLoginToken', 'auth.ExportLoginToken', 'auth.ImportLoginToken']);
    } finally { f.close(); }
  });
  it('requests 2FA after scanning instead of falling back to phone/code', async () => {
    const required = Object.assign(new Error('password required'), { errorMessage: 'SESSION_PASSWORD_NEEDED' });
    const f = fixture([token('first'), required]); const password = vi.fn(async () => 'synthetic password');
    try {
      const login = signInUserWithQrCode(f.client, credentials, { qrCode: async () => f.scanned(), password, onError: async () => true });
      await vi.advanceTimersByTimeAsync(0); expect(await login).toBe(user);
      expect(password).toHaveBeenCalledWith('fixture hint'); expect(f.fake.signInWithPassword).toHaveBeenCalledOnce();
    } finally { f.close(); }
  });
  it('removes its update listener when the human input deadline is cancelled', async () => {
    const f = fixture([token('first')]); const abort = new AbortController();
    try {
      const login = signInUserWithQrCode(f.client, credentials, { qrCode: async () => undefined, abortSignal: abort.signal, onError: async () => true });
      const rejected = expect(login).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(0); abort.abort(); await rejected;
      expect(f.fake.removeEventHandler).toHaveBeenCalledOnce();
    } finally { f.close(); }
  });
});
