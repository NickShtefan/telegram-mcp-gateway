import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireLock, isLockHeld, lockPath } from '../lock.js';
import { acquireFileLease, FileLeaseBusyError, isFileLeaseHeld } from '../fileLease.js';

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function home(): string {
  const directory = mkdtempSync(process.platform === 'darwin' ? '/private/tmp/tg-lock-' : '/tmp/tg-lock-');
  roots.push(directory); return directory;
}

async function childOwner(directory: string, lease: boolean): Promise<ChildProcess> {
  const script = `import {openSync,constants} from 'node:fs'; import {spawnSync} from 'node:child_process'; import {createServer} from 'node:net';
    if(process.argv[2]==='lease') { const fd=openSync(process.argv[1]+'/sessions.lock',constants.O_RDWR|constants.O_CREAT,0o600);
      const mac=process.platform==='darwin'; const r=spawnSync(mac?process.argv[3]:'/usr/bin/flock',mac?[]:['-n','3'],{stdio:['ignore','ignore','ignore',fd]}); if(r.status!==0) process.exit(2); }
    process.umask(0o022); createServer(s=>s.end()).listen(process.argv[1]+'/daemon.sock',()=>process.stdout.write('ready\\n'));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, directory, lease ? 'lease' : 'legacy', resolve('dist/native/lease-darwin')], { stdio: ['ignore', 'pipe', 'ignore'] });
  children.push(child);
  await Promise.race([
    once(child.stdout!, 'data'),
    once(child, 'exit').then(() => { throw new Error('Synthetic lock owner exited before readiness.'); }),
  ]);
  return child;
}

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('session kernel ownership', () => {
  it('a read-only absent-lease probe creates nothing', async () => {
    const directory = home();
    expect(await isFileLeaseHeld(directory, 'sessions.lock')).toBe(false);
    expect(readdirSync(directory)).toEqual([]);
  });

  it('kernel ownership remains visible when the liveness socket is absent', async () => {
    const directory = home(); const lease = await acquireFileLease(directory, 'sessions.lock');
    try {
      expect(await isLockHeld(directory)).toBe(true);
      await expect(acquireLock(directory)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    } finally { await lease.release(); }
    expect(await isLockHeld(directory)).toBe(false);
    expect(readdirSync(directory)).toEqual(['sessions.lock']);
  });

  it('excludes a live legacy socket-only owner without unlinking its endpoint', async () => {
    const directory = home(); await childOwner(directory, false);
    await expect(acquireLock(directory)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(await isLockHeld(directory)).toBe(true);
    expect(readdirSync(directory)).toContain('daemon.sock');
  });

  it('excludes another process holding the permanent inode', async () => {
    const directory = home(); await childOwner(directory, true);
    await expect(acquireLock(directory)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(await isLockHeld(directory)).toBe(true);
  });

  it('waits out a transient holder such as a read-only probe instead of failing the real owner', async () => {
    const directory = home(); const child = await childOwner(directory, true);
    const pending = acquireFileLease(directory, 'sessions.lock');
    await new Promise(resolve => setTimeout(resolve, 100));
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const lease = await pending;
    try { expect(await isFileLeaseHeld(directory, 'sessions.lock')).toBe(true); }
    finally { await lease.release(); }
    // flock cannot query: each probe briefly takes the free lease it tests.
    for (let round = 0; round < 10; round++) {
      const [, , owner] = await Promise.all([isLockHeld(directory), isFileLeaseHeld(directory, 'sessions.lock'), acquireLock(directory)]);
      await owner.release();
    }
  });

  it('creates a private liveness endpoint whatever the umask, so a crash leaves a reclaimable socket', async () => {
    const directory = home();
    const script = `const {acquireLock}=await import(${JSON.stringify(pathToFileURL(resolve('dist/core/lock.js')).href)}); process.umask(0o002);
      await acquireLock(process.argv[1]); process.stdout.write('ready\\n'); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, directory], { stdio: ['ignore', 'pipe', 'ignore'] });
    children.push(child); await once(child.stdout!, 'data');
    expect(lstatSync(lockPath(directory)).mode & 0o777).toBe(0o600);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    expect(await isLockHeld(directory)).toBe(false);
    const next = await acquireLock(directory); await next.release();
  });

  it('still rejects a genuinely held lease after bounded retries', async () => {
    const directory = home(); await childOwner(directory, true);
    const started = Date.now();
    await expect(acquireFileLease(directory, 'sessions.lock')).rejects.toBeInstanceOf(FileLeaseBusyError);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(450); expect(elapsed).toBeLessThan(5_000);
  });

  it('only one of competing restarts wins after a killed owner leaves its socket', async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const directory = home(); const child = await childOwner(directory, true);
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      expect(await isLockHeld(directory)).toBe(false);
      const results = await Promise.allSettled(Array.from({ length: 4 }, () => acquireLock(directory)));
      const winners = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireLock>>> => r.status === 'fulfilled');
      try {
        expect(winners).toHaveLength(1);
        expect(await isLockHeld(directory)).toBe(true);
        for (const r of results) if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'UNAVAILABLE' });
      } finally { await Promise.all(winners.map(r => r.value.release())); }
      expect(readdirSync(directory)).toEqual(['sessions.lock']);
    }
  }, 30_000); // Each round's losers spend the bounded busy retries (about half a second).

  it('release is idempotent and cannot remove the next owner socket', async () => {
    const directory = home(); const first = await acquireLock(directory);
    await Promise.all([first.release(), first.release()]);
    const next = await acquireLock(directory);
    try { await first.release(); expect(await isLockHeld(directory)).toBe(true); }
    finally { await next.release(); }
  });

  it('rejects an unsafe lock inode or directory instead of reclaiming it', async () => {
    const directory = home(); const target = join(directory, 'target'); writeFileSync(target, 'fixture');
    symlinkSync(target, join(directory, 'sessions.lock'));
    await expect(acquireLock(directory)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(await isLockHeld(directory)).toBe(true);
    rmSync(join(directory, 'sessions.lock')); writeFileSync(join(directory, 'sessions.lock'), '', { mode: 0o644 });
    await expect(acquireLock(directory)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    chmodSync(directory, 0o777);
    await expect(acquireLock(directory)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(lockPath(directory)).toBe(join(directory, 'daemon.sock'));
  });

  it('rejects FIFO kernel state promptly and preserves the object', async () => {
    const directory = home(); const path = join(directory, 'sessions.lock');
    execFileSync('/usr/bin/mkfifo', ['-m', '600', path]);
    expect(await isFileLeaseHeld(directory, 'sessions.lock')).toBe(true);
    await expect(acquireFileLease(directory, 'sessions.lock')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(lstatSync(path).isFIFO()).toBe(true);
  });

  it('preserves regular files, symlinks and FIFOs at the compatibility endpoint', async () => {
    const directory = home(); const path = lockPath(directory);
    writeFileSync(path, 'synthetic foreign state');
    await expect(acquireLock(directory)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(readFileSync(path, 'utf8')).toBe('synthetic foreign state');
    rmSync(path); const target = join(directory, 'target'); writeFileSync(target, 'fixture'); symlinkSync(target, path);
    await expect(acquireLock(directory)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    rmSync(path); execFileSync('/usr/bin/mkfifo', ['-m', '600', path]);
    await expect(acquireLock(directory)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(lstatSync(path).isFIFO()).toBe(true);
  });
});
