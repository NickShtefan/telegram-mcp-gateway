import { mkdtempSync, mkdirSync, openSync, closeSync, fstatSync, writeFileSync, chmodSync, rmSync, symlinkSync, linkSync, renameSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir, tmpdir, userInfo } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aclAccepted, attestAncestry, attestFile, attestTree, newProtectedDirectory, writeProtectedFile } from '../posixPermissions.js';

// Count the fixed ACL utility subprocesses while still running the real system tools.
const spawned = vi.hoisted(() => [] as string[]);
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const real = promisify(actual.execFile);
  const execFile = Object.assign((...args: unknown[]) => (actual.execFile as (...a: unknown[]) => unknown)(...args),
    { [promisify.custom]: (file: string, args: string[], options: object) => { spawned.push(file); return real(file, args, options); } });
  return { ...actual, execFile };
});

const posix = process.platform === 'darwin' || process.platform === 'linux';
const aclTools = process.platform === 'darwin' || existsSync('/usr/bin/setfacl');
function grant(path: string, inherit = false): void {
  if (process.platform === 'darwin') execFileSync('/bin/chmod', ['+a', `user:${userInfo().username} allow ${inherit ? 'list,file_inherit,directory_inherit' : 'write'}`, path]);
  // A Linux ACL mask is mirrored in the group mode bits, so grant read only to keep the mode check passing.
  else execFileSync('/usr/bin/setfacl', inherit ? ['-d', '-m', 'u:nobody:rx', path] : ['-m', 'u:nobody:r', path]);
}
function revoke(path: string): void { execFileSync(process.platform === 'darwin' ? '/bin/chmod' : '/usr/bin/setfacl', process.platform === 'darwin' ? ['-N', path] : ['-b', path]); }
/** Release-like names (archive paths allow [A-Za-z0-9_@.+/-]) in a nested tree below a parent with a space. */
function tree(base: string, directories = 6, files = 24): { root: string; paths: string[] } {
  const root = join(base, 'Application Support', 'tree'); mkdirSync(root, { recursive: true, mode: 0o755 });
  const dirs = [root]; for (let i = 1; i < directories; i++) { const dir = join(dirs[Math.floor((i - 1) / 2)]!, `@scope+d${i}.x`); mkdirSync(dir, { mode: 0o755 }); dirs.push(dir); }
  const paths = Array.from({ length: files }, (_, i) => join(dirs[i % dirs.length]!, `f-${i}_v1.0+b.js`));
  for (const path of paths) { writeFileSync(path, path); chmodSync(path, 0o644); }
  return { root, paths };
}

describe.skipIf(process.platform !== 'darwin')('macOS protected-file ACL attestation', () => {
  it('rejects an explicit write ACE even when Unix mode remains 0644', async () => {
    const root=mkdtempSync(join(tmpdir(),'tg-acl-'));const path=join(root,'candidate');let fd: number|undefined;
    try {
      writeFileSync(path,'synthetic verified bytes');chmodSync(path,0o644);fd=openSync(path,'r');
      await expect(attestFile(path,fstatSync(fd))).resolves.toBeUndefined();
      execFileSync('/bin/chmod',['+a',`user:${userInfo().username} allow write`,path]);
      expect(fstatSync(fd).mode&0o777).toBe(0o644);
      await expect(attestFile(path,fstatSync(fd))).rejects.toThrow('protection_unverified');
    } finally {if(fd!==undefined)closeSync(fd);rmSync(root,{recursive:true,force:true})}
  });
});

