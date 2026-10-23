import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Api, type TelegramClient } from 'teleproto';
import { signInUser } from 'teleproto/client/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loginAccount, normalizePhone } from '../auth.js';
import { ClientPool, type ClientFactory } from '../clientPool.js';
import { loadConfig, loadSessionSecret, parseToolsets, requireApiCredentials } from '../config.js';
import { seal } from '../crypto.js';
import { AccountLimiter } from '../limiter.js';
import { createLogger } from '../log.js';
import { TgGateway, queueLoginCalls } from '../tg.js';
import { SqliteStorage } from '../../storage/sqlite.js';

const silent = createLogger('test', { level: 'silent' });
const SECRET = 'test-secret';

interface FakeClient {
  addEventHandler: ReturnType<typeof vi.fn>;
  removeEventHandler: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  getMe: ReturnType<typeof vi.fn>;
  invoke: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  session: { save: () => string };
  sessionGiven: string;
}

function makeFactory(setup: (client: FakeClient) => void = () => undefined) {
  const created: FakeClient[] = [];
  const factory: ClientFactory = ({ session }) => {
    const client: FakeClient = {
      addEventHandler: vi.fn(),
      removeEventHandler: vi.fn(),
      connect: vi.fn(async () => true),
      getMe: vi.fn(async () => ({ id: 1001n, username: 'agent_acc', firstName: 'Agent', lastName: null })),
      invoke: vi.fn(async () => ({ ok: true })),
      destroy: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      session: { save: () => 'SAVED_SESSION' },
      sessionGiven: session,
    };
    setup(client);
    created.push(client);
    return client as unknown as TelegramClient;
  };
  return { factory, created };
}

let storage: SqliteStorage;

beforeEach(() => {
  storage = new SqliteStorage({ path: ':memory:' });
  storage.accounts.upsert({ id: 'agent' });
  storage.sessions.put('agent', seal('PLAIN_SESSION', SECRET));
});

afterEach(() => {
  storage.close();
  vi.useRealTimers();
});

function makePool(factory: ClientFactory, onFatal = vi.fn()) {
  return {
    pool: new ClientPool({ storage, credentials: () => ({ sessionSecret: SECRET, apiId: 1, apiHash: 'h' }), factory, onFatal, log: silent, connectTimeoutMs: 30_000 }),
    onFatal,
  };
}

