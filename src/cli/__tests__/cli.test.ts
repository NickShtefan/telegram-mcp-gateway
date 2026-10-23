import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TelegramClient } from 'teleproto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientFactory } from '../../core/clientPool.js';
import { loadConfig, type GatewayConfig } from '../../core/config.js';
import { sha256Hex, unseal } from '../../core/crypto.js';
import { acquireLock, isLockHeld, lockPath } from '../../core/lock.js';
import { ScopePolicy, writePrivateMode } from '../../policy/scopes.js';
import { SqliteStorage } from '../../storage/sqlite.js';
import { addUser, describeAccounts, grantAccount, removeAccount, revokeAccount, rotateToken } from '../admin.js';
import { collectChecks } from '../doctor.js';
import type { CliIo } from '../io.js';
import { runLogin } from '../login.js';
import { main } from '../main.js';

// Windows owns sessions through a named-pipe lease; the Unix liveness socket cases are POSIX-only.
const windows = process.platform === 'win32';
let home: string;
let config: GatewayConfig;
let storage: SqliteStorage;
let out: string[];
let err: string[];
let io: CliIo;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tgmcp-'));
  config = loadConfig({ TG_MCP_HOME: home, TG_API_ID: '1', TG_API_HASH: 'hash' });
  storage = new SqliteStorage({ path: ':memory:' });
  out = [];
  err = [];
  io = { out: l => out.push(l), err: l => err.push(l), prompt: vi.fn(async () => '') };
});

afterEach(() => {
  storage.close();
  rmSync(home, { recursive: true, force: true });
});

function fakeFactory(overrides: Record<string, unknown> = {}): ClientFactory {
  return () =>
    ({
      addEventHandler: vi.fn(),
      removeEventHandler: vi.fn(),
      connect: vi.fn(async () => true),
      start: vi.fn(async () => undefined),
      getMe: vi.fn(async () => ({ id: 555n, username: 'agent_acc', firstName: 'Agent' })),
      destroy: vi.fn(async () => undefined),
      session: { save: () => 'SESSION_FROM_LOGIN' },
      ...overrides,
    }) as unknown as TelegramClient;
}

describe('admin', () => {
  it('creates a token-bearing user and stores only its hash', () => {
    const { user, token } = addUser(storage, { id: 'user_a', accounts: ['user_a', 'agent'] });
    expect(user.defaultAccount).toBe('user_a');
    expect(storage.users.findByTokenHash(sha256Hex(token))?.id).toBe('user_a');
    expect(storage.accounts.hasAccess('user_a', 'agent')).toBe(true);
    expect(() => addUser(storage, { id: 'user_a' })).toThrow(/already exists/);
    expect(() => addUser(storage, { id: 'Bad Id' })).toThrow(/Invalid user id/);
  });

  it('issuing a new token revokes the old one', () => {
    const { token } = addUser(storage, { id: 'user_a' });
    const next = rotateToken(storage, 'user_a');
    expect(storage.users.findByTokenHash(sha256Hex(token))).toBeNull();
    expect(storage.users.findByTokenHash(sha256Hex(next))?.id).toBe('user_a');
  });

  it('marks shared accounts and changes defaults after access revocation', () => {
    addUser(storage, { id: 'user_a', accounts: ['agent'] });
    addUser(storage, { id: 'user_b', accounts: ['user_b'] });
    grantAccount(storage, 'agent', 'user_b');
    expect(describeAccounts(storage).find(a => a.id === 'agent')).toMatchObject({ shared: true, users: ['user_a', 'user_b'] });
    revokeAccount(storage, 'agent', 'user_a');
    expect(storage.users.get('user_a')?.defaultAccount).toBeNull();
    removeAccount(storage, 'user_b');
    expect(storage.users.get('user_b')?.defaultAccount).toBe('agent');
  });
});

