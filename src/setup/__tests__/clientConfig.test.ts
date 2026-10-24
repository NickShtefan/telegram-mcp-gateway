import { describe, expect, it } from 'vitest';
import { patchClientConfig, configuredGatewayToken, clientRelativePath, type ClientKind } from '../clientConfig.js';
import { parse as toml } from 'smol-toml';
import { parse as jsonc } from 'jsonc-parser';
import { parse as yaml, parseDocument } from 'yaml';
const token = 'synthetic_credential_012345678901234567890';
describe('private client transformations', () => {
  it.each(['cursor','openclaw'] as const)('adds the default %s HTTP profile while preserving unrelated bytes and other servers',client=>{
    const source=client==='cursor'?'{// preserve\n"budget":9007199254740993,"mcpServers":{"other":{"url":"https://example.test"}}}'
      :'{// preserve\n"budget":9007199254740993,"mcp":{"parallel":true,"servers":{"other":{"url":"https://example.test"}}}}';
    const result=patchClientConfig(client,source,7777,token);const parsed=jsonc(result);
    const servers=client==='cursor'?parsed.mcpServers:parsed.mcp.servers;
    expect(servers.telegram_gateway).toMatchObject({url:'http://127.0.0.1:7777/mcp',headers:{Authorization:'Bearer '+token}});
    if(client==='openclaw'){expect(servers.telegram_gateway.transport).toBe('streamable-http');expect(parsed.mcp.parallel).toBe(true);}
    expect(result).toMatch(/"budget"\s*:\s*9007199254740993/);expect(result).toContain('// preserve');expect(servers.other.url).toBe('https://example.test');
    expect(configuredGatewayToken(client,result,7777)).toBe(token);expect(patchClientConfig(client,result,7777,token)).toBe(result);
    expect(()=>patchClientConfig(client,result,8888,token)).toThrow('client_entry_conflict');
    expect(patchClientConfig(client,result,8888,token,true)).toContain('127.0.0.1:8888');
    expect(clientRelativePath(client)).toEqual(client==='cursor'?['.cursor','mcp.json']:['.openclaw','openclaw.json']);
  });
  it('refuses full JSON5 and indirect OpenClaw profiles instead of rewriting them',()=>{
    for(const source of ['{mcp:{servers:{}}}','{"$include":"other.json"}','{"mcp":{"servers":{"$include":"other.json"}}}'])expect(()=>patchClientConfig('openclaw',source,7777,token)).toThrow('invalid_state');
  });
  it.each(['codex', 'claude', 'opencode', 'hermes'] as ClientKind[])('adds %s and repeats without changing unrelated settings', client => {
    const source = client === 'codex' ? '# preserve\nmodel = "owner-model"\n[mcp_servers.other]\nurl = "https://example.test"\n'
      : client === 'hermes' ? '# preserve\nmodel: owner-model\nmcp_servers:\n  other:\n    url: https://example.test\n'
      : client === 'opencode' ? '{// preserve\n"model":"owner-model", "mcp":{"other":{"type":"remote","url":"https://example.test"}}}'
      : '{"model":"owner-model", "mcpServers":{"other":{"type":"http","url":"https://example.test"}}}';
    const result = patchClientConfig(client, source, 7777, token);
    const parsed = client === 'codex' ? toml(result) : client === 'hermes' ? yaml(result) : jsonc(result);
    expect(parsed.model).toBe('owner-model'); expect(result).toContain('https://example.test');
    if (client !== 'claude') expect(result).toContain('# preserve'.replace('#', client === 'opencode' ? '//' : '#'));
    expect(patchClientConfig(client, result, 7777, token)).toBe(result);
  });
  it('preserves exact unrelated TOML, including multiline markers and integers', () => {
    const source = 'budget=9007199254740993\nnote="""\n[mcp_servers.fake]\nquoted text\n"""\n';
    const result = patchClientConfig('codex', source, 7777, token);
    expect(result.startsWith(source)).toBe(true);
    const changed = patchClientConfig('codex', result, 8888, token, true);
    expect(changed.startsWith(source)).toBe(true); expect(changed).toContain('127.0.0.1:8888');
  });
  it('rejects unapproved replacement and unowned TOML entries', () => {
    const source = patchClientConfig('codex', '', 7777, token);
    expect(() => patchClientConfig('codex', source, 8888, token)).toThrow('client_entry_conflict');
    expect(() => patchClientConfig('codex', '[mcp_servers.telegram_gateway]\nurl="http://other.test"', 7777, token, true)).toThrow('invalid_state');
  });
  it('rejects malformed and duplicate-key JSON rather than damaging existing configuration', () => {
    for (const source of ['{oops', '{"mcp":{},"mcp":{}}', '{"mcp":[]}']) expect(() => patchClientConfig('opencode', source, 7777, token)).toThrow('invalid_state');
  });
  it('rejects YAML aliases and unknown tags rather than modifying shared or custom structures', () => {
    for (const source of ['shared: &map {}\nmcp_servers: *map\n', 'model: !custom owner\n']) expect(() => patchClientConfig('hermes', source, 7777, token)).toThrow('invalid_state');
  });
  it('rejects credential/header injection and oversized input with fixed errors', () => {
    expect(() => patchClientConfig('claude', '{}', 7777, token+'\r\nX-Key: injected')).toThrow('invalid_state');
    expect(() => patchClientConfig('claude', ' '.repeat(1048577), 7777, token)).toThrow('invalid_state');
  });
});

describe('exact Hermes preservation',()=>{
  it('keeps decimal and hexadecimal integers outside the safe Number range',()=>{
    const source='# retain\nbudget: 9007199254740993\nhex_budget: 0x20000000000001\n';
    const result=patchClientConfig('hermes',source,7777,token);
    const parsed=parseDocument(result,{intAsBigInt:true}).toJS();
    expect(parsed.budget).toBe(9007199254740993n);expect(parsed.hex_budget).toBe(9007199254740993n);expect(result).toContain('# retain');
  });
});
