import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preflight, type PreflightProbe } from '../preflight.js';
import { main } from '../../cli/main.js';
import type { CliIo } from '../../cli/io.js';

const probe = (overrides: Partial<PreflightProbe> = {}): PreflightProbe => ({
  platform: 'darwin', architecture: 'arm64', darwinMajor: 22, installation: vi.fn(async () => 'absent' as const),
  portAvailable: vi.fn(async () => true), clientConfiguration: vi.fn(async () => 'present' as const), ...overrides,
});
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function directory(): string { const dir = mkdtempSync(join(tmpdir(), 'tg-setup-')); directories.push(dir); return dir; }

describe('read-only preflight and CLI', () => {
  it('uses safe defaults and never inspects a client when none is selected', async () => {
    const p = probe();
    const result = await preflight({ port: 7777, client: 'none' }, p);
    expect(result).toMatchObject({ phase: 'preflight_ready', runtime: 'installer_managed', artifact: 'requires_verified_package', client_configuration: 'not_selected', defaults: { toolsets: ['core'], private_chats: 'closed', writes: 'disabled' } });
    expect(p.clientConfiguration).not.toHaveBeenCalled();
  });
  it.each([
    [{ platform: 'linux' }, 'unsupported_platform'],
    [{ darwinMajor: 21 }, 'unsupported_os_version'],
    [{ architecture: 'ia32' }, 'unsupported_architecture'],
    [{ installation: async () => 'legacy' as const }, 'existing_installation_requires_review'],
    [{ portAvailable: async () => false }, 'port_unavailable'],
  ] as const)('rejects unsafe/unavailable prerequisites', async (overrides, code) => {
    const result = await preflight({ port: 7777, client: 'none' }, probe(overrides));
    expect(result).toMatchObject({ phase: 'failed', error_code: code });
  });
  it('does not expose inspection errors or paths', async () => {
    const result = await preflight({ port: 7777, client: 'codex' }, probe({ clientConfiguration: async () => { throw new Error('fixture-secret https://fixture_user:fixture_password@example.invalid'); } }));
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
    expect(result.error_code).toBe('inspection_failed');
  });
  it.each(['codex', 'claude', 'opencode', 'hermes'] as const)('allows selected client %s without assuming its config path', async client => {
    const p = probe({ clientConfiguration: async () => 'not_inspected' });
    expect(await preflight({ port: 7777, client }, p)).toMatchObject({ phase: 'preflight_ready', client, client_configuration: 'not_inspected' });
  });
  it('bypasses config, database, credentials and IO prompts even with secret environment inputs', async () => {
    const root = directory();
    const home = join(root, 'must-not-exist');
    const out: string[] = []; const err: string[] = [];
    const io: CliIo = { out: s => out.push(s), err: s => err.push(s), prompt: vi.fn(async () => { throw new Error('unexpected prompt'); }) };
    expect(await main(['setup', 'preflight', '--json'], { io, env: { TG_MCP_HOME: home, TG_API_HASH: 'fixture-secret' }, setup: { probe: probe() } })).toBe(0);
    expect(readdirSync(root)).toEqual([]);
    expect(io.prompt).not.toHaveBeenCalled();
    expect(out.join('')).not.toContain('fixture-secret');
    expect(err).toEqual([]);
  });
  it.each([['--port', 'fixture-secret'], ['--client', 'fixture-secret'], ['--fixture-secret']])('redacts parse errors', async (...args) => {
    const lines: string[] = []; const io: CliIo = { out: s => lines.push(s), err: s => lines.push(s), prompt: vi.fn() };
    expect(await main(['setup', 'preflight', ...args], { io })).toBe(1);
    expect(lines.join('')).not.toContain('fixture-secret');
    expect(lines).toEqual(['{"format_version":1,"error_code":"invalid_request"}']);
  });
});