describe('login', () => {
  it('stores encrypted sessions and account details', async () => {
    io.prompt = vi.fn(async (q: string) => (q.startsWith('Phone') ? '+79991234567' : '12345'));
    await runLogin({ config, storage, io, account: 'agent', factory: fakeFactory(), sessionSecret: 'secret' });
    expect(storage.accounts.get('agent')).toMatchObject({ status: 'active', username: 'agent_acc', tgUserId: '555' });
    const sealed = storage.sessions.get('agent')!;
    expect(sealed.data).not.toContain('SESSION_FROM_LOGIN');
    expect(unseal(sealed, 'secret')).toBe('SESSION_FROM_LOGIN');
    expect(out.join('\n')).toContain('logged in as @agent_acc');
    expect(out.join('\n')).not.toContain('SESSION_FROM_LOGIN');
    expect(out.join('\n')).toContain('tg-mcp account grant agent <user>');
  });

  it('stores the session before closing the login client, whose failure terminates the process', async () => {
    io.prompt = vi.fn(async (q: string) => (q.startsWith('Phone') ? '+79991234567' : '12345'));
    let storedAtClose = false;
    const destroy = vi.fn(async () => { storedAtClose = storage.sessions.get('agent') !== null; });
    await runLogin({ config, storage, io, account: 'agent', factory: fakeFactory({ destroy }), sessionSecret: 'secret' });
    expect(destroy).toHaveBeenCalledOnce();
    expect(storedAtClose).toBe(true);
  });

  it('does not start login without API credentials', async () => {
    const bare = loadConfig({ TG_MCP_HOME: home });
    await expect(runLogin({ config: bare, storage, io, account: 'agent', factory: fakeFactory() })).rejects.toThrow(/TG_API_ID/);
  });
});

describe('doctor', () => {
  it('reports warnings without errors for an empty installation', async () => {
    const checks = await collectChecks({ config, storage, io, nodeVersion: 'v22.22.0' });
    expect(checks.filter(c => c.level === 'fail')).toEqual([]);
    expect(checks.map(c => c.message).join('\n')).toContain('no gateway users');
  });

  it('warns about the removed automate toolset without crashing', async () => {
    const before = process.env.TG_MCP_TOOLSETS;
    process.env.TG_MCP_TOOLSETS = 'core,automate,write';
    try {
      const checks = await collectChecks({ config, storage, io });
      expect(checks.some(c => c.level === 'warn' && c.message.includes('"automate" no longer exists'))).toBe(true);
    } finally {
      if (before === undefined) delete process.env.TG_MCP_TOOLSETS;
      else process.env.TG_MCP_TOOLSETS = before;
    }
  });

  it('shows private-chat modes and daily write limits', async () => {
    addUser(storage, { id: 'user_a', accounts: ['agent'] });
    const quiet = (await collectChecks({ config, storage, io })).map(c => c.message).join('\n');
    expect(quiet).not.toContain('private chats');
    // Limits apply only to writes; hide them when the write toolset is disabled.
    expect(quiet).not.toContain('write limits');

    writePrivateMode(storage, 'user_a', 'agent', 'send');
    const custom = { ...config, toolsets: ['core', 'write'], writeLimits: { newDialogsPerDay: 25, reactionsPerDay: 0 } };
    const text = (await collectChecks({ config: custom, storage, io })).map(c => c.message).join('\n');
    expect(text).toContain('user user_a on account agent: private chats are open for sending only');
    expect(text).toContain('write limits per account per day: replies 20, new dialogs 25, joins 5, reactions no limit');
  });

  it('reports old Node versions and accounts without sessions as errors', async () => {
    storage.accounts.upsert({ id: 'agent' });
    const checks = await collectChecks({ config, storage, io, nodeVersion: 'v20.11.0' });
    const failed = checks.filter(c => c.level === 'fail').map(c => c.message);
    expect(failed.some(m => m.startsWith('Node.js v20.11.0'))).toBe(true);
    expect(failed.some(m => m.includes('account agent: no session'))).toBe(true);
  });

  it('--connect connects accounts while the daemon is stopped', async () => {
    io.prompt = vi.fn(async () => '1');
    await runLogin({ config, storage, io, account: 'agent', phone: '+79991234567', factory: fakeFactory() });
    addUser(storage, { id: 'user_a', accounts: ['agent'] });
    const checks = await collectChecks({ config, storage, io, connect: true, factory: fakeFactory() });
    expect(checks.some(c => c.level === 'ok' && c.message.startsWith('account agent connects: @agent_acc'))).toBe(true);
  });

  it('--connect does not open sessions while the daemon holds the lock', async () => {
    const lock = await acquireLock(home);
    try {
      const factory = vi.fn(fakeFactory());
      const checks = await collectChecks({ config, storage, io, connect: true, factory });
      expect(checks.some(c => c.level === 'warn' && c.message.includes('skipping --connect'))).toBe(true);
      expect(factory).not.toHaveBeenCalled();
    } finally {
      await lock.release();
    }
  });
});

