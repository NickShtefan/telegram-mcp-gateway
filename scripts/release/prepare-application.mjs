// Produce the runtime-only application tree; never copy checkout state or development dependencies.
import { cpSync, lstatSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
try {
  const {values}=parseArgs({options:{output:{type:'string'},'npm-cli':{type:'string'}}});if(!values.output||!values['npm-cli'])throw new Error();
  const output=resolve(values.output);mkdirSync(output,{mode:0o700});
  const source=resolve('.');const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',timeout:5000}).trim();
  if(execFileSync('git',['status','--porcelain','--untracked-files=normal'],{encoding:'utf8',timeout:5000}).trim())throw new Error();
  for(const name of ['package.json','README.md','LICENSE','NOTICE','THIRD_PARTY_NOTICES.md']) {
    const file=join(source,name);const st=lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)throw new Error();writeFileSync(join(output,name),readFileSync(file),{flag:'wx',mode:0o600});
  }
  // Use the exact lockfile for production dependency acquisition, then remove it:
  // runtime application archive roots deliberately exclude build preparation data.
  writeFileSync(join(output,'package-lock.json'),readFileSync('package-lock.json'),{flag:'wx',mode:0o600});
  execFileSync(process.execPath,[resolve(values['npm-cli']),'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund','--cache',join(tmpdir(),'tg-npm-cache')],{cwd:output,stdio:'ignore',timeout:120000});
  rmSync(join(output,'package-lock.json'));rmSync(join(output,'node_modules','.bin'),{recursive:true,force:true});
  cpSync('dist',join(output,'dist'),{recursive:true,filter:path=>!path.endsWith('.map')&&!path.includes('__tests__')});
  const inspect=directory=>{for(const name of readdirSync(directory)){const path=join(directory,name);const st=lstatSync(path);if(st.isSymbolicLink())throw new Error();if(st.isDirectory())inspect(path);else if(!st.isFile()||st.nlink!==1||st.size>33554432)throw new Error();}};
  inspect(output);
  process.stdout.write(JSON.stringify({format_version:1,phase:'runtime_application_prepared',source_sha:sha,qualified:false})+'\n');
}catch{process.stderr.write('{"format_version":1,"error_code":"runtime_application_failed"}\n');process.exitCode=1;}
