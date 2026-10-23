/** Root entry executed only by the independently trusted no-Node POSIX bootstrap. */
import { parseArgs } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PosixProvisionBackend } from './posixBackend.js';
import { provision, receiptSchema, type ProvisionStep } from './provision.js';
import { TerminalProgress } from '../cli/progress.js';
import { attestAncestry } from './posixPermissions.js';
import { readProtectedRootFile } from '../setup/installed.js';
import { installLayout } from './platform.js';
async function main(): Promise<number> {
  if(process.getuid?.()!==0||!['darwin','linux'].includes(process.platform))throw new Error();
  const {values}=parseArgs({options:{'source-sha':{type:'string'},'signer-sha256':{type:'string'},port:{type:'string',default:'7777'}}});
  if(!/^[0-9a-f]{40}$/.test(values['source-sha']??'')||!/^[0-9a-f]{64}$/.test(values['signer-sha256']??'')||!/^\d{1,5}$/.test(values.port!))throw new Error();
  const candidate=dirname(process.execPath);
  if(fileURLToPath(import.meta.url)!==join(candidate,'application/dist/install/provisionCli.js'))throw new Error();
  // Permission checks are not the initial trust anchor: the caller must first
  // authenticate this bootstrap/runtime/application against its independent pin.
  const backend=new PosixProvisionBackend(candidate,async()=>{
    await attestAncestry(candidate,true);
    if(process.execPath!==join(candidate,'node'))throw new Error();
  });
  let setupId: string=randomUUID();
  const layout=installLayout(process.platform as 'darwin'|'linux',values['source-sha']!);
  try { const saved=receiptSchema.parse(JSON.parse((await readProtectedRootFile(join(layout.prefix,'install.json'),16384)).toString('utf8')));setupId=saved.plan.setup_id; }
  catch(err) {if((err as NodeJS.ErrnoException).code!=='ENOENT')throw err;}
  const labels: Record<ProvisionStep, string> = {
    attest: 'Checking system installation requirements...',
    resume: 'Checking the existing installation before continuing...',
    identity: 'Creating the dedicated gateway service account...',
    release: 'Installing the verified application files...',
    state: 'Preparing private gateway storage...',
    definition: 'Registering the gateway service (it stays stopped until setup)...',
    commands: 'Installing the owner setup command...',
    verify: 'Checking installed files and permissions...',
  };
  const progress = new TerminalProgress(line => process.stderr.write(line + '\n'), !!process.stderr.isTTY);
  try {
    const result=await provision({format_version:1,setup_id:setupId,source_sha:values['source-sha']!,signer_sha256:values['signer-sha256']!,
      platform:process.platform as 'darwin'|'linux',port:Number(values.port)},backend, step => progress.start(labels[step]));
    if (!process.stdout.isTTY || !process.stderr.isTTY) process.stdout.write(JSON.stringify(result)+'\n');
    if (process.stderr.isTTY) process.stderr.write(result.phase === 'failed'
      ? 'Installation could not finish. Keep the same download and existing state for retry.\n'
      : 'System installation is ready. Next, connect Telegram in the owner setup wizard.\n');
    return result.phase==='failed'?1:0;
  } finally { progress.stop(); }
}
main().then(code=>{process.exitCode=code;}).catch(()=>{process.stderr.write('{"format_version":1,"error_code":"protected_installation_failed"}\n');process.exitCode=1;});
