// Read-only-source unsigned build. No private key, release publication or service operation.
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const version='24.21.0';
const sourceSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const root=mkdtempSync(join(tmpdir(),'tg-ci-candidate-'));
const run=(script,args)=>execFileSync(process.execPath,[resolve(script),...args],{stdio:'inherit',timeout:180000});
const npm=process.env.npm_execpath;if(!npm)throw new Error('npm_cli_missing');
run('scripts/install/fetch-runtime.mjs',['--output',join(root,'runtime'),'--version',version,'--platform',process.platform,'--architecture',process.arch]);
run('scripts/release/prepare-application.mjs',['--output',join(root,'application'),'--npm-cli',npm]);
const candidate=join(root,'candidate');
run('scripts/install/build-bundle.mjs',['--unsigned','--output',candidate,'--application',join(root,'application'),'--node',join(root,'runtime',process.platform==='win32'?'node.exe':'node'),'--node-version',version,'--node-license',join(root,'runtime','NODE_LICENSE'),'--runtime-record',join(root,'runtime','runtime-record.json'),'--source-sha',sourceSha,'--platform',process.platform,'--architecture',process.arch]);
// Export only unsigned public bytes. Runtime records retain pinned upstream provenance.
writeFileSync(join(candidate,'runtime-record.json'),readFileSync(join(root,'runtime','runtime-record.json')),{flag:'wx'});
if(process.env.GITHUB_OUTPUT)writeFileSync(process.env.GITHUB_OUTPUT,`candidate=${candidate}\nsource_sha=${sourceSha}\n`,{flag:'a'});
