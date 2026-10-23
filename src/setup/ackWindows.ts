/** DB-only receipt worker, invoked by the fixed service control command. No MTProto client. */
import { open, unlink, rename } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { installLayout } from '../install/platform.js';
import { acquireFileLease } from '../core/fileLease.js';
import { readBoundedFile } from '../core/safeFs.js';
import { loadSessionSecret } from '../core/config.js';
import { openStorage } from '../storage/sqlite.js';
import { ownerPlanSchema } from './owner.js';
import { setupIdSchema, SetupError } from './contract.js';
import { coordinatorMessageSchema } from './promptChannel.js';
import { acknowledgePreparedClients } from './clientHandoff.js';
const run=promisify(execFile);
async function main(): Promise<void> {
  if(process.platform!=='win32'||process.argv.length!==2)throw new SetupError('protection_unverified');
  const sha=win32.basename(win32.dirname(process.execPath));const layout=installLayout('win32',sha);
  if(process.execPath.toLowerCase()!==layout.node.toLowerCase()||fileURLToPath(import.meta.url).toLowerCase()!==join(layout.application,'dist/setup/ackWindows.js').toLowerCase())throw new SetupError('protection_unverified');
  const mailbox=join(layout.prefix,'owner-setup');
  const attest=async(path:string):Promise<void>=>{await run('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(layout.application,'dist/setup/owner-protection.ps1'),'-Path',path,'-RequireServiceIdentity'],
    {windowsHide:true,timeout:15000,maxBuffer:1024,env:{SystemRoot:'C:\\Windows'}});};
  const read=async(path:string):Promise<unknown>=>JSON.parse(new TextDecoder('utf-8',{fatal:true})
    .decode(await readBoundedFile(path,{maximum:2048,attest,fail:()=>new SetupError('invalid_state')})).replace(/^\uFEFF/,'')) as unknown;
  const plan=z.strictObject({format_version:z.literal(1),source_sha:z.string().regex(/^[0-9a-f]{40}$/),legacy_setup_id:setupIdSchema.nullable().default(null),plan:ownerPlanSchema}).parse(await read(join(mailbox,'plan.json')));
  const ack=coordinatorMessageSchema.parse(await read(join(mailbox,'client-ack.json')));
  if(plan.source_sha!==sha||ack.kind!=='client_ack'||ack.setup_id!==plan.plan.setup_id)throw new SetupError('invalid_state');
  await attest(layout.state);const lease=await acquireFileLease(layout.state,'setup.lock');
  try{
    const storage=openStorage(join(layout.state,'gateway.sqlite'));
    try{acknowledgePreparedClients(plan.plan,storage,loadSessionSecret(layout.state,{}),ack.token_sha256,plan.legacy_setup_id??undefined);}
    finally{storage.close();}
    await unlink(join(mailbox,'client-ack.json'));
    const receipt=join(mailbox,'client-acknowledged.json');const temporary=receipt+'.next';const file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify({setup_id:plan.plan.setup_id,token_sha256:ack.token_sha256}));await file.sync();}finally{await file.close();}await attest(temporary);await rename(temporary,receipt);
  }finally{await lease.release();}
}
main().catch(()=>{process.exitCode=1;});
