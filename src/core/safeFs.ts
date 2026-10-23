/**
 * Safe shared-directory operations. Agents read it under another OS
 * user, so the daemon treats its contents as untrusted:
 * never follow symlinks or modify other users' files. Otherwise a
 * malicious symlink could expose a session key as an image
 * or overwrite the daemon's `.env` through an export.
 * POSIX proves each directory with its owner and mode bits. Windows reports
 * no such bits, so SharedFiles attests directory ACLs instead (windowsAcl.ts).
 * readBoundedFile is the one reader for protected installer, state and profile files.
 */
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeSync, type BigIntStats, type Stats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { GatewayError } from './errors.js';
import { attestWindowsDirectories, type DirectoryAttestor } from './windowsAcl.js';

const uid = (): number => (typeof process.getuid === 'function' ? process.getuid() : -1);

function untrusted(path: string, why: string): GatewayError {
  return new GatewayError('UNAVAILABLE', `The gateway files directory is not safe to use: ${path} ${why}. The owner has to check who created it.`);
}

/** Existing nonsymlink directory owned by this process and not writable by others. Windows leaves owner and write access to the ACL attestation. */
function assertTrustedDir(path: string, windows: boolean): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw untrusted(path, 'is a symbolic link');
  if (!st.isDirectory()) throw untrusted(path, 'is not a directory');
  if (windows) return;
  if (uid() !== -1 && st.uid !== uid()) throw untrusted(path, 'belongs to another user');
  if ((st.mode & 0o022) !== 0) throw untrusted(path, 'is writable by other users');
}

/** Directories from `root` down to `path`, root first. */
function chainTo(path: string, root: string): string[] {
  const chain: string[] = [];
  for (let current = path; current.startsWith(root) && current.length >= root.length; current = dirname(current)) {
    chain.unshift(current);
    if (current === root) break;
  }
  if (chain[0] !== root) throw untrusted(path, 'is outside the files directory');
  return chain;
}

/** Create/check directories up to `root`; mode 755 lets agents read and only the daemon write. */
function ensureTrustedDir(path: string, root: string, windows: boolean): string[] {
  const chain = chainTo(path, root);
  // Create the shared directory and parents; it may be absent during development.
  mkdirSync(root, { recursive: true, mode: 0o755 });
  for (const dir of chain) {
    try {
      mkdirSync(dir, { mode: 0o755 });
      chmodSync(dir, 0o755);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    assertTrustedDir(dir, windows);
  }
  return chain;
}

/** Regular file owned by this process, not a symlink or another user's file. */
function isOwnRegularFile(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isFile() && (uid() === -1 || st.uid === uid());
  } catch {
    return false;
  }
}

/**
 * Open a new output file. Replace existing own files; reject other users'
 * files and symlinks. Never follow a symlink.
 */
function openNewFile(path: string, mode: number): number {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  try {
    return openSync(path, flags, mode);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    if (!isOwnRegularFile(path)) throw untrusted(path, 'exists and is not a file of the gateway');
    unlinkSync(path);
    return openSync(path, flags, mode);
  }
}

/**
 * Windows has no O_NOFOLLOW (the flag is undefined there): after the exclusive create, the handle must be an empty
 * single-link file and the path must name that same file, not a link to it.
 */
function openNewWindowsFile(path: string, mode: number): number {
  const fd = openNewFile(path, mode);
  try {
    const st = fstatSync(fd, { bigint: true }); const entry = lstatSync(path, { bigint: true });
    if (!st.isFile() || st.nlink !== 1n || st.size !== 0n || entry.isSymbolicLink() || entry.dev !== st.dev || entry.ino !== st.ino) {
      throw untrusted(path, 'is not a new file of the gateway');
    }
    return fd;
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

function readAll(fd: number, size: number): Buffer {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = readSync(fd, buffer, offset, size - offset, offset);
    if (read === 0) break;
    offset += read;
  }
  return buffer.subarray(0, offset);
}

/** Read an owned regular file without following links; null if absent, foreign, or oversized. */
function readOwnFile(path: string, maxBytes: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (uid() !== -1 && st.uid !== uid()) || st.size > maxBytes) return null;
    return readAll(fd, st.size);
  } finally {
    closeSync(fd);
  }
}

/** Windows read: the path names a regular file (not a link) and the opened handle is that same single-link file. */
function readWindowsFile(path: string, maxBytes: number): Buffer | null {
  let entry: BigIntStats;
  let fd: number;
  try {
    entry = lstatSync(path, { bigint: true });
    if (!entry.isFile()) return null;
    fd = openSync(path, constants.O_RDONLY);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.dev !== entry.dev || st.ino !== entry.ino || st.nlink !== 1n || st.size > BigInt(maxBytes)) return null;
    return readAll(fd, Number(st.size));
  } finally {
    closeSync(fd);
  }
}

export interface SharedFilesOptions {
  /** Windows directory ACL check; defaults to the fixed PowerShell helper. */
  attest?: DirectoryAttestor;
  /** Apply the Windows rules; defaults to the current platform. */
  windows?: boolean;
}

