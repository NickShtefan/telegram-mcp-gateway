import { afterEach, describe, expect, it } from 'vitest';
import { makeTestGateway } from '../../__tests__/helpers/gateway.js';
import { startHttpServer, type RunningHttpServer } from '../../transport/http.js';
import { createLogger } from '../../core/log.js';
import { probeConfiguredGateway } from '../clientProbe.js';
let server: RunningHttpServer | undefined;
afterEach(async () => { await server?.close(); server=undefined; });
describe('fresh SDK proof', () => {
  it('checks an authenticated core catalog/status and rejects an invalid credential', async () => {
    const gateway = makeTestGateway();
    server = await startHttpServer({services:gateway.services,host:'127.0.0.1',port:0,toolsets:['core'],version:'test',log:createLogger('test',{level:'silent'})});
    try {
      expect(await probeConfiguredGateway(server.port,gateway.tokens.user_a)).toBe(true);
      expect(await probeConfiguredGateway(server.port,'wrong'.repeat(10))).toBe(false);
    } finally { gateway.storage.close(); }
  });
  it('does not accept a write-enabled endpoint as the default core installation', async () => {
    const gateway=makeTestGateway();server=await startHttpServer({services:gateway.services,host:'127.0.0.1',port:0,toolsets:['core','write'],version:'test',log:createLogger('test',{level:'silent'})});
    try { expect(await probeConfiguredGateway(server.port,gateway.tokens.user_a)).toBe(false); }
    finally { gateway.storage.close(); }
  });
  it('verifies the selected managed catalog for each profile, including after write access is removed', async () => {
    const gw = makeTestGateway();
    server = await startHttpServer({ services: gw.services, host: '127.0.0.1', port: 0, toolsets: ['core'], ownerToolsets: true,
      version: 'test', log: createLogger('test', { level: 'silent' }) });
    try {
      gw.storage.users.update('user_a', { managedWrites: true });
      expect(await probeConfiguredGateway(server.port, gw.tokens.user_a, true)).toBe(true);
      expect(await probeConfiguredGateway(server.port, gw.tokens.user_a, false)).toBe(false);
      expect(await probeConfiguredGateway(server.port, gw.tokens.user_b, false)).toBe(true);
      gw.storage.users.update('user_a', { managedWrites: false });
      expect(await probeConfiguredGateway(server.port, gw.tokens.user_a, true)).toBe(false);
      expect(await probeConfiguredGateway(server.port, gw.tokens.user_a, false)).toBe(true);
    } finally { gw.cleanup(); }
  });
});
