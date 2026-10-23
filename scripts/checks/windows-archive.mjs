// Production-sized synthetic extraction, no elevation, service or release signing.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { encodeApplicationArchive, extractApplicationArchive } from '../../dist/install/archive.js';
if(process.platform!=='win32')throw new Error('Windows fixture only');
const source=readFileSync('scripts/install/installer.mjs','utf8');
const body=source.slice(source.indexOf('async function windowsAttest('),source.indexOf('\nfunction read('));
const attest=new Function('spawn',body+';return windowsAttest;')(spawn);
const target=mkdtempSync(join(tmpdir(),'tg-archive-'));
try {
  execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-Command',`$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false);$admin=New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544';$acl.SetOwner($admin);foreach($sid in @($admin,(New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'))){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))};Set-Acl -LiteralPath $env:TG_TEST_TARGET -AclObject $acl`],{env:{SystemRoot:'C:\\Windows',TG_TEST_TARGET:target}});
  const entries=Array.from({length:4500},(_,i)=>({path:`node_modules/fixture${i%50}/lib/file${i}.js`,data:Buffer.from('synthetic payload')}));
  let batches=0;
  await extractApplicationArchive(encodeApplicationArchive(entries),target,async paths=>{
    batches++;
    if(batches===2){if(new Set(paths).size!==paths.length)throw new Error('duplicate attestation');for(const path of paths){const st=statSync(path);if(st.isFile()&&st.size!==0)throw new Error('payload before attestation')}}
    await attest(paths);
  });
  if(batches!==2)throw new Error('unbounded attestation processes');
  for(const entry of entries)if(!readFileSync(join(target,entry.path)).equals(entry.data))throw new Error('payload mismatch');
  console.log(JSON.stringify({files:entries.length,attestation_processes:batches}));
} finally {rmSync(target,{recursive:true,force:true})}
