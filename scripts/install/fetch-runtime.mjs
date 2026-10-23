#!/usr/bin/env node
// Build-time acquisition using the reviewed upstream digest catalog, never a latest alias.
import { readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { runtimeEntry } from './runtime-entry.mjs';
const catalog=JSON.parse(readFileSync(new URL('./runtime-catalog.json',import.meta.url),'utf8'));
let stage='request';
try {
  const {values}=parseArgs({options:{output:{type:'string'},version:{type:'string'},platform:{type:'string'},architecture:{type:'string'}}});
  const record=catalog.runtimes.find(r=>r.version===values.version&&r.platform===values.platform&&r.architecture===values.architecture);
  if(!record||!values.output)throw new Error();
  stage='download';
  const response=await fetch(`https://nodejs.org/dist/v${record.version}/${record.asset}`,{redirect:'error',signal:AbortSignal.timeout(120000)});
  if(!response.ok||!response.body)throw new Error();
  const pieces=[];let size=0;
  for await(const piece of response.body){size+=piece.length;if(size>134217728)throw new Error();pieces.push(piece);}
  stage='digest';
  const bytes=Buffer.concat(pieces);
  if(createHash('sha256').update(bytes).digest('hex')!==record.sha256)throw new Error();
  const output=resolve(values.output);mkdirSync(output,{mode:0o700});
  const download=join(output,record.platform==='win32'?'upstream.zip':'upstream.tar.gz');writeFileSync(download,bytes,{flag:'wx',mode:0o600});
  stage='extract';
  let node,license;
  if(record.platform==='win32'){
    const prefix=`node-v${record.version}-win-${record.architecture}`;
    node=runtimeEntry(download,`${prefix}/node.exe`,134217728,true);
    license=runtimeEntry(download,`${prefix}/LICENSE`,1048576,true);
  } else {
    // The complete official archive digest has passed before the system reader sees it.
    const prefix=`node-v${record.version}-${record.platform}-${record.architecture}`;
    node=runtimeEntry(download,`${prefix}/bin/node`,134217728,false);
    license=runtimeEntry(download,`${prefix}/LICENSE`,1048576,false);
  }
  const name=record.platform==='win32'?'node.exe':'node';writeFileSync(join(output,name),node,{flag:'wx',mode:0o600});
  stage='runtime_version';
  if(record.platform===process.platform&&record.architecture===process.arch){
    chmodSync(join(output,name),0o700);
    const observed=execFileSync(join(output,name),['--version'],{env:process.platform==='win32'?{SystemRoot:'C:\\Windows'}:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:10000}).trim();
    if(observed!==`v${record.version}`)throw new Error();
  }
  writeFileSync(join(output,'NODE_LICENSE'),license,{flag:'wx',mode:0o600});
  const receipt={format_version:1,...record,node_sha256:createHash('sha256').update(node).digest('hex'),node_size:node.length,
    license_sha256:createHash('sha256').update(license).digest('hex'),captured_at:new Date().toISOString(),upstream_catalog_keyring:catalog.keyring_commit};
  writeFileSync(join(output,'runtime-record.json'),JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});
  process.stdout.write(JSON.stringify({format_version:1,phase:'runtime_acquired',version:record.version,platform:record.platform,architecture:record.architecture,upstream_sha256:record.sha256})+'\n');
} catch (error) {const cause=['ETIMEDOUT','ENOBUFS','ENOENT'].includes(error?.code)?error.code:'verification_or_reader_failed';process.stderr.write(JSON.stringify({format_version:1,error_code:'runtime_acquisition_failed',stage,cause})+'\n');process.exitCode=1;}