/**
 * The shared files directory for exports and media. POSIX checks owner and mode bits of every directory from the root
 * down on each use. Windows lstat-checks the same chain on each use (no symbolic link or junction) and attests the ACL
 * of each directory once per process and file identity, one helper process per batch of new directories, so the cost
 * follows directories rather than files. A directory replaced by another file identity is attested again.
 */
export class SharedFiles {
  private readonly windows: boolean;
  private readonly attest: DirectoryAttestor;
  /** `path`, NUL, `dev:ino` of every directory that passed the ACL check. */
  private readonly attested = new Set<string>();

  constructor(readonly root: string, options: SharedFilesOptions = {}) {
    this.windows = options.windows ?? process.platform === 'win32';
    this.attest = options.attest ?? attestWindowsDirectories;
  }

  /** Create and check every directory from the root to `path`. */
  async ensureDir(path: string): Promise<void> {
    const chain = ensureTrustedDir(path, this.root, this.windows);
    if (this.windows) await this.attestChain(chain);
  }

  /** Cache hit: an own regular file, never a link; on Windows a single-link file in attested directories. */
  async isOwnRegularFile(path: string): Promise<boolean> {
    if (!this.windows) return isOwnRegularFile(path);
    try {
      const st = lstatSync(path);
      if (!st.isFile() || st.nlink !== 1) return false;
      await this.attestExisting(dirname(path));
      return true;
    } catch {
      return false;
    }
  }

  /** New output file in checked directories. Replaces own files; never follows or replaces a link or another user's file. */
  async openNewFile(path: string, mode = 0o644): Promise<number> {
    await this.ensureDir(dirname(path));
    return this.windows ? openNewWindowsFile(path, mode) : openNewFile(path, mode);
  }

  async writeNewFile(path: string, data: Buffer, mode = 0o644): Promise<void> {
    const fd = await this.openNewFile(path, mode);
    try {
      writeSync(fd, data);
    } finally {
      closeSync(fd);
    }
    // Windows mode bits only toggle the read-only attribute.
    if (!this.windows) chmodSync(path, mode);
  }

  /** Own regular file without following links; null if absent, foreign, oversized or, on Windows, outside attested directories. */
  async readOwnFile(path: string, maxBytes: number): Promise<Buffer | null> {
    if (!this.windows) return readOwnFile(path, maxBytes);
    try {
      await this.attestExisting(dirname(path));
    } catch {
      return null;
    }
    return readWindowsFile(path, maxBytes);
  }

  /** Attest an existing chain without creating anything. */
  private async attestExisting(path: string): Promise<void> {
    const chain = chainTo(path, this.root);
    for (const dir of chain) assertTrustedDir(dir, true);
    await this.attestChain(chain);
  }

  private async attestChain(chain: readonly string[]): Promise<void> {
    const key = (dir: string): string => { const st = lstatSync(dir, { bigint: true }); return `${dir}\0${st.dev}:${st.ino}`; };
    const fresh = chain.map(dir => ({ dir, key: key(dir) })).filter(entry => !this.attested.has(entry.key));
    if (fresh.length === 0) return;
    const verdict = await this.attest(fresh.map(entry => entry.dir));
    if (verdict) throw untrusted(verdict.path, verdict.why);
    for (const entry of fresh) {
      // The helper must have seen the directory identity that is remembered.
      if (key(entry.dir) !== entry.key) throw untrusted(entry.dir, 'changed while it was checked');
      this.attested.add(entry.key);
    }
  }
}

/** Caller policy for readBoundedFile. Owners and mode bits apply on POSIX only; Windows callers attest through `attest`. */
export interface BoundedFilePolicy {
  /** Largest accepted size in bytes. */
  maximum: number;
  /** POSIX: accepted owner uids of the open file. */
  owners?: readonly number[];
  /** POSIX: mode bits that must be clear. */
  modeMask?: number;
  /** Path attestation (ACL, Windows security descriptor, tree listing) of the inode already open as `st`. */
  attest?: (path: string, st: Stats) => Promise<void>;
  /** Error for every policy failure. */
  fail: () => Error;
}

/**
 * Read a whole single-link regular file without following links or blocking on special files. The first lstat, the
 * open descriptor and, after `attest`, a second lstat must name the same device/inode; the read asks for one byte
 * beyond the descriptor size, so growth or shrinkage fails. Only the first lstat and open errors (ENOENT: absent)
 * propagate unchanged; a later ENOENT means the file changed and fails like every other check.
 */
export async function readBoundedFile(path: string, policy: BoundedFilePolicy): Promise<Buffer> {
  const same = (st: Stats, other: Stats): boolean => st.isFile() && !st.isSymbolicLink() && st.dev === other.dev && st.ino === other.ino;
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw policy.fail();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await file.stat(); const posix = process.platform !== 'win32';
    if (!same(st, before) || st.nlink !== 1 || st.size > policy.maximum
      || (posix && ((policy.owners && !policy.owners.includes(st.uid)) || (st.mode & (policy.modeMask ?? 0)) !== 0))) throw policy.fail();
    if (policy.attest) {
      try { await policy.attest(path, st); if (!same(await lstat(path), st)) throw policy.fail(); }
      catch (err) { throw (err as NodeJS.ErrnoException).code === 'ENOENT' ? policy.fail() : err; }
    }
    const bytes = Buffer.alloc(st.size + 1); const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== st.size) throw policy.fail();
    return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
}
