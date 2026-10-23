/** POSIX provisioning backend for an independently trusted root coordinator only. */
import { constants, type Stats } from 'node:fs';
import { lstat, open, chmod, readdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { acquireFileLease } from '../core/fileLease.js';
import { readBoundedFile } from '../core/safeFs.js';
import { attestAncestry, attestDirectory, attestFile, attestTree, newProtectedDirectory, ProtectionError, writeProtectedFile } from './posixPermissions.js';
import { createPosixIdentity } from './posixIdentity.js';
import { decodeApplicationArchive } from './archive.js';
import { verifyArtifact, verifyManifest, type ReleaseManifest } from './manifest.js';
import { serviceDefinition, type InstallLayout } from './platform.js';
import type { ProvisionBackend, ProvisionPlan, ProvisionReceipt, ServiceIdentity } from './provision.js';
import { SetupError } from '../setup/contract.js';
const run = promisify(execFile);

/** With `tree` (from attestTree), its recursive ACL listing replaces the per-file subprocess for listed inodes. */
function boundedRootFile(path: string, maximum: number, tree?: ReadonlyMap<string, Stats>): Promise<Buffer> {
  const attest = tree ? async (target: string, st: Stats): Promise<void> => {
    const listed = tree.get(target); if (!listed || listed.ino !== st.ino || listed.dev !== st.dev) throw new ProtectionError();
  } : attestFile;
  return readBoundedFile(path, { maximum, owners: [0], modeMask: 0o022, attest, fail: () => new ProtectionError() });
}

/** True when the attested prefix holds nothing but this installer's empty, root-private lease file. */
async function onlyProvisionLease(prefix: string): Promise<boolean> {
  await attestAncestry(prefix);
  const names = await readdir(prefix);
  if (names.some(name => name !== 'provision.lock')) return false;
  if (!names.length) return true;
  const lock = join(prefix, 'provision.lock'); const st = await lstat(lock);
  if (!st.isFile() || st.uid !== 0 || st.nlink !== 1 || st.size !== 0 || (st.mode & 0o077) !== 0) return false;
  await attestFile(lock, st); return true;
}

export class PosixProvisionBackend implements ProvisionBackend {
  private layout?: InstallLayout;
  private manifest?: ReleaseManifest;
  private application?: Buffer;
  private plan?: ProvisionPlan;
  private freshPrefix = false;
  /** initialTrust must attest the owner-established root verifier/code, not an agent claim. */
  constructor(private readonly candidate: string, private readonly initialTrust: () => Promise<void>) {}

  async attest(plan: ProvisionPlan, layout: InstallLayout): Promise<void> {
    if (process.getuid?.() !== 0 || process.platform !== layout.platform || layout.platform === 'win32') throw new ProtectionError();
    await this.initialTrust();
    await attestAncestry(resolve(this.candidate), true);
    const manifest = verifyManifest(await boundedRootFile(join(this.candidate, 'manifest.tsv'), 8192),
      await boundedRootFile(join(this.candidate, 'manifest.sig'), 384), await boundedRootFile(join(this.candidate, 'signer.der'), 16384),
      { signerSha256: plan.signer_sha256, version: '0.2.0', sourceSha: plan.source_sha, platform: layout.platform, architecture: process.arch as 'arm64' | 'x64' });
    for (const artifact of manifest.artifacts) {
      const bytes = await boundedRootFile(join(this.candidate, artifact.name), artifact.size); verifyArtifact(artifact, bytes);
      if (artifact.role === 'application') this.application = bytes;
    }
    if (!this.application) throw new ProtectionError();
    const decoded = decodeApplicationArchive(this.application);
    const metadata = decoded.find(f => f.path === 'package.json');
    if (!metadata || JSON.parse(metadata.data.toString('utf8')).version !== '0.2.0' || !decoded.some(f => f.path === 'dist/cli/index.js')) throw new ProtectionError();
    this.manifest = manifest; this.layout = layout; this.plan = plan;
    // Existing legacy/public prefixes cannot be adopted without explicit reviewed migration.
    try { await lstat('/opt/telegram-gateway-mcp'); throw new ProtectionError(); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    try { await attestDirectory(layout.prefix, [0]); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      await newProtectedDirectory(layout.prefix, 0, 0, 0o755);
      this.freshPrefix = true;
    }
  }
  private current(): InstallLayout { if (!this.layout || !this.manifest || !this.application) throw new ProtectionError(); return this.layout; }
  async withExclusive<T>(work: () => Promise<T>): Promise<T> {
    const lease = await acquireFileLease(this.current().prefix, 'provision.lock');
    try { return await work(); } finally { await lease.release(); }
  }
  async readReceipt(): Promise<unknown | null> {
    const prefix = this.current().prefix;
    try { return JSON.parse((await boundedRootFile(join(prefix, 'install.json'), 16384)).toString('utf8')) as unknown; }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // A first run that failed before its first receipt (for example in createIdentity) leaves only this
      // installer's empty lease file; any other content without a receipt needs owner review.
      if (this.freshPrefix || await onlyProvisionLease(prefix)) return null;
      throw new SetupError('invalid_state');
    }
  }
  async saveReceipt(receipt: ProvisionReceipt): Promise<void> {
    const path = join(this.current().prefix, 'install.json'); const temporary = `${path}.${receipt.plan.setup_id}.next`;
    await attestAncestry(this.current().prefix);
    try { await boundedRootFile(temporary, 16384); await unlink(temporary); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    const fd = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await fd.writeFile(JSON.stringify(receipt) + '\n'); await fd.sync(); } finally { await fd.close(); }
    await rename(temporary, path);
  }
  async createIdentity(layout: InstallLayout): Promise<ServiceIdentity> {
    // Without a receipt, an existing fixed account or group (foreign, or left by interrupted creation) needs owner review.
    try { return await createPosixIdentity(layout); } catch (err) { throw err instanceof ProtectionError ? new SetupError('invalid_state') : err; }
  }
  async installRelease(layout: InstallLayout): Promise<void> {
    const releases = dirname(layout.release);
    try { await attestDirectory(releases, [0]); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; await newProtectedDirectory(releases, 0, 0, 0o755); }
    const ensure = async (path: string): Promise<void> => {
      try { await attestAncestry(path); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        await newProtectedDirectory(path, 0, 0, 0o700);
      }
    };
    await ensure(layout.release);
    const node = this.manifest!.artifacts.find(a => a.role === 'node')!;
    const decoded = decodeApplicationArchive(this.application!);
    const expected = new Map<string, Buffer>([[layout.node, await boundedRootFile(join(this.candidate, node.name), node.size)],
      ...decoded.map(entry => [join(layout.application, entry.path), entry.data] as [string, Buffer])]);
    // On same-stage interruption, preserve matching files and reject unknown/corrupt state. One recursive ACL
    // listing covers the existing tree; directories are then remembered, so ancestry checks stay lstat-only.
    const existing = await attestTree(layout.release);
    const directories = new Set([layout.release]);
    for (const path of expected.keys()) {
      if (!path.startsWith(layout.release + '/')) throw new ProtectionError();
      for (let directory = dirname(path); !directories.has(directory); directory = dirname(directory)) directories.add(directory);
    }
    for (const [path, st] of existing) {
      if (st.isDirectory()) { if (!directories.has(path)) throw new ProtectionError(); continue; }
      const bytes = expected.get(path); if (!bytes || !(await boundedRootFile(path, bytes.length, existing)).equals(bytes)) throw new ProtectionError();
    }
    const ready = new Set([layout.release]);
    for (const [path, bytes] of expected) {
      if (existing.has(path)) continue;
      const parents: string[] = []; for (let directory = dirname(path); !ready.has(directory); directory = dirname(directory)) parents.unshift(directory);
      for (const directory of parents) { await ensure(directory); ready.add(directory); }
      await writeProtectedFile(dirname(path), basename(path), bytes, 0o600);
    }
    await chmod(layout.node, 0o755);
    const makeReadable = async (directory: string): Promise<void> => {
      for (const name of await readdir(directory)) {
        const path = join(directory, name); const st = await lstat(path);
        if (st.isSymbolicLink()) throw new ProtectionError();
        if (st.isDirectory()) { await makeReadable(path); await chmod(path, 0o755); }
        else if (st.isFile()) await chmod(path, path === join(layout.application, 'dist/native/lease-darwin') ? 0o755 : 0o644);
        else throw new ProtectionError();
      }
    };
    await makeReadable(layout.application); await chmod(layout.application, 0o755); await chmod(layout.release, 0o755);
  }
  async createState(layout: InstallLayout, identity: ServiceIdentity): Promise<void> {
    if (identity.kind !== 'posix') throw new ProtectionError();
    for (const [path, mode] of [[layout.state, 0o700], [layout.files, 0o755], [layout.logs, 0o700]] as const) {
      try { await attestDirectory(path, [identity.uid], mode === 0o700 ? 0o077 : 0o022); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; await newProtectedDirectory(path, identity.uid, identity.gid, mode); }
    }
  }
  async installDefinition(layout: InstallLayout, definition: string): Promise<void> {
    try { if (!(await boundedRootFile(layout.definition, 16384)).equals(Buffer.from(definition))) throw new ProtectionError(); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; await writeProtectedFile(dirname(layout.definition), basename(layout.definition), Buffer.from(definition), 0o644); }
  }
  async installCommands(layout: InstallLayout): Promise<void> {
    const commandDir = join(layout.prefix, 'bin');
    try { await attestAncestry(commandDir); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; await newProtectedDirectory(commandDir, 0, 0, 0o755); }
    const agent = this.agentCommand(layout, this.plan!.port);
    try { if (!(await boundedRootFile(join(commandDir, 'tg-mcp'), 16384)).equals(Buffer.from(agent))) throw new ProtectionError(); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; await writeProtectedFile(commandDir, 'tg-mcp', Buffer.from(agent), 0o755); }
    const owner = this.ownerCommand(layout);
    try { if (!(await boundedRootFile(join(commandDir, 'tg-mcp-owner'), 16384)).equals(Buffer.from(owner))) throw new ProtectionError(); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; await writeProtectedFile(commandDir, 'tg-mcp-owner', Buffer.from(owner), 0o755); }
  }
  private ownerCommand(layout: InstallLayout): string {
    const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
    return `#!/bin/sh\n[ "$#" -eq 1 ] && [ "$1" = setup ] || exit 1\nexec /usr/bin/env -u NODE_OPTIONS -u NODE_PATH -u NODE_USE_ENV_PROXY ${quote(layout.node)} ${quote(join(layout.application, 'dist/setup/ownerLauncher.js'))}\n`;
  }
  private agentCommand(layout: InstallLayout, port: number): string {
    const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
    const entry = join(layout.application, 'dist/cli/index.js');
    return `#!/bin/sh\ncase "$1" in help|version|stdio) ;; setup) case "$2" in preflight) ;; *) exit 1 ;; esac ;; *) exit 1 ;; esac\nexec /usr/bin/env -i PATH=/usr/bin:/bin TG_MCP_TOKEN="\${TG_MCP_TOKEN-}" TG_MCP_URL="\${TG_MCP_URL-http://127.0.0.1:${port}/mcp}" ${quote(layout.node)} ${quote(entry)} "$@"\n`;
  }
  async inspect(receipt: ProvisionReceipt, layout: InstallLayout): Promise<boolean> {
    try {
      await attestAncestry(layout.prefix);
      const identity = receipt.identity;
      if (receipt.completed.includes('identity')) {
        if (!identity || identity.kind !== 'posix') return false;
        const uid = Number((await run('/usr/bin/id', ['-u', layout.account], { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, timeout: 1000 })).stdout.trim());
        if (uid !== identity.uid) return false;
        const gid = Number((await run('/usr/bin/id', ['-g', layout.account], { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, timeout: 1000 })).stdout.trim());
        if (gid !== identity.gid || gid === 0) return false;
        const group = process.platform === 'darwin'
          ? (await run('/usr/bin/dscl', ['.', '-read', `/Groups/${layout.account}`, 'PrimaryGroupID'], { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, timeout: 1000 })).stdout.trim().split(/\s+/).at(-1)
          : (await run('/usr/bin/getent', ['group', layout.account], { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, timeout: 1000 })).stdout.trim().split(':')[2];
        if (Number(group) !== identity.gid) return false;
      }
      if (receipt.completed.includes('release')) {
        await attestAncestry(layout.release); const tree = await attestTree(layout.release);
        const node = this.manifest!.artifacts.find(a => a.role === 'node')!;
        verifyArtifact(node, await boundedRootFile(layout.node, node.size, tree));
        for (const entry of decodeApplicationArchive(this.application!)) {
          const bytes = await boundedRootFile(join(layout.application, entry.path), entry.data.length, tree);
          if (createHash('sha256').update(bytes).digest('hex') !== createHash('sha256').update(entry.data).digest('hex')) return false;
        }
      }
      if (receipt.completed.includes('state')) {
        if (!identity || identity.kind !== 'posix') return false;
        await attestDirectory(layout.state, [identity.uid], 0o077); await attestDirectory(layout.logs, [identity.uid], 0o077); await attestDirectory(layout.files, [identity.uid]);
      }
      if (receipt.completed.includes('definition')) {
        const definition = await boundedRootFile(layout.definition, 16_384);
        if (!definition.equals(Buffer.from(serviceDefinition(layout, receipt.plan.port)))) return false;
      }
      if (receipt.completed.includes('commands')) {
        await attestAncestry(join(layout.prefix, 'bin'));
        const command = join(layout.prefix, 'bin', 'tg-mcp');
        if (!(await boundedRootFile(command, 16384)).equals(Buffer.from(this.agentCommand(layout, receipt.plan.port))) || ((await lstat(command)).mode & 0o111) !== 0o111) return false;
        const owner = join(layout.prefix, 'bin', 'tg-mcp-owner');
        if (!(await boundedRootFile(owner, 16384)).equals(Buffer.from(this.ownerCommand(layout))) || ((await lstat(owner)).mode & 0o111) !== 0o111) return false;
      }
      return true;
    } catch { return false; }
  }
}
