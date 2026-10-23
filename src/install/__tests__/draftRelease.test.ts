import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, X509Certificate, verify, constants } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { ARTIFACT_ROLES, encodeManifest } from '../manifest.js';
import { crc32, decodeReleaseTar } from '../releasePackage.js';
const { prepareDraft, failureRecord } = await import(pathToFileURL(resolve('scripts/release/draft.mjs')).href);
const { signCandidates } = await import(pathToFileURL(resolve('scripts/release/batch-sign.mjs')).href);
const { TARGETS, REPOSITORY, assetNames, installCommands } = await import(pathToFileURL(resolve('scripts/release/plan.mjs')).href);
const { runtimeEntry } = await import(pathToFileURL(resolve('scripts/install/runtime-entry.mjs')).href);

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const sourceSha = 'c'.repeat(40), run = '38175635260', base = `repos/${REPOSITORY}`;
// GitHub artifact downloads are deflated ZIPs; build them from synthetic payloads only.
function zip(entries: Map<string, Buffer>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name), packed = deflateRawSync(data), crc = crc32(data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8); h.writeUInt32LE(crc, 14); h.writeUInt32LE(packed.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc, 16); c.writeUInt32LE(packed.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    local.push(h, n, packed); central.push(c, n); offset += h.length + n.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.size, 8); end.writeUInt16LE(entries.size, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
interface Fixture { calls: string[][]; releases: string; created?: string[]; corrupt?: boolean }
function ciFixture() {
  const jobs: { id: number; name: string; conclusion: string }[] = [], artifacts: { id: number; name: string; expired: boolean; digest: string }[] = [];
  const logs = new Map<string, string>(), zips = new Map<string, Buffer>();
  (TARGETS as [string, 'darwin' | 'linux' | 'win32', 'arm64' | 'x64', string][]).forEach(([runner, platform, architecture, label], i) => {
    const names = [platform === 'win32' ? 'node.exe' : 'node', 'installer.mjs', 'manifest.mjs', 'archive.mjs', 'application.tar.gz', 'NODE_LICENSE'];
    const payloads = names.map(name => Buffer.from(`synthetic ${label} ${name}\n`));
    const manifest = encodeManifest({ version: '0.2.0', sourceSha, platform, architecture, nodeVersion: '24.21.0', artifacts: ARTIFACT_ROLES.map((role, j) => ({ role, name: names[j]!, size: payloads[j]!.length, sha256: sha(payloads[j]!) })) });
    const bytes = zip(new Map([['manifest.tsv', manifest], ...names.map((name, j): [string, Buffer] => [name, payloads[j]!]), ['runtime-record.json', Buffer.from('{}\n')]]));
    jobs.push({ id: 700 + i, name: `unsigned-candidates (${runner})`, conclusion: 'success' });
    artifacts.push({ id: 900 + i, name: `unsigned-${runner}-${sourceSha}`, expired: false, digest: `sha256:${sha(bytes)}` });
    logs.set(String(700 + i), `2026-10-12T00:00:00Z ${JSON.stringify({ format_version: 1, phase: 'unsigned_candidate_created', source_sha: sourceSha, manifest_sha256: sha(manifest) })}\n`);
    zips.set(String(900 + i), bytes);
  });
  jobs.push({ id: 1, name: 'source-checks', conclusion: 'success' });
  return { jobs, artifacts, logs, zips };
}
// Fake GitHub CLI: answers read-only API calls from fixtures and records a draft creation.
function fakeGh(state: Fixture, tag: string) {
  const ci = ciFixture();
  return (args: string[], binary = false): string | Buffer => {
    state.calls.push(args);
    if (args[0] === 'release') { state.created = args; return 'https://github.com/example/draft\n'; }
    if (args[0] === 'api' && args[1] === '--paginate' && args[2] === `${base}/releases?per_page=100`) return state.releases;
    const endpoint = args[1] ?? '';
    if (endpoint === `${base}/actions/runs/${run}`) return JSON.stringify({ head_sha: sourceSha, status: 'completed', conclusion: 'success', path: '.github/workflows/platform-checks.yml' });
    if (endpoint === `${base}/actions/runs/${run}/jobs?per_page=100`) return JSON.stringify({ total_count: ci.jobs.length, jobs: ci.jobs });
    if (endpoint === `${base}/actions/runs/${run}/artifacts?per_page=100`) return JSON.stringify({ total_count: ci.artifacts.length, artifacts: ci.artifacts });
    if (endpoint === `${base}/git/ref/tags/${tag}`) throw Object.assign(new Error('Command failed: gh api'), { stderr: 'gh: Not Found (HTTP 404)' });
    const log = endpoint.match(/\/actions\/jobs\/(\d+)\/logs$/); if (log) return ci.logs.get(log[1]!)!;
    const artifact = endpoint.match(/\/actions\/artifacts\/(\d+)\/zip$/);
    if (artifact && binary) { const bytes = Buffer.from(ci.zips.get(artifact[1]!)!); if (state.corrupt) bytes[40] = bytes[40]! ^ 1; return bytes; }
    throw new Error('unexpected_fake_call');
  };
}
const git = (args: string[]): string => args[0] === 'rev-parse' ? `${sourceSha}\n` : '';

describe.skipIf(process.platform === 'win32')('owner draft preparation with fake GitHub and disposable keys', () => {
  let root: string, keyPath: string, certificatePath: string, signerSha256: string, certificate: X509Certificate;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'tg-draft-fixture-'));
    keyPath = join(root, 'fixture-key.pem'); certificatePath = join(root, 'fixture-cert.pem'); const pass = join(root, 'fixture-pass');
    writeFileSync(pass, 'fixture-only', { mode: 0o600 });
    execFileSync('/usr/bin/openssl', ['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:3072', '-aes-256-cbc', '-pass', 'file:' + pass, '-out', keyPath], { stdio: 'ignore' });
    chmodSync(keyPath, 0o600);
    execFileSync('/usr/bin/openssl', ['req', '-new', '-x509', '-key', keyPath, '-passin', 'file:' + pass, '-days', '1', '-out', certificatePath, '-subj', '/CN=Synthetic Draft Fixture'], { stdio: 'ignore' });
    certificate = new X509Certificate(readFileSync(certificatePath)); signerSha256 = sha(certificate.raw);
  }, 30000);
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  it('dry run verifies all five candidates and writes pinned notes without a key or a release', async () => {
    const state: Fixture = { calls: [], releases: 'v0.1.9\n' }, output = join(root, 'dry');
    const result = await prepareDraft({ sha: sourceSha, run, repo: REPOSITORY, tag: 'v0.2.0-test.1', output, dryRun: true }, { gh: fakeGh(state, 'v0.2.0-test.1'), git });
    expect(result).toMatchObject({ phase: 'draft_release_dry_run', source_sha: sourceSha, output, signed: false, created: false, published: false });
    expect(state.calls.some(c => c[0] === 'release')).toBe(false);
    const names = assetNames('v0.2.0-test.1');
    expect(result.assets).toEqual([...TARGETS.map((t: string[]) => names.archive(t[3])), names.posixBootstrap, names.windowsBootstrap, names.checksums]);
    expect(readdirSync(output).filter(name => name.startsWith('telegram-mcp-gateway-'))).toEqual([]);
    for (const [, , , label] of TARGETS) expect(readdirSync(join(output, label)).sort()).not.toContain('manifest.sig');
    const notes = readFileSync(join(output, 'RELEASE-NOTES.md'), 'utf8');
    expect(notes).toContain('# Test draft v0.2.0-test.1');expect(notes).toContain(`Source commit: \`${sourceSha}\``);
    expect(notes).toContain(`telegram-mcp-gateway-0.2.0-test.1-macos-arm64.tar.gz" ${sourceSha}\n`);
    expect(notes).toContain(`-SourceSha '${sourceSha}' -Install`);
  });

  it('signs, packages, checksums and creates only a draft with eight tag-named assets', async () => {
    const state: Fixture = { calls: [], releases: 'v0.2.0-test.1\n' }, output = join(root, 'final');let prompts = 0;
    const sign = (candidates: unknown[], source: string) => signCandidates(candidates, { sourceSha: source, keyPath, certificatePath, signerPin: signerSha256, prompt: async () => { prompts++; return 'fixture-only'; } });
    const result = await prepareDraft({ sha: sourceSha, run, repo: REPOSITORY, tag: 'v0.2.0', output, signerSha256 }, { gh: fakeGh(state, 'v0.2.0'), git, sign });
    expect(result).toMatchObject({ phase: 'draft_release_created', source_sha: sourceSha, tag: 'v0.2.0', output, release_url: 'https://github.com/example/draft', published: false });
    expect(prompts).toBe(1);
    const args = state.created!;expect(args.slice(0, 8)).toEqual(['release', 'create', 'v0.2.0', '--repo', REPOSITORY, '--target', sourceSha, '--draft']);
    expect(args).not.toContain('--publish');
    const assets = args.slice(args.indexOf('--notes-file') + 2), names = assetNames('v0.2.0');
    expect(assets.map(path => basename(path))).toEqual([...TARGETS.map((t: string[]) => names.archive(t[3])), names.posixBootstrap, names.windowsBootstrap, names.checksums]);
    for (const [, platform, , label] of TARGETS) {
      const file = join(output, names.archive(label));
      const read = (name: string): Buffer => platform === 'win32' ? runtimeEntry(file, name, 134217728, true) : decodeReleaseTar(readFileSync(file)).get(name)!;
      expect(verify('sha256', read('manifest.tsv'), { key: certificate.publicKey, padding: constants.RSA_PKCS1_PADDING }, read('manifest.sig'))).toBe(true);
      expect(read('signer.der')).toEqual(certificate.raw);
    }
    expect(readFileSync(join(output, names.posixBootstrap))).toEqual(readFileSync(resolve('scripts/install/bootstrap-posix.sh')));
    expect(readFileSync(join(output, names.windowsBootstrap))).toEqual(readFileSync(resolve('scripts/install/bootstrap-windows.ps1')));
    expect(readFileSync(join(output, names.checksums), 'utf8')).toBe(assets.slice(0, 7).map(path => `${sha(readFileSync(path))}  ${basename(path)}\n`).join(''));
    const notes = readFileSync(args[args.indexOf('--notes-file') + 1]!, 'utf8');
    const bootstrapSha256 = { posix: sha(readFileSync(resolve('scripts/install/bootstrap-posix.sh'))), windows: sha(readFileSync(resolve('scripts/install/bootstrap-windows.ps1'))) };
    for (const command of installCommands({ repo: REPOSITORY, tag: 'v0.2.0', sourceSha, bootstrapSha256, download: 'gh' })) expect(notes).toContain(command.text);
    expect(notes).toContain(signerSha256);expect(notes).not.toContain('Test draft');
  }, 30000);

  it('rejects an existing draft with the same tag before downloading anything', async () => {
    const state: Fixture = { calls: [], releases: 'v0.1.0\nv0.2.0\n' }, progress = { stage: 'plan' };
    await expect(prepareDraft({ sha: sourceSha, run, repo: REPOSITORY, tag: 'v0.2.0', dryRun: true }, { gh: fakeGh(state, 'v0.2.0'), git }, progress)).rejects.toThrow('release_already_exists');
    expect(state.calls.some(c => /\/(zip|logs)$/.test(c[1] ?? ''))).toBe(false);
    expect(failureRecord(new Error('release_already_exists'), progress)).toEqual({ format_version: 1, error_code: 'release_already_exists', stage: 'ci', published: false });
  });

  it('reports a safe error code and the output directory after a failed download', async () => {
    const state: Fixture = { calls: [], releases: '', corrupt: true }, progress: { stage: string; output?: string } = { stage: 'plan' }, output = join(root, 'corrupt');
    const error = await prepareDraft({ sha: sourceSha, run, repo: REPOSITORY, tag: 'v0.2.0', output, dryRun: true }, { gh: fakeGh(state, 'v0.2.0'), git }, progress).catch((e: Error) => e);
    expect(failureRecord(error, progress)).toEqual({ format_version: 1, error_code: 'ci_artifact_digest_mismatch', stage: 'download', output, published: false });
    expect(existsSync(output)).toBe(true);
    const system = Object.assign(new Error('ENOENT: no such file, open /private/key.pem'), { code: 'ENOENT' });
    expect(failureRecord(system, { stage: 'sign', output })).toEqual({ format_version: 1, error_code: 'draft_release_failed', cause: 'ENOENT', stage: 'sign', output, published: false });
  });

  it('validates the plan before any Git or GitHub access and has no personal key default', async () => {
    const touched = () => { throw new Error('must_not_run'); };
    await expect(prepareDraft({ sha: sourceSha, run: '25', repo: REPOSITORY, tag: 'v0.2.0', dryRun: true }, { gh: touched, git: touched })).rejects.toThrow('ci_run_id_required');
    await expect(prepareDraft({ sha: sourceSha, run, repo: REPOSITORY, tag: 'v0.2.0' }, { gh: touched, git: touched })).rejects.toThrow('signing_paths_required');
    await expect(prepareDraft({ sha: sourceSha, run, repo: REPOSITORY, tag: 'v0.2.0-' }, { gh: touched, git: touched })).rejects.toThrow('invalid_release_tag');
    const cli = spawnSync(process.execPath, [resolve('scripts/release/draft-release.mjs'), '--sha', sourceSha, '--run', '25', '--dry-run'], { encoding: 'utf8', timeout: 20000 });
    expect(cli.status).toBe(1);expect(JSON.parse(cli.stderr)).toEqual({ format_version: 1, error_code: 'ci_run_id_required', stage: 'plan', published: false });
    expect(readFileSync(resolve('scripts/release/draft-release.mjs'), 'utf8')).not.toMatch(/\/Users\/|KEYS/);
  });
});
