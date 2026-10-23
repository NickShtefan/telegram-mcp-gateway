/**
 * Test gateway with real services, in-memory storage, and fake Telegram.
 * Two users, each with a personal account and one shared account.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { addUser } from '../../cli/admin.js';
import type { GatewayConfig } from '../../core/config.js';
import { seal } from '../../core/crypto.js';
import { createLogger } from '../../core/log.js';
import { createMcpServer } from '../../mcp/server.js';
import type { Runtime } from '../../runtime.js';
import { buildServices, type GatewayServices } from '../../services/index.js';
import { SqliteStorage } from '../../storage/sqlite.js';
import { FakeTg } from './fakeTg.js';

export interface TestGateway {
  home: string;
  config: GatewayConfig;
  storage: SqliteStorage;
  tg: FakeTg;
  services: GatewayServices;
  tokens: { user_a: string; user_b: string };
  /** MCP client connected to the user's in-memory server. */
  client(userId: 'user_a' | 'user_b', toolsets?: string[]): Promise<TestClient>;
  cleanup(): void;
}

export interface ToolReply {
  text: string;
  isError: boolean;
  images: number;
}

export interface TestClient {
  call(name: string, args?: Record<string, unknown>): Promise<ToolReply>;
  tools(): Promise<Array<{ name: string; description?: string; annotations?: Record<string, unknown>; inputSchema: Record<string, unknown> }>>;
  instructions(): string | undefined;
  close(): Promise<void>;
}

export function makeTestGateway(options: { now?: () => number; writeLimits?: GatewayConfig['writeLimits'] } = {}): TestGateway {
  const home = mkdtempSync(join(tmpdir(), 'tgmcp-gw-'));
  const storage = new SqliteStorage({ path: ':memory:' });
  const tg = new FakeTg(storage.entities);
  const log = createLogger('test', { level: 'silent' });
  const config: GatewayConfig = {
    home,
    dbPath: ':memory:',
    filesDir: join(home, 'files'),
    host: '127.0.0.1',
    port: 0,
    toolsets: ['core'],
    apiId: 1,
    apiHash: 'hash',
    writeLimits: options.writeLimits ?? {},
  };

  const user_a = addUser(storage, { id: 'user_a', accounts: ['user_a', 'agent'] });
  const user_b = addUser(storage, { id: 'user_b', accounts: ['user_b', 'agent'] });
  for (const id of ['user_a', 'user_b', 'agent']) {
    storage.accounts.upsert({ id, status: 'active', username: `${id}_acc`, tgUserId: '1001' });
    storage.sessions.put(id, seal('session', 'secret'));
  }
  storage.users.update('user_a', { defaultAccount: 'agent' });

  const runtime = { config, storage, tg, log, pool: { connectionState: () => 'not_connected' }, close: async () => undefined } as unknown as Runtime;
  // Windows ACL attestation of the files directory is a fake here; core/__tests__/sharedFiles.test.ts runs the real one.
  const services = buildServices(runtime, { now: options.now, attestDirectories: async () => null });

  return {
    home,
    config,
    storage,
    tg,
    services,
    tokens: { user_a: user_a.token, user_b: user_b.token },
    client: async (userId, toolsets = ['core']) => {
      const { server } = createMcpServer({ services, principal: services.access.principalOf(userId), toolsets, version: 'test', log, now: options.now });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test-agent', version: '1.0.0' });
      await server.connect(serverSide);
      await client.connect(clientSide);
      return {
        call: async (name, args = {}) => {
          const result = (await client.callTool({ name, arguments: args })) as {
            content?: Array<{ type: string; text?: string }>;
            isError?: boolean;
          };
          const content = result.content ?? [];
          return {
            text: content
              .filter(c => c.type === 'text')
              .map(c => c.text ?? '')
              .join('\n'),
            isError: result.isError === true,
            images: content.filter(c => c.type === 'image').length,
          };
        },
        tools: async () => (await client.listTools()).tools as never,
        instructions: () => client.getInstructions(),
        close: async () => {
          await client.close();
          await server.close();
        },
      };
    },
    cleanup: () => {
      services.jobs.stop();
      storage.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