describe('lock', () => {
  it('rejects a second lock owner and allows acquisition after release', async () => {
    expect(await isLockHeld(home)).toBe(false);
    const lock = await acquireLock(home);
    expect(await isLockHeld(home)).toBe(true);
    await expect(acquireLock(home)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await lock.release();
    expect(await isLockHeld(home)).toBe(false);
    const again = await acquireLock(home);
    await again.release();
  });
});

describe('lock: races and stale files', () => {
  it('only one concurrent startup acquires the lock', async () => {
    const results = await Promise.allSettled([acquireLock(home), acquireLock(home), acquireLock(home)]);
    const won = results.filter(r => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    for (const lost of results.filter(r => r.status === 'rejected')) {
      expect((lost as PromiseRejectedResult).reason).toMatchObject({ code: 'UNAVAILABLE' });
    }
    await (won[0] as PromiseFulfilledResult<{ release(): Promise<void> }>).value.release();
  });

  it.skipIf(windows)('reclaims a dead process socket', async () => {
    // Closed server without socket removal, as after kill -9.
    const dead = createServer();
    await new Promise<void>(resolve => dead.listen(lockPath(home), resolve));
    const handle = (dead as unknown as { _handle: { close(): void } })._handle;
    handle.close();
    expect(await isLockHeld(home)).toBe(false);
    const lock = await acquireLock(home);
    expect(await isLockHeld(home)).toBe(true);
    await lock.release();
  });

  it.skipIf(windows)('explains an oversized home path instead of returning EINVAL', async () => {
    const deep = join(home, 'a'.repeat(60), 'b'.repeat(60));
    expect(await isLockHeld(deep)).toBe(false);
    await expect(acquireLock(deep)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('Set TG_MCP_HOME to a shorter path') });
  });

  it.skipIf(windows)('preserves a regular file at the socket path as unsafe state', async () => {
    writeFileSync(lockPath(home), 'stale');
    await expect(acquireLock(home)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(await isLockHeld(home)).toBe(true);
  });

  it('doctor --connect holds the lock while sessions remain open', async () => {
    io.prompt = vi.fn(async () => '1');
    await runLogin({ config, storage, io, account: 'agent', phone: '+79991234567', factory: fakeFactory() });
    let heldDuringConnect = false;
    const base = fakeFactory();
    const factory: ClientFactory = options => {
      const client = base(options);
      const connect = client.connect.bind(client);
      client.connect = (async () => {
        heldDuringConnect = await isLockHeld(home);
        return connect();
      }) as typeof client.connect;
      return client;
    };
    await collectChecks({ config, storage, io, connect: true, factory });
    expect(heldDuringConnect).toBe(true);
    expect(await isLockHeld(home)).toBe(false);
  });
});

describe('main', () => {
  it('handles help and unknown commands', async () => {
    expect(await main(['help'], { io, config, storage })).toBe(0);
    expect(out.join('\n')).toContain('tg-mcp login --account');
    expect(await main(['frobnicate'], { io, config, storage })).toBe(1);
    expect(err.join('\n')).toContain('Unknown command');
  });

  it('user add prints the token once and user list does not expose it', async () => {
    expect(await main(['user', 'add', 'user_a', '--account', 'agent'], { io, config, storage })).toBe(0);
    const token = out[out.length - 1]!;
    expect(storage.users.findByTokenHash(sha256Hex(token))?.id).toBe('user_a');
    out.length = 0;
    expect(await main(['user', 'list'], { io, config, storage })).toBe(0);
    expect(out.join('\n')).toContain('user_a  accounts: [agent]');
    expect(out.join('\n')).not.toContain(token);
  });

  it('handles account grant and list', async () => {
    await main(['user', 'add', 'user_a'], { io, config, storage });
    await main(['user', 'add', 'user_b'], { io, config, storage });
    expect(await main(['account', 'grant', 'agent', 'user_a'], { io, config, storage })).toBe(0);
    expect(await main(['account', 'grant', 'agent', 'user_b'], { io, config, storage })).toBe(0);
    out.length = 0;
    await main(['account', 'list'], { io, config, storage });
    expect(out.join('\n')).toContain('agent  no session  -  users: [user_a, user_b]  shared');
    expect(await main(['account', 'grant', 'agent', 'ghost'], { io, config, storage })).toBe(1);
  });

  it('scope: the owner opens a private chat and closes a channel', async () => {
    await main(['user', 'add', 'user_a', '--account', 'agent'], { io, config, storage });
    out.length = 0;
    expect(await main(['scope', 'allow', 'user_a', 'agent', '@Seller'], { io, config, storage })).toBe(0);
    expect(await main(['scope', 'deny', 'user_a', 'agent', '-1001782171896'], { io, config, storage })).toBe(0);
    expect(await main(['scope', 'list', 'user_a', 'agent'], { io, config, storage })).toBe(0);
    expect(out.join('\n')).toContain('allow  @seller');
    expect(out.join('\n')).toContain('deny  -1001782171896');
    expect(await main(['scope', 'remove', 'user_a', 'agent', 't.me/seller'], { io, config, storage })).toBe(0);
    expect(storage.scopes.list('user_a', 'agent')).toHaveLength(1);
    // Reject inaccessible accounts and invites.
    expect(await main(['scope', 'allow', 'user_a', 'other', '@x_user'], { io, config, storage })).toBe(1);
    expect(await main(['scope', 'allow', 'user_a', 'agent', 't.me/+AbCdEf'], { io, config, storage })).toBe(1);
  });

  it('scope private: shows and changes modes without presenting them as chat rules', async () => {
    await main(['user', 'add', 'user_a', '--account', 'agent'], { io, config, storage });
    out.length = 0;
    expect(await main(['scope', 'private', 'user_a', 'agent'], { io, config, storage })).toBe(0);
    expect(out.join('\n')).toContain('Private chats for user "user_a" on account "agent": closed');

    expect(await main(['scope', 'private', 'user_a', 'agent', 'send'], { io, config, storage })).toBe(0);
    expect(new ScopePolicy(storage).isAllowed('user_a', 'agent', { peerKey: '42', kind: 'user' }, 'write')).toBe(true);
    expect(new ScopePolicy(storage).isAllowed('user_a', 'agent', { peerKey: '42', kind: 'user' })).toBe(false);

    out.length = 0;
    expect(await main(['scope', 'list', 'user_a', 'agent'], { io, config, storage })).toBe(0);
    expect(out.join('\n')).toContain('Private chats: send');
    expect(out.join('\n')).toContain('No rules for single chats');
    expect(out.join('\n')).not.toContain('*private');

    expect(await main(['scope', 'private', 'user_a', 'agent', 'open'], { io, config, storage })).toBe(0);
    expect(new ScopePolicy(storage).privateMode('user_a', 'agent')).toBe('open');
    expect(await main(['scope', 'private', 'user_a', 'agent', 'closed'], { io, config, storage })).toBe(0);
    expect(storage.scopes.list('user_a', 'agent')).toHaveLength(0);

    // Invalid modes and inaccessible accounts must not change state.
    expect(await main(['scope', 'private', 'user_a', 'agent', 'all'], { io, config, storage })).toBe(1);
    expect(await main(['scope', 'private', 'user_a', 'other', 'open'], { io, config, storage })).toBe(1);
    expect(new ScopePolicy(storage).privateMode('user_a', 'agent')).toBe('closed');
    // An ordinary rule cannot create or remove a service target.
    expect(await main(['scope', 'allow', 'user_a', 'agent', '*private-open'], { io, config, storage })).toBe(1);
  });
});
