import { describe, expect, it } from 'vitest';
import { patchClientConfig, type ClientKind } from '../clientConfig.js';
import { parse as toml } from 'smol-toml';
import { parse as jsonc } from 'jsonc-parser';
import { parse as yaml, parseDocument } from 'yaml';
const token = 'synthetic_credential_012345678901234567890';
describe('private four-client transformations', () => {
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
