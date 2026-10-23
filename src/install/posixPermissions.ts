/** Attest complete ancestry and reject ACLs conservatively before privileged file work. */
import { lstat, mkdir, chmod, chown, open, readdir, rename, unlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const runFile = promisify(execFile);
export class ProtectionError extends Error { constructor() { super('protection_unverified'); } }

/** 'system': any ACL fails. 'home' (the original user's profile): on macOS deny-only ACEs such as the default
 *  "group:everyone deny delete" on home folders pass and allow ACEs fail, including inherited read grants; on Linux
 *  any extended entry fails. */
export type AclPolicy = 'system' | 'home';
/** One fixed utility call covers a path or, with `tree` (system policy), the path and every entry below it. macOS
 *  `ls -e` prints every ACE; Linux `getfacl -s` prints only entries with extended or default ACLs. Other platforms fail. */
export async function aclAccepted(path: string, policy: AclPolicy, tree = false): Promise<boolean> {
  const options = { env: { PATH: '/usr/bin:/bin' }, maxBuffer: tree ? 33_554_432 : 8192, timeout: tree ? 60_000 : 5000 };
  if (process.platform === 'darwin') {
    // Headers in a recursive listing are absolute paths, so only ACE lines and mode strings can match.
    const { stdout } = await runFile('/bin/ls', [tree ? '-leaR' : '-lde', path], options);
    return policy === 'home' ? !/\n\s*\d+:.*\ballow\b/.test(stdout) : !/^\s*\d+:/m.test(stdout) && !/^[-a-z][-rwxsStT]{9}\+/m.test(stdout);
  }
  if (process.platform === 'linux') {
    const { stdout } = await runFile('/usr/bin/getfacl', tree ? ['-R', '-s', '-P', '-p', path] : ['-cp', path], options);
    return tree ? stdout.trim() === '' : stdout.split('\n').every(line => !line || /^(user::[rwx-]{3}|group::[rwx-]{3}|other::[rwx-]{3})$/.test(line));
  }
  return false;
}
async function noAcl(path: string, tree = false): Promise<void> { if (!await aclAccepted(path, 'system', tree)) throw new ProtectionError(); }

// Only root can change the mode, ACL or entries of a root-owned directory without group/other write. Once
// its ACL check passes within an attested ancestry, later walks in this process still lstat it (type,
// owner, mode, device/inode) but skip the repeated subprocess; a different inode is checked again.
const sealed = new Map<string, string>();
const identity = (st: Stats): string => `${st.dev}:${st.ino}`;
async function directory(path: string, owners: readonly number[], modeMask: number, remember: boolean): Promise<void> {
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || !owners.includes(st.uid) || (st.mode & modeMask) !== 0) { sealed.delete(path); throw new ProtectionError(); }
  const key = remember && st.uid === 0 && (st.mode & 0o022) === 0 ? identity(st) : undefined;
  if (key && sealed.get(path) === key) return;
  try { await noAcl(path); } catch (err) { sealed.delete(path); throw err; }
  if (key) sealed.set(path, key);
}

/** Correlate the path ACL with the already-open regular inode; parent attestation prevents replacement. */
export async function attestFile(path: string, descriptor: Stats): Promise<void> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.ino !== descriptor.ino || before.dev !== descriptor.dev) throw new ProtectionError();
  await noAcl(path);
  const after = await lstat(path);
  if (!after.isFile() || after.ino !== descriptor.ino || after.dev !== descriptor.dev || after.uid !== descriptor.uid || after.mode !== descriptor.mode) throw new ProtectionError();
}

export async function attestDirectory(path: string, owners: readonly number[], modeMask = 0o022): Promise<void> {
  await directory(resolve(path), owners, modeMask, false);
}
export async function attestAncestry(path: string, allowSystemTemporary = false): Promise<void> {
  for (let current = resolve(path); ; current = dirname(current)) {
    let mask = 0o022;
    if (allowSystemTemporary && ['/tmp', '/private/tmp'].includes(current)) { const st = await lstat(current); if (st.uid === 0 && (st.mode & 0o1000) !== 0) mask = 0; }
    await directory(current, [0], mask, true); if (current === '/') break;
  }
}
/** Attest every entry below `root` with one recursive ACL listing (the caller attests the root's ancestry):
 *  owners only, no group/other write, directories and single-link regular files only. Returns lstat by path. */
export async function attestTree(root: string, owners: readonly number[] = [0], limit = 20_000): Promise<Map<string, Stats>> {
  const top = resolve(root); const st = await lstat(top);
  if (!st.isDirectory() || st.isSymbolicLink() || !owners.includes(st.uid) || (st.mode & 0o022) !== 0) throw new ProtectionError();
  const entries = new Map<string, Stats>();
  const walk = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const path = join(directory, name); const entry = await lstat(path);
      if (entries.size >= limit || !owners.includes(entry.uid) || (entry.mode & 0o022) !== 0) throw new ProtectionError();
      entries.set(path, entry);
      if (entry.isDirectory()) await walk(path);
      else if (!entry.isFile() || entry.nlink !== 1) throw new ProtectionError();
    }
  };
  await walk(top); await noAcl(top, true);
  // Below a remembered (ancestry-attested) root, listed root-sealed directories extend the remembered chain.
  if (sealed.get(top) === identity(st)) for (const [path, entry] of entries) if (entry.isDirectory() && entry.uid === 0) sealed.set(path, identity(entry));
  return entries;
}
/** Never recursively chmod/chown preexisting or foreign trees. */
export async function newProtectedDirectory(path: string, uid: number, gid: number, mode: number): Promise<void> {
  await attestAncestry(dirname(path));
  await mkdir(path, { mode: 0o700 });
  await chown(path, uid, gid); await chmod(path, mode);
  await directory(resolve(path), [uid], 0o022, true);
}
/** Root creates the file with O_EXCL in an attested ACL-free directory, so it inherits no ACL entries. */
export async function writeProtectedFile(directory: string, name: string, bytes: Buffer, mode: number): Promise<void> {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new ProtectionError();
  await attestAncestry(directory);
  const temporary = join(directory, `${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    await file.writeFile(bytes); await file.sync(); await file.close();
    // No overwrite: existing definitions/commands need an explicit verified resume path.
    try { await lstat(join(directory, name)); throw new ProtectionError(); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await rename(temporary, join(directory, name));
  } finally { await file.close(); await unlink(temporary).catch(() => undefined); }
}
