import { lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireFileLease, FileLeaseBusyError, isFileLeaseHeld } from '../fileLease.js';

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function home(): string { const dir = mkdtempSync(join(tmpdir(), 'tg-lease-')); roots.push(dir); return dir; }

/** Another process holds the kernel lease on `setup.lock` until killed. */
async function holder(directory: string): Promise<ChildProcess> {
  const script = "import {openSync} from 'node:fs'; import {spawnSync} from 'node:child_process'; const fd=openSync(process.argv[1],'a',0o600); const mac=process.platform==='darwin';const result=spawnSync(mac?process.argv[2]:'/usr/bin/flock',mac?[]:['-n','3'],{stdio:['ignore','ignore','ignore',fd]}); if(result.status!==0)process.exit(1);process.stdout.write('locked\\n');setInterval(()=>{},1000);";
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, join(directory, 'setup.lock'), resolve('dist/native/lease-darwin')], { stdio: ['ignore', 'pipe', 'ignore'] });
  children.push(child);
  await Promise.race([
    once(child.stdout!, 'data'),
    once(child, 'exit').then(() => { throw new Error('Synthetic lease holder exited before readiness.'); }),
  ]);
  return child;
}
async function kill(child: ChildProcess): Promise<void> { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('setup kernel lease', () => {
  it('excludes a second process and recovers after its crash on the same retained inode', async () => {
    const directory = home(); const child = await holder(directory);
    const inode = lstatSync(join(directory, 'setup.lock')).ino;
    await expect(acquireFileLease(directory, 'setup.lock')).rejects.toBeInstanceOf(FileLeaseBusyError);
    expect(await isFileLeaseHeld(directory, 'setup.lock')).toBe(true);
    await kill(child);
    const lease = await acquireFileLease(directory, 'setup.lock');
    await lease.release();
    expect(readdirSync(directory)).toEqual(['setup.lock']);
    expect(lstatSync(join(directory, 'setup.lock')).ino).toBe(inode);
  });

  it('two in-process holders cannot both obtain the lease; release permits reacquisition', async () => {
    const directory = home(); const first = await acquireFileLease(directory, 'setup.lock');
    try { await expect(acquireFileLease(directory, 'setup.lock')).rejects.toBeInstanceOf(FileLeaseBusyError); }
    finally { await Promise.all([first.release(), first.release()]); }
    const next = await acquireFileLease(directory, 'setup.lock');
    await next.release();
  });

  it('concurrent recovery after a killed holder has exactly one winner', async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const directory = home(); await kill(await holder(directory));
      const results = await Promise.allSettled([acquireFileLease(directory, 'setup.lock'), acquireFileLease(directory, 'setup.lock')]);
      const winners = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireFileLease>>> => r.status === 'fulfilled');
      try {
        expect(winners).toHaveLength(1);
        for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(FileLeaseBusyError);
      } finally { await Promise.all(winners.map(r => r.value.release())); }
    }
  }, 30_000); // Each round's loser spends the bounded busy retries (about half a second).
});
