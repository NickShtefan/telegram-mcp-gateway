import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Api } from 'teleproto';
import bigInt from 'big-integer';
import { AuthKey } from 'teleproto/crypto/AuthKey';
import { MTProtoSender } from 'teleproto/network';
import type { RequestState } from 'teleproto/network/RequestState';
import { _handleUpdate } from 'teleproto/client/updates';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addUser } from '../../cli/admin.js';
import { createRuntime, type Runtime } from '../../runtime.js';
import { buildServices } from '../../services/index.js';
import { createMcpServer } from '../../mcp/server.js';
import { SqliteStorage } from '../../storage/sqlite.js';
import { defaultClientFactory } from '../clientPool.js';
import { seal } from '../crypto.js';
import { createLogger } from '../log.js';

const log = createLogger('connection-test', { level: 'silent' });
const account = 'fixture_account';
const secret = 'synthetic-test-secret';
let home: string;
let storage: SqliteStorage;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  vi.useFakeTimers();
  home = mkdtempSync(join(tmpdir(), 'tg-connection-'));
  storage = new SqliteStorage({ path: ':memory:' });
  storage.accounts.upsert({ id: account });
  storage.sessions.put(account, seal('SYNTHETIC_SESSION', secret));
  addUser(storage, { id: 'fixture_user', accounts: [account] });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  storage.close();
  rmSync(home, { recursive: true, force: true });
  vi.useRealTimers();
});

/** Real pinned teleproto state machine, with every socket replaced by memory. */
async function harness() {
  const network = { online: true, failures: 0, dials: 0 };
  class FakeConnection {
    readonly _ip = 'synthetic.invalid';
    readonly _port = 443;
    readonly _dcId = 2;
    readonly _log = undefined;
    private open = false;
    readonly socket = { close: async () => { this.open = false; } };
    constructor(_options: unknown = {}) {}
    isConnected() { return this.open; }
    async connect() {
      network.dials++;
      if (!network.online || network.failures-- > 0) throw new Error('ENETUNREACH: synthetic network outage');
      this.open = true;
    }
    async disconnect() { this.open = false; }
    toString() { return 'synthetic-network-no-sockets'; }
  }

  const client = defaultClientFactory({ session: '', apiId: 12345, apiHash: 'a'.repeat(32), log });
  const key = new AuthKey();
  await key.setKey(Buffer.alloc(256, 7));
  const sender = new MTProtoSender(key, {
    logger: client._log, dcId: 2, retries: client._connectionRetries, delay: client._retryDelay,
    autoReconnect: client._autoReconnect, reconnectRetries: client._reconnectRetries,
    isMainSender: true, client, updateCallback: _handleUpdate, connectTimeout: client._timeout, securityChecks: true,
    lifecycleCallback: event => client._handleConnectionLifecycle(event),
  });
  // No I/O loops or real network: retain the actual dial/retry/dead transitions.
  (sender as unknown as { _startIo: () => void })._startIo = () => undefined;
  client._sender = sender;
  client._connectedDeferred.resolve();
  const connect = vi.spyOn(client, 'connect').mockImplementation(async () => sender.connect(new FakeConnection() as never, false));
  const getMe = vi.spyOn(client, 'getMe').mockImplementation(async () => {
    client._selfInputPeer = new Api.InputPeerUser({ userId: bigInt(123), accessHash: bigInt.zero });
    return new Api.User({ id: bigInt(123), username: account, firstName: 'Fixture' });
  });
  const destroy = vi.spyOn(client, 'destroy');
  const factory = vi.fn(() => client);
  const exit = vi.fn();
  const runtime = createRuntime({
    home, dbPath: ':memory:', filesDir: join(home, 'files'), host: '127.0.0.1', port: 0,
    toolsets: ['core'], apiId: 12345, apiHash: 'a'.repeat(32), writeLimits: {},
  }, { storage, clientFactory: factory, sessionSecret: secret, exit, fatalGraceMs: 10, log, limiter: { minIntervalMs: 0 } });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await runtime.close(); } };
  cleanups.push(close);
  return { network, client, sender, connect, getMe, destroy, factory, exit, runtime, close };
}

async function statusClient(runtime: Runtime) {
  const services = buildServices(runtime);
  const { server } = createMcpServer({ services, principal: services.access.principalOf('fixture_user'), toolsets: ['core'], version: 'test', log });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const sdk = new Client({ name: 'status-test', version: '1' });
  await server.connect(b);
  await sdk.connect(a);
  cleanups.push(async () => { await sdk.close(); await server.close(); });
  return async () => {
    const reply = await sdk.callTool({ name: 'tg_status', arguments: {} });
    return (reply.content as Array<{ type: string; text?: string }>).map(block => block.text ?? '').join('\n');
  };
}

