#!/usr/bin/env node
// Development/release builder. Signing keys are read from protected local files, never printed.
import { constants, lstatSync, readFileSync, readdirSync, mkdirSync, openSync, writeFileSync, closeSync, fstatSync } from 'node:fs';
import { createHash, sign, createPrivateKey, X509Certificate } from 'node:crypto';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { runtimeEntry } from './runtime-entry.mjs';
import { encodeManifest, ARTIFACT_ROLES } from '../../dist/install/manifest.js';
import { encodeApplicationArchive } from '../../dist/install/archive.js';
function readRegular(path, max) {
  const st = lstatSync(path); if (!st.isFile() || st.isSymbolicLink() || st.size > max) throw new Error();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const actual=fstatSync(fd); if(!actual.isFile()||actual.size>max)throw new Error(); return readFileSync(fd); } finally { closeSync(fd); }
}
try {
  const { values } = parseArgs({ options: {
    output: { type: 'string' }, application: { type: 'string' }, node: { type: 'string' }, 'node-version': { type: 'string' },
    'node-license': { type: 'string' }, 'signing-key': { type: 'string' }, certificate: { type: 'string' },
    'source-sha': { type: 'string' }, platform: { type: 'string' }, architecture: { type: 'string' },
    unsigned: { type: 'boolean', default: false }, 'runtime-record': { type: 'string' }, 'fixture-runtime': { type: 'boolean', default: false },
  } });
  for (const key of Object.keys(values)) if (key!=='fixture-runtime'&&key!=='unsigned' && typeof values[key] !== 'string') throw new Error();
  for (const key of ['output','application','node','node-version','node-license','source-sha','platform','architecture',...(values.unsigned?[]:['signing-key','certificate'])]) if (!values[key]) throw new Error();
  const files = [];
  const app = resolve(values.application);
  const allowedRoots=new Set(['package.json','README.md','LICENSE','NOTICE','THIRD_PARTY_NOTICES.md','dist','node_modules']);
  if(readdirSync(app).some(name=>!allowedRoots.has(name)))throw new Error();
  function walk(directory, prefix='') {
    const st=lstatSync(directory); if(!st.isDirectory()||st.isSymbolicLink())throw new Error();
    for(const name of readdirSync(directory).sort()) {
      const path=join(directory,name); const relative=prefix?`${prefix}/${name}`:name;
      if(name==='.env'||name.startsWith('.env.')||name==='session.key'||name==='.git'||name==='.npmrc'||name==='.tg-mcp'||/\.(sqlite|db|session)$/i.test(name))throw new Error();
      const child=lstatSync(path); if(child.isSymbolicLink())throw new Error();
      if(child.isDirectory())walk(path,relative); else if(child.isFile())files.push({path:relative,data:readRegular(path,33554432),...(relative==='dist/native/lease-darwin'?{executable:true}:{})}); else throw new Error();
    }
  }
  walk(app);
  let key,certificate;
  if(!values.unsigned){
  const keyPath=resolve(values['signing-key']); const keyStat=lstatSync(keyPath);
  if ((keyStat.mode&0o077)!==0 || (process.getuid && keyStat.uid!==process.getuid())) throw new Error();
  key=createPrivateKey(readRegular(keyPath,16384));
  if(key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails?.modulusLength!==3072)throw new Error();
  certificate=new X509Certificate(readRegular(resolve(values.certificate),16384));
  if(!certificate.checkPrivateKey(key))throw new Error();
  }
  const platform=values.platform;
  const payload = {
    node: { name: platform==='win32'?'node.exe':'node', data:readRegular(resolve(values.node),134217728) },
    installer: { name:'installer.mjs',data:readRegular(resolve('scripts/install/installer.mjs'),1048576) },
    manifest_helper: { name:'manifest.mjs',data:readRegular(resolve('dist/install/manifest.js'),1048576) },
    archive_helper: { name:'archive.mjs',data:readRegular(resolve('dist/install/archive.js'),1048576) },
    application: { name:'application.tar.gz',data:encodeApplicationArchive(files) },
    node_license: { name:'NODE_LICENSE',data:readRegular(resolve(values['node-license']),1048576) },
  };
  if(!values['fixture-runtime']) {
    const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',timeout:5000}).trim();
    const changes=execFileSync('git',['status','--porcelain','--untracked-files=normal'],{encoding:'utf8',timeout:5000}).trim();
    if(head!==values['source-sha']||changes)throw new Error();
    const metadata=JSON.parse(readRegular(join(app,'package.json'),1048576).toString('utf8'));
    if(metadata.version!=='0.2.0'||metadata.type!=='module')throw new Error();
    if(!values['runtime-record'])throw new Error();
    const receipt=JSON.parse(readRegular(resolve(values['runtime-record']),16384).toString('utf8'));
    const catalog=JSON.parse(readRegular(resolve('scripts/install/runtime-catalog.json'),16384).toString('utf8'));
    const upstream=catalog.runtimes.find(r=>r.version===values['node-version']&&r.platform===platform&&r.architecture===values.architecture);
    if(!upstream||receipt.sha256!==upstream.sha256||receipt.version!==upstream.version||receipt.platform!==platform||receipt.architecture!==values.architecture)throw new Error();
    const upstreamPath=resolve(values['runtime-record'],'..',platform==='win32'?'upstream.zip':'upstream.tar.gz');
    if(createHash('sha256').update(readRegular(upstreamPath,134217728)).digest('hex')!==upstream.sha256)throw new Error();
    const prefix=`node-v${upstream.version}-${platform==='win32'?'win':platform}-${upstream.architecture}`;
    const binary=runtimeEntry(upstreamPath,`${prefix}/${platform==='win32'?'node.exe':'bin/node'}`,134217728,platform==='win32');
    const license=runtimeEntry(upstreamPath,`${prefix}/LICENSE`,1048576,platform==='win32');
    if(!binary.equals(payload.node.data)||!license.equals(payload.node_license.data))throw new Error();
  }
  const manifest=encodeManifest({ version:'0.2.0',sourceSha:values['source-sha'],platform,architecture:values.architecture,nodeVersion:values['node-version'],
    artifacts:ARTIFACT_ROLES.map(role=>({role,name:payload[role].name,size:payload[role].data.length,sha256:createHash('sha256').update(payload[role].data).digest('hex')})) });
  // New empty output only. Do not copy a private key into the bundle.
  const output=resolve(values.output); mkdirSync(output,{mode:0o700});
  for(const role of ARTIFACT_ROLES)writeFileSync(join(output,payload[role].name),payload[role].data,{flag:'wx',mode:0o600});
  if(!values.unsigned)writeFileSync(join(output,'signer.der'),certificate.raw,{flag:'wx',mode:0o600});
  writeFileSync(join(output,'manifest.tsv'),manifest,{flag:'wx',mode:0o600});
  if(!values.unsigned)writeFileSync(join(output,'manifest.sig'),sign('sha256',manifest,{key,padding:constants.RSA_PKCS1_PADDING}),{flag:'wx',mode:0o600});
  process.stdout.write(JSON.stringify({format_version:1,phase:values['fixture-runtime']?'fixture_bundle_created':values.unsigned?'unsigned_candidate_created':'bundle_created',version:'0.2.0',source_sha:values['source-sha'],
    signer_sha256:certificate?createHash('sha256').update(certificate.raw).digest('hex'):null,manifest_sha256:createHash('sha256').update(manifest).digest('hex'),files:files.length})+'\n');
} catch { process.stderr.write('{"format_version":1,"error_code":"bundle_build_failed"}\n');process.exitCode=1; }
