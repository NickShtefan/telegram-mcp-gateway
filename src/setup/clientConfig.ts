/** Private client configuration transformation. Never print input, rendered configuration or bearer values. */
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import { applyEdits, modify, parseTree, getNodeValue, type Node, type ParseError } from 'jsonc-parser';
import { isMap, parseDocument } from 'yaml';
import { z } from 'zod';
import { SetupError } from './contract.js';

export type ClientKind = 'codex' | 'claude' | 'opencode' | 'hermes';
export class ClientEntryConflict extends Error { constructor() { super('client_entry_conflict'); } }
export const CLIENT_SERVER = 'telegram_gateway';
const begin = '# BEGIN Telegram MCP Gateway managed entry v1';
const end = '# END Telegram MCP Gateway managed entry v1';
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,256}$/);
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function semantic(value: unknown, depth = 0): unknown {
  if (depth > 128) throw new SetupError('invalid_state');
  if (Array.isArray(value)) return value.map(item => semantic(item, depth + 1));
  if (object(value) && !(value instanceof Date)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, semantic(item, depth + 1)]));
  return value;
}
function equal(a: unknown, b: unknown): boolean { return isDeepStrictEqual(semantic(a), semantic(b)); }
function entry(client: ClientKind, port: number, token: string): Record<string, unknown> {
  const url = `http://127.0.0.1:${port}/mcp`; const header = { Authorization: `Bearer ${token}` };
  if (client === 'codex') return { url, enabled: true, http_headers: header };
  if (client === 'claude') return { type: 'http', url, headers: header };
  if (client === 'opencode') return { type: 'remote', url, enabled: true, oauth: false, headers: header };
  return { url, enabled: true, headers: header };
}
function serverPath(client: ClientKind): string { return client === 'claude' ? 'mcpServers' : client === 'opencode' ? 'mcp' : 'mcp_servers'; }
function existing(root: unknown, client: ClientKind): unknown {
  if (!object(root)) throw new SetupError('invalid_state');
  const servers = root[serverPath(client)];
  if (servers === undefined) return undefined;
  if (!object(servers)) throw new SetupError('invalid_state');
  return Object.hasOwn(servers, CLIENT_SERVER) ? servers[CLIENT_SERVER] : undefined;
}
function withoutGateway(root: unknown, client: ClientKind): unknown {
  if (!object(root)) throw new SetupError('invalid_state');
  const copy = { ...root }; const key = serverPath(client);
  if (object(copy[key])) {
    const servers = { ...copy[key] }; delete servers[CLIENT_SERVER];
    if (Object.keys(servers).length) copy[key] = servers; else delete copy[key];
  }
  return copy;
}
function checkedJson(text: string, comments: boolean): { root: Record<string, unknown>; tree: Node } {
  const errors: ParseError[] = [];
  const tree = parseTree(text || '{}', errors, { disallowComments: !comments, allowTrailingComma: comments });
  if (!tree || errors.length || tree.type !== 'object') throw new SetupError('invalid_state');
  const pending: Array<{ node: Node; depth: number }> = [{ node: tree, depth: 0 }]; let count = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++count > 100000 || depth > 128) throw new SetupError('invalid_state');
    if (node.type === 'object') {
      const names = new Set<string>();
      for (const child of node.children ?? []) { const name = child.children?.[0]?.value as string; if (names.has(name)) throw new SetupError('invalid_state'); names.add(name); }
    }
    for (const child of node.children ?? []) pending.push({ node: child, depth: depth + 1 });
  }
  return { root: getNodeValue(tree) as Record<string, unknown>, tree };
}
/** Pure secret-bearing transformation; replacement is a separate explicit human selection. */
export function patchClientConfig(client: ClientKind, original: string, port: number, token: string, replace = false): string {
  try {
    if (!['codex', 'claude', 'opencode', 'hermes'].includes(client) || Buffer.byteLength(original) > 1048576 || !Number.isInteger(port) || port < 1 || port > 65535) throw new SetupError('invalid_request');
    tokenSchema.parse(token); const desired = entry(client, port, token);
    let before: unknown; let after: unknown; let rendered: string;
    if (client === 'codex') {
      before = parseToml(original, { integersAsBigInt: true });
      const prior = existing(before, client); if (equal(prior, desired)) return original;
      let prefix = original;
      if (prior !== undefined) {
        if (!replace) throw new ClientEntryConflict();
        // Only replace our terminal managed block. Never serialize unrelated
        // TOML or guess sections from brackets embedded in strings/comments.
        const marker = `\n${begin}\n`; const start = original.indexOf(marker);
        if (start < 0 || start !== original.lastIndexOf(marker) || !original.endsWith(`${end}\n`)) throw new SetupError('invalid_state');
        prefix = original.slice(0, start);
        if (existing(parseToml(prefix, { integersAsBigInt: true }), client) !== undefined) throw new SetupError('invalid_state');
      }
      rendered = `${prefix}\n${begin}\n[mcp_servers.${CLIENT_SERVER}]\nurl = ${JSON.stringify(desired.url)}\nenabled = true\nhttp_headers = { Authorization = ${JSON.stringify(`Bearer ${token}`)} }\n${end}\n`;
      after = parseToml(rendered, { integersAsBigInt: true });
    } else if (client === 'hermes') {
      const document = parseDocument(original || '{}', { prettyErrors: false, uniqueKeys: true, intAsBigInt: true });
      if (document.errors.length || document.warnings.length || !isMap(document.contents)) throw new SetupError('invalid_state');
      before = document.toJS({ maxAliasCount: 0 });
      const prior = existing(before, client); if (equal(prior, desired)) return original;
      if (prior !== undefined && !replace) throw new ClientEntryConflict();
      const servers = document.get('mcp_servers', true);
      if (servers !== undefined && !isMap(servers)) throw new SetupError('invalid_state');
      document.setIn(['mcp_servers', CLIENT_SERVER], desired);
      rendered = document.toString(); after = parseDocument(rendered, { prettyErrors: false, intAsBigInt: true }).toJS({ maxAliasCount: 0 });
    } else {
      before = checkedJson(original, client === 'opencode').root;
      const prior = existing(before, client); if (equal(prior, desired)) return original;
      if (prior !== undefined && !replace) throw new ClientEntryConflict();
      rendered = applyEdits(original || '{}', modify(original || '{}', [serverPath(client), CLIENT_SERVER], desired,
        { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
      after = checkedJson(rendered, client === 'opencode').root;
    }
    if (Buffer.byteLength(rendered) > 1048576 || !equal(existing(after, client), desired)
      || !equal(withoutGateway(before, client), withoutGateway(after, client))) throw new SetupError('invalid_state');
    return rendered;
  } catch (err) { if (err instanceof ClientEntryConflict) throw err; throw new SetupError('invalid_state'); }
}
/** User-level default profiles only. Caller attests the actual owner home and effective overrides. */
export function clientRelativePath(client: ClientKind): string[] {
  if (client === 'codex') return ['.codex', 'config.toml'];
  if (client === 'claude') return ['.claude.json'];
  if (client === 'opencode') return ['.config', 'opencode', 'opencode.json'];
  return ['.hermes', 'config.yaml'];
}
/** Reuse only this gateway's selected default-profile HTTP credential, never unrelated keys. */
export function configuredGatewayToken(client: ClientKind, text: string, port: number): string | null {
  try {
    if (Buffer.byteLength(text) > 1048576) return null;
    const root = client === 'codex' ? parseToml(text, { integersAsBigInt: true })
      : client === 'hermes' ? parseDocument(text, { prettyErrors: false, intAsBigInt: true }).toJS({ maxAliasCount: 0 })
      : checkedJson(text, client === 'opencode').root;
    const server = existing(root, client);
    if (!object(server) || server.url !== `http://127.0.0.1:${port}/mcp`) return null;
    const headers = server[client === 'codex' ? 'http_headers' : 'headers'];
    if (!object(headers) || typeof headers.Authorization !== 'string' || !headers.Authorization.startsWith('Bearer ')) return null;
    const token = headers.Authorization.slice(7); return tokenSchema.safeParse(token).success ? token : null;
  } catch { return null; }
}
