import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireLock, isLockHeld } from '../lock.js';
import { acquireFileLease } from '../fileLease.js';
const roots: string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})});
describe.skipIf(process.platform!=='win32')('Windows kernel pipe lease',()=>{
  it('rejects duplicate session ownership and frees the name after release',async()=>{
    const home=mkdtempSync(join(tmpdir(),'tg-win-lease-'));roots.push(home);
    const first=await acquireLock(home);
    try{expect(await isLockHeld(home)).toBe(true);await expect(acquireLock(home)).rejects.toMatchObject({code:'UNAVAILABLE'})}
    finally{await first.release()}
    expect(await isLockHeld(home)).toBe(false);const second=await acquireLock(home);await second.release();
  });
  it('separates setup and session leases without filesystem stale-file deletion',async()=>{
    const home=mkdtempSync(join(tmpdir(),'tg-win-lease-'));roots.push(home);
    const session=await acquireFileLease(home,'sessions.lock');const setup=await acquireFileLease(home,'setup.lock');
    try{await expect(acquireFileLease(home,'setup.lock')).rejects.toMatchObject({code:'UNAVAILABLE'})}
    finally{await setup.release();await session.release()}
  });
});
