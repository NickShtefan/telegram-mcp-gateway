/** Fresh bounded SDK proof, distinct from model/provider tool loading. Never return private tool content. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { withTimeout } from '../core/time.js';
export async function probeConfiguredGateway(port: number, token: string): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) return false;
  const client = new Client({ name: 'telegram-gateway-owner-setup', version: '0.2.0' });
  try {
    await withTimeout(client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } })), 10000, 'MCP initialize');
    const catalog = await withTimeout(client.listTools(), 10000, 'MCP tools/list');
    if (!catalog.tools.some(tool => tool.name === 'tg_status') || catalog.tools.some(tool => ['tg_send', 'tg_reply', 'tg_confirm', 'tg_join'].includes(tool.name))) return false;
    const status = await withTimeout(client.callTool({ name: 'tg_status', arguments: {} }), 10000, 'MCP status');
    return status.isError !== true;
  } catch { return false; }
  finally { await withTimeout(client.close(), 5000, 'MCP close').catch(() => undefined); }
}