describe('ClientPool', () => {
  it('connects an account once even for concurrent requests', async () => {
    const { factory, created } = makeFactory();
    const { pool } = makePool(factory);
    const [a, b, c] = await Promise.all([pool.getClient('agent'), pool.getClient('agent'), pool.getClient('agent')]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(created).toHaveLength(1);
    expect(created[0]!.sessionGiven).toBe('PLAIN_SESSION');
    expect(pool.identity('agent')).toEqual({ tgUserId: '1001', username: 'agent_acc', displayName: 'Agent' });
    expect(storage.accounts.get('agent')).toMatchObject({ status: 'active', tgUserId: '1001', username: 'agent_acc' });
  });

  it('asks the owner to log in when an account has no session', async () => {
    storage.accounts.upsert({ id: 'fresh' });
    const { pool } = makePool(makeFactory().factory);
    await expect(pool.getClient('fresh')).rejects.toMatchObject({ code: 'ACCOUNT_UNAUTHORIZED', message: expect.stringContaining('tg-mcp login --account fresh') });
    await expect(pool.getClient('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('does not return a client with an invalid encryption key', async () => {
    const { factory, created } = makeFactory();
    const pool = new ClientPool({ storage, credentials: () => ({ sessionSecret: 'other', apiId: 1, apiHash: 'h' }), factory, onFatal: vi.fn(), log: silent });
    await expect(pool.getClient('agent')).rejects.toMatchObject({ code: 'ACCOUNT_UNAUTHORIZED' });
    expect(created).toHaveLength(0);
  });

  it('marks unauthorized sessions and closes the client', async () => {
    const { factory, created } = makeFactory(c => c.getMe.mockResolvedValue(null));
    const { pool } = makePool(factory);
    await expect(pool.getClient('agent')).rejects.toMatchObject({ code: 'ACCOUNT_UNAUTHORIZED' });
    expect(storage.accounts.get('agent')?.status).toBe('unauthorized');
    expect(created[0]!.destroy).toHaveBeenCalled();
    expect(pool.identity('agent')).toBeNull();
  });

  it('requires process restart after a hung connection', async () => {
    vi.useFakeTimers();
    const { factory } = makeFactory(c => c.connect.mockReturnValue(new Promise(() => undefined)));
    const { pool, onFatal } = makePool(factory);
    const p = pool.getClient('agent');
    const assertion = expect(p).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(40_000);
    await assertion;
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it('destroyAll closes clients through destroy', async () => {
    const { factory, created } = makeFactory();
    const { pool } = makePool(factory);
    await pool.getClient('agent');
    await pool.destroyAll();
    expect(created[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(pool.identity('agent')).toBeNull();
  });
});

describe('TgGateway', () => {
  function makeTg(setup?: (client: FakeClient) => void) {
    const { factory, created } = makeFactory(setup);
    const { pool } = makePool(factory);
    const limiter = new AccountLimiter({ onFatal: vi.fn(), log: silent, minIntervalMs: 0 });
    return { tg: new TgGateway({ pool, limiter, entities: storage.entities, log: silent }), created, pool };
  }

  it('uses the account client and caches response entities', async () => {
    const { tg, created } = makeTg(c =>
      c.invoke.mockResolvedValue({
        messages: [],
        chats: [{ className: 'Channel', id: 5n, accessHash: 77n, title: 'News', username: 'news', broadcast: true }],
        users: [{ className: 'User', id: 42n, accessHash: 9n, firstName: 'Ivan' }],
      }),
    );
    const request = { className: 'messages.GetHistory' };
    const result = await tg.invoke('agent', request as never);
    expect(created[0]!.invoke).toHaveBeenCalledWith(request);
    expect(result).toHaveProperty('chats');
    expect(storage.entities.getByUsername('agent', 'news')).toMatchObject({ peerKey: '-1000000000005', accessHash: '77' });
    expect(storage.entities.get('agent', '42')?.accessHash).toBe('9');
    expect(tg.laneStatus('agent').callsInWindow).toBe(1);
  });

  it('marks the account and closes the client after an authorization error', async () => {
    const { tg, created, pool } = makeTg(c => c.invoke.mockRejectedValue(new Error('AUTH_KEY_UNREGISTERED')));
    await expect(tg.invoke('agent', { className: 'users.GetUsers' } as never)).rejects.toMatchObject({ code: 'ACCOUNT_UNAUTHORIZED' });
    expect(storage.accounts.get('agent')?.status).toBe('unauthorized');
    expect(created[0]!.destroy).toHaveBeenCalled();
    expect(pool.identity('agent')).toBeNull();
  });

  it('withClient executes an operation inside the account lane', async () => {
    const { tg } = makeTg();
    await expect(tg.withClient('agent', 'download', async client => typeof client.invoke)).resolves.toBe('function');
    await expect(tg.whoami('agent')).resolves.toMatchObject({ username: 'agent_acc' });
  });
});

describe('MTProto library (teleproto)', () => {
  it('creates a real client with gateway options without stdout logging', async () => {
    const { defaultClientFactory } = await import('../clientPool.js');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const client = defaultClientFactory({ session: '', apiId: 12345, apiHash: 'a'.repeat(32), log: silent });
      expect(client.floodSleepThreshold).toBe(0);
      // Library messages go through the gateway logger (stderr), not stdout.
      (client as unknown as { _log: { warn(message: string): void } })._log.warn('test warning');
      expect(stdout).not.toHaveBeenCalled();
      expect(consoleLog).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      consoleLog.mockRestore();
    }
  });

  it('reads GramJS sessions so logins predating the library migration still work', async () => {
    const { StringSession } = await import('teleproto/sessions');
    // GramJS format: version, DC number, address length, address, port, 256-byte key.
    const key = Buffer.alloc(256, 7);
    const address = Buffer.from('149.154.167.91');
    const length = Buffer.alloc(2);
    length.writeInt16BE(address.length, 0);
    const port = Buffer.alloc(2);
    port.writeInt16BE(443, 0);
    const legacy = '1' + Buffer.concat([Buffer.from([2]), length, address, port, key]).toString('base64');

    const session = new StringSession(legacy);
    await session.load();
    expect(session.dcId).toBe(2);
    expect(session.serverAddress).toBe('149.154.167.91');
    expect(session.port).toBe(443);
    expect(session.authKey?.getKey()?.equals(key)).toBe(true);
    // It also saves the same representation.
    expect(session.save()).toBe(legacy);
  });
});

describe('loginAccount', () => {
  it('logs in and returns session and account details', async () => {
    const { factory, created } = makeFactory(c =>
      c.start.mockImplementation(async (params: { phoneCode: () => Promise<string>; password: (h?: string) => Promise<string> }) => {
        expect(await params.phoneCode()).toBe('12345');
        expect(await params.password('hint')).toBe('pw');
      }),
    );
    const result = await loginAccount({
      factory,
      apiId: 1,
      apiHash: 'h',
      phone: '+7 (999) 123-45-67',
      prompts: { code: async () => '12345', password: async () => 'pw' },
      log: silent,
    });
    expect(result).toEqual({ session: 'SAVED_SESSION', identity: { tgUserId: '1001', username: 'agent_acc', displayName: 'Agent' } });
    expect(created[0]!.sessionGiven).toBe('');
    expect(created[0]!.connect).not.toHaveBeenCalled();
    expect(created[0]!.start.mock.calls[0]![0].phoneNumber).toBe('+79991234567');
    expect(created[0]!.destroy).toHaveBeenCalled();
  });

  it('aborts login after three invalid codes', async () => {
    const { factory } = makeFactory(c => {
      c.start.mockImplementation(async (params: { onError: (e: Error) => Promise<boolean> }) => {
        expect(await params.onError(new Error('PHONE_CODE_INVALID'))).toBe(false);
        expect(await params.onError(new Error('PHONE_CODE_INVALID'))).toBe(false);
        expect(await params.onError(new Error('PHONE_CODE_INVALID'))).toBe(true);
        throw new Error('AUTH_USER_CANCEL');
      });
    });
    await expect(
      loginAccount({ factory, apiId: 1, apiHash: 'h', phone: '+79991234567', prompts: { code: async () => '0', password: async () => '' }, log: silent }),
    ).rejects.toMatchObject({ telegramCode: 'PHONE_CODE_INVALID' });
  });

  it('aborts for unregistered numbers without creating accounts', async () => {
    const { factory, created } = makeFactory(c => {
      c.start.mockImplementation(async (params: { firstAndLastNames: () => Promise<[string, string]>; onError: (e: Error) => Promise<boolean> }) => {
        const refused = (await params.firstAndLastNames().catch((e: unknown) => e)) as Error;
        expect(refused).toBeInstanceOf(Error);
        // The library asks whether to abort: answer yes on the first error.
        expect(await params.onError(refused)).toBe(true);
        throw new Error('AUTH_USER_CANCEL');
      });
    });
    await expect(
      loginAccount({ factory, apiId: 1, apiHash: 'h', phone: '+79991234567', prompts: { code: async () => '1', password: async () => '' }, log: silent }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('does not register new accounts') });
    expect(created[0]!.destroy).toHaveBeenCalled();
  });

  it('canceled code entry aborts rather than asking again', async () => {
    const code = vi.fn(async () => {
      throw new Error('Cancelled.');
    });
    const { factory } = makeFactory(c => {
      c.start.mockImplementation(async (params: { phoneCode: () => Promise<string>; onError: (e: Error) => Promise<boolean> }) => {
        const failed = (await params.phoneCode().catch((e: unknown) => e)) as Error;
        expect(await params.onError(failed)).toBe(true);
        throw new Error('AUTH_USER_CANCEL');
      });
    });
    await expect(
      loginAccount({ factory, apiId: 1, apiHash: 'h', phone: '+79991234567', prompts: { code, password: async () => '' }, log: silent }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'Login cancelled: Cancelled.' });
    expect(code).toHaveBeenCalledTimes(1);
  });

  it('validates phone number format', () => {
    expect(normalizePhone('79991234567')).toBe('+79991234567');
    expect(() => normalizePhone('abc')).toThrow(/international format/);
  });
  it('does not return a session after cancelled input even if the library returns normally', async () => {
    const {factory}=makeFactory(c=>{
      c.start.mockImplementation(async(params:{phoneCode:()=>Promise<string>})=>{await params.phoneCode().catch(()=>undefined)});
    });
    await expect(loginAccount({factory,apiId:1,apiHash:'h',phone:'+79991234567',prompts:{code:async()=>{throw new Error('cancelled')},password:async()=>''},log:silent})).rejects.toMatchObject({code:'UNAVAILABLE'});
  });
  it('requires worker termination rather than continuing after stuck cleanup', async () => {
    const {factory}=makeFactory(c=>{c.destroy.mockImplementation(async()=>new Promise(()=>undefined))});
    const fatal=vi.fn(()=>{throw new Error('fatal_worker_exit')});
    await expect(loginAccount({factory,apiId:1,apiHash:'h',phone:'+79991234567',prompts:{code:async()=>'',password:async()=>''},log:silent,cleanupTimeoutMs:5,onFatal:fatal})).rejects.toThrow('fatal_worker_exit');
    expect(fatal).toHaveBeenCalledTimes(1);
  });
  for (const [name, destroy] of [['stuck', () => new Promise(() => undefined)], ['rejecting', async () => { throw new Error('synthetic close failure'); }]] as const) {
    it(`persists the authorized session before a ${name} cleanup terminates the worker`, async () => {
      const events: string[] = []; let original: unknown; let queued: ((request: unknown) => Promise<unknown>) | undefined;
      const {factory,created}=makeFactory(c=>{original=c.invoke;c.start.mockImplementation(async()=>{queued=c.invoke as never});c.destroy.mockImplementation(async()=>{events.push('destroy');return destroy()})});
      const fatal=vi.fn(()=>{events.push(created[0]!.invoke===original?'fatal-after-restore':'fatal');throw new Error('fatal_worker_exit')});
      const persist=vi.fn(async(result:{session:string})=>{events.push(`persist:${result.session}`)});
      await expect(loginAccount({factory,apiId:1,apiHash:'h',phone:'+79991234567',prompts:{code:async()=>'',password:async()=>''},log:silent,cleanupTimeoutMs:5,onFatal:fatal,persist})).rejects.toThrow('fatal_worker_exit');
      expect(events).toEqual(['persist:SAVED_SESSION','destroy','fatal-after-restore']);
      // The library-facing queue is shut down even though termination was requested.
      await expect(queued!({className:'help.GetConfig'})).rejects.toMatchObject({code:'UNAVAILABLE'});
    });
  }
  it('surfaces persistence errors unchanged and still closes the login client', async () => {
    const {factory,created}=makeFactory(c=>{c.start.mockImplementation(async(params:{onError:(e:Error)=>Promise<boolean>})=>{await params.onError(new Error('PHONE_CODE_INVALID'))})});
    const failure=new Error('synthetic storage failure');
    await expect(loginAccount({factory,apiId:1,apiHash:'h',phone:'+79991234567',prompts:{code:async()=>'',password:async()=>''},log:silent,persist:async()=>{throw failure}})).rejects.toBe(failure);
    expect(created[0]!.destroy).toHaveBeenCalledOnce();
  });
  it('drops whitespace from pasted login codes but passes passwords verbatim', async () => {
    const {factory}=makeFactory(c=>{c.start.mockImplementation(async(params:{phoneCode:()=>Promise<string>;password:(h?:string)=>Promise<string>})=>{
      expect(await params.phoneCode()).toBe('12345');expect(await params.password()).toBe(' pass word ');
    })});
    await loginAccount({factory,apiId:1,apiHash:'h',phone:'+79991234567',prompts:{code:async()=>' 12 345 \n',password:async()=>' pass word '},log:silent});
  });
});

describe('config', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tgmcp-config-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('loads home-directory .env with environment precedence', () => {
    writeFileSync(join(home, '.env'), 'TG_API_ID=12345\nTG_API_HASH="abcdef"\nTG_MCP_PORT=8123\n# comment\n');
    const env: NodeJS.ProcessEnv = { TG_MCP_HOME: home, TG_MCP_PORT: '9000' };
    const config = loadConfig(env);
    expect(config).toMatchObject({ home, apiId: 12345, apiHash: 'abcdef', port: 9000, host: '127.0.0.1', toolsets: ['core'] });
    expect(config.dbPath).toBe(join(home, 'gateway.sqlite'));
    expect(requireApiCredentials(config)).toEqual({ apiId: 12345, apiHash: 'abcdef' });
  });

  it('reads configured daily write limits and rejects typos instead of using defaults', () => {
    expect(loadConfig({ TG_MCP_HOME: home }).writeLimits).toEqual({});
    writeFileSync(join(home, '.env'), 'TG_MCP_LIMIT_NEW_DIALOGS=25\nTG_MCP_LIMIT_REACTIONS=0\n');
    expect(loadConfig({ TG_MCP_HOME: home }).writeLimits).toEqual({ newDialogsPerDay: 25, reactionsPerDay: 0 });
    expect(loadConfig({ TG_MCP_HOME: home, TG_MCP_LIMIT_REPLIES: ' 40 ', TG_MCP_LIMIT_JOINS: '' }).writeLimits).toMatchObject({ repliesPerDay: 40 });
    for (const bad of ['many', '-1', '2.5', '10 per day']) {
      expect(() => loadConfig({ TG_MCP_HOME: home, TG_MCP_LIMIT_NEW_DIALOGS: bad })).toThrow(/TG_MCP_LIMIT_NEW_DIALOGS must be a whole number/);
    }
  });

  it('explains where to put missing API credentials', () => {
    const config = loadConfig({ TG_MCP_HOME: home });
    expect(() => requireApiCredentials(config)).toThrow(/TG_API_ID/);
  });

  it('rejects invalid toolsets but skips the removed automate toolset', () => {
    expect(parseToolsets('core, Write ,index')).toEqual(['core', 'write', 'index']);
    // An old .env containing the removed toolset must not crash the daemon.
    expect(parseToolsets('core, automate, write')).toEqual(['core', 'write']);
    expect(parseToolsets('automate')).toEqual(['core']);
    expect(parseToolsets(undefined)).toEqual(['core']);
    expect(() => parseToolsets('core,wirte')).toThrow(/Unknown toolset/);
  });

  it('does not overwrite a session key created by another process', () => {
    const first = loadSessionSecret(home);
    expect(loadSessionSecret(home)).toBe(first);
    expect(readFileSync(join(home, 'session.key'), 'utf8').trim()).toBe(first);
  });

  it('creates the session key once with mode 0600', () => {
    const first = loadSessionSecret(home, {});
    const second = loadSessionSecret(home, {});
    expect(first).toBe(second);
    expect(readFileSync(join(home, 'session.key'), 'utf8').trim()).toBe(first);
    // POSIX mode bits are not Windows ACL evidence; service ACLs have their own checks.
    if (process.platform !== 'win32') expect(statSync(join(home, 'session.key')).mode & 0o777).toBe(0o600);
    expect(loadSessionSecret(home, { TG_MCP_SESSION_KEY: 'from-env' })).toBe('from-env');
  });
});

describe('queued authentication RPC boundary', () => {
  it('preserves DC migration and call options, then restores the original methods', async () => {
    const invoke = vi.fn(async () => ({ ok: true })); const connect = vi.fn(async () => true);
    const client = { invoke, connect } as unknown as TelegramClient;
    const limiter = new AccountLimiter({ log: silent, onFatal: () => { throw new Error('fatal'); } });
    const restore = queueLoginCalls(client, 'login', limiter, () => { throw new Error('fatal'); });
    const request = { className: 'auth.SignIn' }; const options = { floodSleepThreshold: 0 };
    await client.invoke(request as never, 4, options as never);
    expect(invoke).toHaveBeenCalledWith(request, 4, options);
    restore(); limiter.shutdown();
    expect(client.invoke).toBe(invoke); expect(client.connect).toBe(connect);
  });
});

describe('authentication library regressions', () => {
  it('reaches the pinned library password branch after SESSION_PASSWORD_NEEDED', async () => {
    const control = Object.assign(new Error('password required'), { errorMessage: 'SESSION_PASSWORD_NEEDED' });
    const password = vi.fn(async () => 'synthetic-password');
    const signInWithPassword = vi.fn(async (_credentials, params) => { await params.password(); return { id: 1 }; });
    const client = { invoke: vi.fn(async (request: { className: string }) => {
      if (request.className === 'auth.SendCode') return new Api.auth.SentCode({ type: new Api.auth.SentCodeTypeApp({ length: 5 }), phoneCodeHash: 'synthetic' });
      throw control;
    }), signInWithPassword } as unknown as TelegramClient;
    const limiter = new AccountLimiter({ log: silent, minIntervalMs: 0, onFatal: () => { throw new Error('fatal'); } });
    const restore = queueLoginCalls(client, 'login', limiter, () => { throw new Error('fatal'); });
    try {
      await expect(signInUser(client, { apiId: 1, apiHash: 'synthetic' }, {
        phoneNumber: '+15550000000', phoneCode: async () => '12345', password,
        onError: async () => { throw new Error('2FA must not enter generic retry'); },
      })).resolves.toEqual({ id: 1 });
      expect(password).toHaveBeenCalledOnce(); expect(signInWithPassword).toHaveBeenCalledOnce();
    } finally { restore(); limiter.shutdown(); }
  });
  it('executes nested migration calls in order under the auth owner while other work stays queued', async () => {
    const order: string[] = []; const fatal = vi.fn();
    const client = { invoke: vi.fn(async (request: { className: string }) => {
      order.push(request.className);
      if (request.className === 'auth.SendCode') {
        await client.invoke({ className: 'updates.GetState' } as never);
        await Promise.all([client.invoke({ className: 'help.GetConfig' } as never), client.invoke({ className: 'auth.ExportAuthorization' } as never)]);
      }
      return { ok: true };
    }) } as unknown as TelegramClient;
    const limiter = new AccountLimiter({ log: silent, minIntervalMs: 0, defaultDeadlineMs: 2000, interactiveWaitBudgetMs: 1000, onFatal: fatal });
    const restore = queueLoginCalls(client, 'login', limiter, () => { throw new Error('fatal'); });
    try {
      const auth = client.invoke({ className: 'auth.SendCode' } as never);
      const unrelated = limiter.run('login', async () => { order.push('unrelated'); return true; }, { label: 'unrelated' });
      await auth; await unrelated;
      expect(order).toEqual(['auth.SendCode', 'updates.GetState', 'help.GetConfig', 'auth.ExportAuthorization', 'unrelated']);
      expect(limiter.status('login').callsInWindow).toBe(5); expect(fatal).not.toHaveBeenCalled();
    } finally { restore(); limiter.shutdown(); }
  });
});