describe.skipIf(!posix || !aclTools)('ACL policies', () => {
  it('system paths reject any ACE; home paths accept only macOS deny ACEs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-acl-policy-'));
    const both = async (): Promise<boolean[]> => [await aclAccepted(dir, 'system'), await aclAccepted(dir, 'home')];
    try {
      expect(await both()).toEqual([true, true]);
      if (process.platform === 'darwin') {
        // The default ACE on macOS home folders.
        execFileSync('/bin/chmod', ['+a', 'group:everyone deny delete', dir]);
        expect(await both()).toEqual([false, true]);
      }
      grant(dir); expect(await both()).toEqual([false, false]);
      revoke(dir); expect(await both()).toEqual([true, true]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe.skipIf(!posix)('tree attestation with one ACL subprocess', () => {
  let base: string; const uid = process.getuid?.() ?? -1;
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'tg-tree-')); spawned.length = 0; });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it.skipIf(!aclTools)('lists every entry once and fails closed on an ACL anywhere in the tree', async () => {
    const { root, paths } = tree(base, 12, 120);
    expect((await attestTree(root, [uid])).size).toBe(131);
    expect(spawned).toEqual([process.platform === 'darwin' ? '/bin/ls' : '/usr/bin/getfacl']);
    for (const [target, inherit] of [[paths[77]!, false], [join(paths[77]!, '..'), true], [root, false]] as const) {
      grant(target, inherit); spawned.length = 0;
      await expect(attestTree(root, [uid])).rejects.toThrow('protection_unverified');
      expect(spawned).toHaveLength(1); revoke(target);
    }
    await expect(attestTree(root, [uid])).resolves.toBeInstanceOf(Map);
  });
  it.skipIf(process.platform !== 'darwin')('detects ACEs when an extended-attribute marker hides the ACL marker', async () => {
    const { root, paths } = tree(base);
    execFileSync('/usr/bin/xattr', ['-w', 'org.example.synthetic', 'value', paths[3]!]); grant(paths[3]!);
    expect(execFileSync('/bin/ls', ['-le', paths[3]!]).toString()).toMatch(/^\S{10}@/);
    await expect(attestTree(root, [uid])).rejects.toThrow('protection_unverified');
  });
  it('rejects links, special files, foreign owners, group/other write and oversized trees before listing ACLs', async () => {
    const cases: [string, (root: string, paths: string[]) => void, number?, number?][] = [
      ['symlink', (_root, paths) => symlinkSync('/etc', `${paths[5]}.link`)],
      ['hard link', (_root, paths) => linkSync(paths[5]!, `${paths[5]}.second`)],
      ['fifo', (_root, paths) => execFileSync('/usr/bin/mkfifo', [`${paths[5]}.fifo`])],
      ['group-writable file', (_root, paths) => chmodSync(paths[5]!, 0o664)],
      ['other-writable directory', (_root, paths) => chmodSync(join(paths[5]!, '..'), 0o757)],
      ['foreign owner', () => undefined, uid + 1],
      ['limit', () => undefined, uid, 10],
    ];
    for (const [name, mutate, owner = uid, limit = 20_000] of cases) {
      rmSync(join(base, 'Application Support'), { recursive: true, force: true }); const { root, paths } = tree(base); mutate(root, paths);
      await expect(attestTree(root, [owner], limit), name).rejects.toThrow('protection_unverified');
    }
    expect(spawned).toEqual([]);
  });
});

// Root-only attestation needs a disposable container: TG_MCP_ROOT_TESTS=1 as uid 0 (see docs/install-platforms.md).
describe.skipIf(!posix || process.getuid?.() !== 0 || process.env.TG_MCP_ROOT_TESTS !== '1')('remembered root-sealed ancestry', () => {
  let base: string;
  beforeEach(() => { base = mkdtempSync(join(homedir(), 'tg-mcp-root-')); spawned.length = 0; });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('checks each directory ACL once, then rechecks only changed inodes or unsafe modes', async () => {
    const leaf = join(base, 'a', 'b', 'c'); mkdirSync(leaf, { recursive: true, mode: 0o755 });
    await attestAncestry(leaf); expect(spawned.length).toBeGreaterThanOrEqual(4);
    spawned.length = 0; await attestAncestry(leaf); expect(spawned).toEqual([]);
    chmodSync(join(base, 'a', 'b'), 0o775);
    await expect(attestAncestry(leaf)).rejects.toThrow('protection_unverified'); expect(spawned).toEqual([]);
    chmodSync(join(base, 'a', 'b'), 0o755); await attestAncestry(leaf); expect(spawned).toHaveLength(1);
    // A different inode at a remembered path is listed again, so its ACL is found.
    const other = join(base, 'a', 'b', 'other'); mkdirSync(other, { mode: 0o755 }); grant(other);
    renameSync(leaf, join(base, 'a', 'b', 'old')); renameSync(other, leaf); spawned.length = 0;
    await expect(attestAncestry(leaf)).rejects.toThrow('protection_unverified'); expect(spawned).toHaveLength(1);
  });
  it('extends the remembered chain through created directories and attested trees', async () => {
    await attestAncestry(base); spawned.length = 0;
    const created = join(base, 'created'); await newProtectedDirectory(created, 0, 0, 0o755); expect(spawned).toHaveLength(1);
    mkdirSync(join(created, 'x', 'y'), { recursive: true, mode: 0o755 });
    for (let i = 0; i < 50; i++) await writeProtectedFile(join(created, 'x', 'y'), `f${i}.js`, Buffer.from(String(i)), 0o644);
    expect(spawned).toHaveLength(3);
    spawned.length = 0; await attestTree(created); await attestAncestry(join(created, 'x', 'y')); expect(spawned).toHaveLength(1);
    grant(join(created, 'x', 'y', 'f7.js')); spawned.length = 0;
    await expect(attestTree(created)).rejects.toThrow('protection_unverified'); expect(spawned).toHaveLength(1);
  });
});