describe('network loss and supervisor recovery', () => {
  it('reports lazy, connecting, connected and reconnecting states without status RPCs', async () => {
    const h = await harness();
    const status = await statusClient(h.runtime);
    expect(await status()).toContain('connection: not connected (lazy');
    expect(h.factory).not.toHaveBeenCalled();
    const ready = h.runtime.pool.getClient(account);
    expect(h.runtime.pool.connectionState(account)).toBe('connecting');
    await ready;
    expect(await status()).toContain('session active | connection: connected');
    h.network.failures = 2;
    h.sender.reconnect();
    expect(await status()).toContain('connection: reconnecting');
    await vi.advanceTimersByTimeAsync(10);
    expect(h.network.dials).toBe(4);
    expect(await status()).toContain('connection: connected');
    expect(h.getMe).toHaveBeenCalledTimes(1);
    expect(h.factory).toHaveBeenCalledTimes(1);
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('restarts after exhausted background retries even with no tool call pending', async () => {
    const h = await harness();
    const status = await statusClient(h.runtime);
    await h.runtime.pool.getClient(account);
    h.network.online = false;
    h.sender.reconnect();
    await vi.advanceTimersByTimeAsync(3100);
    expect(h.sender.lifecycle).toBe('dead');
    expect(h.network.dials).toBe(6);
    expect(h.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(await status()).toContain('session active | connection: gateway restart required');
    h.network.online = true;
    await expect(h.runtime.pool.getClient(account)).rejects.toMatchObject({ code: 'UNAVAILABLE', outcomeUnknown: false });
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.factory).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledTimes(1);

    // Model a supervisor restart: close the old owner before creating a new one.
    await h.close();
    expect(h.destroy).toHaveBeenCalledTimes(1);
    const next = await harness();
    await next.runtime.pool.getClient(account);
    expect(next.runtime.pool.connectionState(account)).toBe('connected');
    expect(next.network.dials).toBe(1);
    expect(next.exit).not.toHaveBeenCalled();
  });

  it('preserves an unknown in-flight write outcome and never replays it after network loss', async () => {
    const h = await harness();
    await h.runtime.pool.getClient(account);
    const invoke = vi.spyOn(h.client, 'invoke');
    const write = h.runtime.tg.invoke(account, new Api.messages.SendMessage({ peer: new Api.InputPeerSelf(), message: 'Synthetic fixture', randomId: bigInt.one }), { write: true });
    const failed = expect(write).rejects.toMatchObject({ code: 'UNAVAILABLE', outcomeUnknown: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sender.hasPendingWork).toBe(true);
    // Model the fake transport accepting the write, with its reply still pending.
    const wire = h.sender as unknown as { _queued: RequestState[]; _pendingState: { set(id: bigInt.BigInteger, state: RequestState): void } };
    const sent = wire._queued.shift()!;
    sent.msgId = bigInt.one;
    wire._pendingState.set(sent.msgId, sent);
    const queued = h.runtime.tg.invoke(account, new Api.messages.SendMessage({ peer: new Api.InputPeerSelf(), message: 'Never dispatched', randomId: bigInt(2) }), { write: true });
    const notSent = expect(queued).rejects.toMatchObject({ code: 'UNAVAILABLE', outcomeUnknown: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.runtime.tg.laneStatus(account).queued).toBe(1);
    h.network.online = false;
    h.sender.reconnect();
    await vi.advanceTimersByTimeAsync(3100);
    await failed;
    await notSent;
    h.network.online = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('does not restart during ordinary shutdown or an authorization-key recovery event', async () => {
    const h = await harness();
    await h.runtime.pool.getClient(account);
    // teleproto also emits broken before attempting an authorization-key reset.
    const { UpdateConnectionState } = await import('teleproto/network');
    _handleUpdate(h.client, new UpdateConnectionState(UpdateConnectionState.broken));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.runtime.pool.connectionState(account)).toBe('connected');
    await h.close();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('detects a terminal sender on reuse even if its failure event was missed', async () => {
    const h = await harness();
    await h.runtime.pool.getClient(account);
    await h.client.disconnect();
    expect(h.runtime.pool.connectionState(account)).toBe('restart_required');
    await expect(h.runtime.pool.getClient(account)).rejects.toMatchObject({ code: 'UNAVAILABLE', outcomeUnknown: false });
    await vi.advanceTimersByTimeAsync(20);
    expect(h.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(h.factory).toHaveBeenCalledTimes(1);
  });

  it('preserves an authoritative Telegram rejection instead of making its outcome unknown', async () => {
    const h = await harness();
    await h.runtime.pool.getClient(account);
    vi.spyOn(h.client, 'invoke').mockImplementationOnce(async () => {
      await h.client.disconnect();
      throw new Error('CHAT_WRITE_FORBIDDEN');
    });
    await expect(h.runtime.tg.invoke(account, new Api.help.GetConfig(), { write: true })).rejects.toMatchObject({ code: 'WRITE_FORBIDDEN', outcomeUnknown: false });
  });
});
