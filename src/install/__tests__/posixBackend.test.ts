import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readdirSync, symlinkSync, existsSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PosixProvisionBackend } from '../posixBackend.js';
import { ProtectionError } from '../posixPermissions.js';
import { encodeApplicationArchive, type ApplicationFile } from '../archive.js';
import { installLayout, type InstallLayout } from '../platform.js';
import { provision, type ProvisionPlan, type ProvisionReceipt } from '../provision.js';

// Count the fixed ACL utility subprocesses while still running the real system tools.
const spawned = vi.hoisted(() => [] as string[]);
const identity = vi.hoisted(() => ({ create: async (): Promise<unknown> => ({ kind: 'posix', uid: 450, gid: 450 }) }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const real = promisify(actual.execFile);
  const execFile = Object.assign((...args: unknown[]) => (actual.execFile as (...a: unknown[]) => unknown)(...args),
    { [promisify.custom]: (file: string, args: string[], options: object) => { spawned.push(file); return real(file, args, options); } });
  return { ...actual, execFile };
});
vi.mock('../posixIdentity.js', () => ({ createPosixIdentity: () => identity.create() }));

const sha = 'c'.repeat(40);
const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
const plan: ProvisionPlan = { format_version: 1, setup_id: '12345678-1234-4234-8234-123456789012', source_sha: sha, signer_sha256: 'b'.repeat(64), platform, port: 7777 };

describe('POSIX identity outcomes', () => {
  it('reports an existing fixed account or group as invalid_state and passes tool failures through', async () => {
    const backend = new PosixProvisionBackend('/nonexistent', async () => undefined);
    identity.create = async () => { throw new ProtectionError(); };
    await expect(backend.createIdentity(installLayout(platform, sha))).rejects.toMatchObject({ code: 'invalid_state' });
    identity.create = async () => { throw new Error('synthetic tool failure'); };
    await expect(backend.createIdentity(installLayout(platform, sha))).rejects.toThrow('synthetic tool failure');
  });
});

/** Release-like application: nested directories under dist and small files spread over all of them. */
function application(directories: number, files: number): ApplicationFile[] {
  const dirs = ['dist']; for (let i = 1; i < directories; i++) dirs.push(`${dirs[Math.floor((i - 1) / 3)]}/d${i}`);
  return Array.from({ length: files }, (_, i) => ({ path: `${dirs[i % dirs.length]}/f${i}.js`, data: Buffer.from(`file ${i}\n`) }));
}
function fixture(base: string, files: ApplicationFile[]): { backend: PosixProvisionBackend; layout: InstallLayout } {
  const candidate = join(base, 'candidate'); mkdirSync(candidate, { mode: 0o755 });
  const node = Buffer.from('synthetic node runtime'); writeFileSync(join(candidate, 'node'), node, { mode: 0o644 });
  const prefix = join(base, 'prefix'); mkdirSync(prefix, { mode: 0o755 }); const release = join(prefix, 'releases', sha);
  const layout: InstallLayout = { ...installLayout(platform, sha), prefix, release, node: join(release, 'node'), application: join(release, 'application') };
  const backend = new PosixProvisionBackend(candidate, async () => undefined);
  Object.assign(backend, { layout, plan, application: encodeApplicationArchive(files),
    manifest: { artifacts: [{ role: 'node', name: 'node', size: node.length, sha256: createHash('sha256').update(node).digest('hex') }] } });
  return { backend, layout };
}
const released: ProvisionReceipt = { format_version: 1, plan, completed: ['release'], identity: null };
function acl(path: string, add: boolean): void {
  if (process.platform === 'darwin') execFileSync('/bin/chmod', add ? ['+a', 'user:nobody allow write', path] : ['-N', path]);
  else execFileSync('/usr/bin/setfacl', add ? ['-m', 'u:nobody:r', path] : ['-b', path]);
}

