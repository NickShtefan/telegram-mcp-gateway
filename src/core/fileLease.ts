/** POSIX kernel lease on a permanent inode. Never unlink it to recover from a crash. */
import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GatewayError } from './errors.js';
import { sleep } from './time.js';
import { acquireWindowsLease, isWindowsLeaseHeld } from './windowsLease.js';

export interface FileLease { release(): Promise<void>; }
export class FileLeaseBusyError extends GatewayError {
  constructor() { super('UNAVAILABLE', 'Another process owns the kernel lock.'); }
}

async function kernelLock(file: FileHandle): Promise<boolean> {
  const darwin = process.platform === 'darwin';
  if (!darwin && process.platform !== 'linux') throw new GatewayError('UNAVAILABLE', 'This platform needs a native session-lock adapter.');
  return new Promise((resolve, reject) => {
    const helper = darwin ? fileURLToPath(new URL('../../dist/native/lease-darwin', import.meta.url)) : '/usr/bin/flock';
    const child = spawn(helper, darwin ? [] : ['-n', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', file.fd], env: { PATH: '/usr/bin:/bin' },
      timeout: 5000, killSignal: 'SIGKILL',
    });
    child.once('error', () => reject(new GatewayError('UNAVAILABLE', 'The system kernel-lock helper is unavailable.')));
    child.once('exit', code => {
      if (code === 0) resolve(true);
      else if (code === (darwin ? 75 : 1)) resolve(false);
      else reject(new GatewayError('UNAVAILABLE', 'The system kernel-lock helper failed.'));
    });
  });
}

async function trustedFile(home: string, filename: string, create: boolean): Promise<FileHandle | null> {
  if (!/^[a-z][a-z0-9.-]*$/.test(filename)) throw new GatewayError('INVALID_ARGUMENT', 'Invalid kernel-lock name.');
  const directory = await lstat(home);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o022) !== 0) {
    throw new GatewayError('UNAVAILABLE', 'The session-lock directory is not privately owned.');
  }
  let file: FileHandle;
  try {
    const existing = await lstat(join(home, filename));
    if (!existing.isFile() || existing.isSymbolicLink()) throw new GatewayError('UNAVAILABLE', 'The kernel-lock path is not a regular file.');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    if (!create) return null;
  }
  try {
    file = await open(join(home, filename), constants.O_NOFOLLOW | constants.O_NONBLOCK | (create ? constants.O_RDWR | constants.O_CREAT : constants.O_RDONLY), 0o600);
  } catch (err) {
    if (!create && (err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new GatewayError('UNAVAILABLE', 'The kernel-lock file cannot be opened safely.');
  }
  try {
    const st = await file.stat();
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) {
      throw new GatewayError('UNAVAILABLE', 'The kernel-lock file is not private regular state.');
    }
    return file;
  } catch (err) {
    await file.close();
    throw err;
  }
}

/**
 * flock has no query operation: a concurrent isFileLeaseHeld probe briefly
 * holds the lock it tests. Short bounded retries keep that probe from
 * defeating a real owner; a genuinely held lease still fails in about half a second.
 */
const BUSY_RETRY_MS = [50, 100, 150, 200];

export async function acquireFileLease(home: string, filename: string): Promise<FileLease> {
  if (process.platform === 'win32') return acquireWindowsLease(home, filename);
  const file = await trustedFile(home, filename, true);
  if (!file) throw new GatewayError('UNAVAILABLE', 'The kernel-lock file is missing.');
  try {
    for (let attempt = 0; !await kernelLock(file); attempt++) {
      if (attempt >= BUSY_RETRY_MS.length) throw new FileLeaseBusyError();
      await sleep(BUSY_RETRY_MS[attempt]!);
    }
  } catch (err) { await file.close(); throw err; }
  let released: Promise<void> | undefined;
  return { release: () => released ??= file.close() };
}

/**
 * Read-only probe; absence does not create a file. Errors conservatively mean held/unsafe.
 * Testing a free lease takes it until the file closes; acquireFileLease retries past that.
 */
export async function isFileLeaseHeld(home: string, filename: string): Promise<boolean> {
  if (process.platform === 'win32') return isWindowsLeaseHeld(home, filename);
  let file: FileHandle | null = null;
  try {
    file = await trustedFile(home, filename, false);
    if (!file) return false;
    return !await kernelLock(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return true;
  } finally { await file?.close(); }
}
