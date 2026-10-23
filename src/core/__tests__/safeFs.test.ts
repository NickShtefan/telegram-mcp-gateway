import { mkdtempSync, writeFileSync, chmodSync, rmSync, symlinkSync, linkSync, renameSync, appendFileSync, truncateSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBoundedFile, type BoundedFilePolicy } from '../safeFs.js';

// Runs once right after the reader's first lstat: the window between lstat and open.
const afterLstat = vi.hoisted(() => ({ once: null as null | (() => void) }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, lstat: async (path: string) => { const st = await actual.lstat(path); const hook = afterLstat.once; afterLstat.once = null; hook?.(); return st; } };
});

const posix = process.platform !== 'win32'; const uid = process.getuid?.() ?? -1;
const policy = (extra: Partial<BoundedFilePolicy> = {}): BoundedFilePolicy => ({ maximum: 64, fail: () => new Error('unsafe_file'), ...extra });
let base: string; let path: string; let other: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'tg-bounded-')); path = join(base, 'file'); other = join(base, 'other');
  writeFileSync(path, 'synthetic bytes'); writeFileSync(other, 'other synthetic bytes');
  if (posix) { chmodSync(path, 0o600); chmodSync(other, 0o600); }
});
afterEach(() => { afterLstat.once = null; rmSync(base, { recursive: true, force: true }); });

describe('bounded file reader', () => {
  it('reads the exact bytes and attests the inode it opened', async () => {
    const seen: [string, number, number][] = [];
    const bytes = await readBoundedFile(path, policy({ attest: async (target, st) => { seen.push([target, st.dev, st.ino]); } }));
    expect(bytes.toString()).toBe('synthetic bytes');
    const st = lstatSync(path); expect(seen).toEqual([[path, st.dev, st.ino]]);
    expect((await readBoundedFile(path, policy({ maximum: 15 }))).length).toBe(15);
  });
  it('passes an absent file through as ENOENT and rejects an oversized one', async () => {
    await expect(readBoundedFile(join(base, 'absent'), policy())).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readBoundedFile(path, policy({ maximum: 14 }))).rejects.toThrow('unsafe_file');
  });
  it('fails when the file grows or shrinks between fstat and read', async () => {
    await expect(readBoundedFile(path, policy({ attest: async () => appendFileSync(path, 'x') }))).rejects.toThrow('unsafe_file');
    await expect(readBoundedFile(path, policy({ attest: async () => truncateSync(path, 3) }))).rejects.toThrow('unsafe_file');
  });
  it('fails when another inode replaces the path between lstat and open', async () => {
    afterLstat.once = () => renameSync(other, path);
    await expect(readBoundedFile(path, policy())).rejects.toThrow('unsafe_file');
  });
});

describe.skipIf(!posix)('bounded file reader on POSIX', () => {
  it('rejects a symlink and never follows one swapped in before open', async () => {
    const link = join(base, 'link'); symlinkSync(other, link);
    await expect(readBoundedFile(link, policy())).rejects.toThrow('unsafe_file');
    const attest = vi.fn(async () => undefined);
    afterLstat.once = () => { rmSync(path); symlinkSync(other, path); };
    await expect(readBoundedFile(path, policy({ attest }))).rejects.toMatchObject({ code: 'ELOOP' });
    expect(attest).not.toHaveBeenCalled();
  });
  it('rejects a hard link', async () => {
    linkSync(path, join(base, 'second'));
    await expect(readBoundedFile(path, policy())).rejects.toThrow('unsafe_file');
  });
  it('rejects a FIFO without blocking, also when swapped in before open', async () => {
    const fifo = join(base, 'fifo'); execFileSync('/usr/bin/mkfifo', [fifo]);
    await expect(readBoundedFile(fifo, policy())).rejects.toThrow('unsafe_file');
    afterLstat.once = () => { rmSync(path); execFileSync('/usr/bin/mkfifo', [path]); };
    await expect(readBoundedFile(path, policy())).rejects.toThrow('unsafe_file');
  });
  it('enforces the owner and mode policy on the open descriptor', async () => {
    await expect(readBoundedFile(path, policy({ owners: [uid + 1] }))).rejects.toThrow('unsafe_file');
    chmodSync(path, 0o640);
    await expect(readBoundedFile(path, policy({ owners: [uid], modeMask: 0o077 }))).rejects.toThrow('unsafe_file');
    expect((await readBoundedFile(path, policy({ owners: [uid], modeMask: 0o022 }))).toString()).toBe('synthetic bytes');
  });
  it('fails when the path names another inode, or none, after attestation', async () => {
    await expect(readBoundedFile(path, policy({ attest: async () => renameSync(other, path) }))).rejects.toThrow('unsafe_file');
    // A file removed while open is a change, not an absent file.
    await expect(readBoundedFile(path, policy({ attest: async () => rmSync(path) }))).rejects.toThrow('unsafe_file');
  });
  it('leaves owner and mode bits to the attestation hook on Windows', async () => {
    chmodSync(path, 0o644); const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try {
      const attest = vi.fn(async () => undefined);
      expect((await readBoundedFile(path, policy({ owners: [uid + 1], modeMask: 0o077, attest }))).toString()).toBe('synthetic bytes');
      expect(attest).toHaveBeenCalledOnce();
    } finally { Object.defineProperty(process, 'platform', platform); }
  });
});