// Root-only provisioning needs a disposable container: TG_MCP_ROOT_TESTS=1 as uid 0 (see docs/install-platforms.md).
describe.skipIf(process.getuid?.() !== 0 || process.env.TG_MCP_ROOT_TESTS !== '1' || !['darwin', 'linux'].includes(process.platform))('root-owned provisioning', () => {
  let base: string;
  beforeEach(() => { base = mkdtempSync(join(homedir(), 'tg-mcp-root-')); spawned.length = 0; });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('installs, verifies and resumes a release with ACL subprocesses per new directory, not per file', async () => {
    const { backend, layout } = fixture(base, application(40, 600));
    await backend.installRelease(layout);
    expect(spawned.length).toBeGreaterThanOrEqual(41); expect(spawned.length).toBeLessThanOrEqual(41 + 10);
    spawned.length = 0; expect(await backend.inspect(released, layout)).toBe(true); expect(spawned).toHaveLength(1);
    spawned.length = 0; await backend.installRelease(layout); expect(spawned.length).toBeLessThanOrEqual(3);
    expect(readdirSync(join(layout.application, 'dist')).sort()).toEqual(['d1', 'd2', 'd3', ...Array.from({ length: 15 }, (_, i) => `f${i * 40}.js`)].sort());
  }, 30_000); // About 640 files with per-file fsync; parallel root runs have exceeded the 10 s default.
  it('rejects ACLs, symlinks, unexpected and corrupt files on inspection and resume', async () => {
    const { backend, layout } = fixture(base, application(10, 50)); await backend.installRelease(layout);
    const file = join(layout.application, 'dist', 'd1', 'f1.js'); const extra = join(layout.application, 'dist', 'extra.js');
    const mutations: [string, () => void, () => void, boolean][] = [
      ['nested ACL', () => { acl(file, true); expect(lstatSync(file).mode & 0o022).toBe(0); }, () => acl(file, false), false],
      ['directory ACL', () => acl(join(layout.application, 'dist'), true), () => acl(join(layout.application, 'dist'), false), false],
      ['symlink', () => symlinkSync('/etc/hosts', extra), () => rmSync(extra), false],
      ['unexpected file', () => writeFileSync(extra, 'x', { mode: 0o644 }), () => rmSync(extra), true],
      ['corrupt file', () => writeFileSync(file, 'file 2\n'), () => writeFileSync(file, 'file 1\n'), false],
      ['group-writable file', () => chmodSync(file, 0o664), () => chmodSync(file, 0o644), false],
    ];
    for (const [name, apply, undo, inspected] of mutations) {
      apply();
      expect(await backend.inspect(released, layout), name).toBe(inspected);
      await expect(backend.installRelease(layout), name).rejects.toThrow();
      undo(); expect(await backend.inspect(released, layout), name).toBe(true);
    }
  });
  it('resumes a first run that failed before its first receipt, and leaves other receipt-less state to the owner', async () => {
    const events: string[] = []; const run = join(base, 'run'); mkdirSync(run, { mode: 0o755 });
    const { backend: first, layout } = fixture(run, application(2, 2));
    Object.assign(first, { freshPrefix: true, attest: async () => undefined, inspect: async () => true,
      installRelease: async () => { events.push('release'); }, createState: async () => { events.push('state'); },
      installDefinition: async () => { events.push('definition'); }, installCommands: async () => { events.push('commands'); } });
    identity.create = async () => { throw new Error('synthetic useradd failure'); };
    expect((await provision(plan, first)).error_code).toBe('adapter_failed');
    expect(readdirSync(layout.prefix)).toEqual(['provision.lock']);
    // A retry finds the existing prefix (freshPrefix stays false) holding only the lease file.
    const retry = new PosixProvisionBackend(join(run, 'candidate'), async () => undefined); Object.assign(retry, { ...first, freshPrefix: false });
    identity.create = async () => ({ kind: 'posix', uid: 450, gid: 450 });
    expect(await provision(plan, retry)).toMatchObject({ phase: 'needs_api_credentials', error_code: null });
    expect(events).toEqual(['release', 'state', 'definition', 'commands']);
    expect(existsSync(join(layout.prefix, 'install.json'))).toBe(true);
    const lock = join(layout.prefix, 'provision.lock');
    for (const [name, apply, expected] of [
      ['stray file', () => writeFileSync(join(layout.prefix, 'stray'), ''), 'invalid_state'],
      ['readable lease', () => chmodSync(lock, 0o644), 'invalid_state'],
      ['non-empty lease', () => writeFileSync(lock, 'x'), 'invalid_state'],
      ['lease only', () => undefined, null],
      ['empty prefix', () => rmSync(lock), null],
    ] as const) {
      rmSync(layout.prefix, { recursive: true }); mkdirSync(layout.prefix, { mode: 0o755 }); writeFileSync(lock, '', { mode: 0o600 }); apply();
      const read = retry.readReceipt();
      if (expected) await expect(read, name).rejects.toMatchObject({ code: expected }); else expect(await read, name).toBeNull();
    }
  });
});
