import { describe,it,expect } from 'vitest';import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,chmodSync,rmSync } from 'node:fs';import { tmpdir } from 'node:os';import { join,resolve } from 'node:path';import { pathToFileURL } from 'node:url';import { execFileSync } from 'node:child_process';import { createHash,X509Certificate,verify,constants } from 'node:crypto';
import { ARTIFACT_ROLES,encodeManifest } from '../manifest.js';
const {signCandidates}=await import(pathToFileURL(resolve('scripts/release/batch-sign.mjs')).href);
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
describe.skipIf(process.platform==='win32')('owner batch signing with disposable keys only',()=>{
 it('prompts once, signs all five, rejects mutation before signing any candidate',async()=>{
  const root=mkdtempSync(join(tmpdir(),'tg-batch-fixture-'));try{
   const key=join(root,'fixture-key.pem'),cert=join(root,'fixture-cert.pem'),pass=join(root,'fixture-pass');writeFileSync(pass,'fixture-only',{mode:0o600});
   execFileSync('/usr/bin/openssl',['genpkey','-algorithm','RSA','-pkeyopt','rsa_keygen_bits:3072','-aes-256-cbc','-pass','file:'+pass,'-out',key],{stdio:'ignore'});
   chmodSync(key,0o600);
   execFileSync('/usr/bin/openssl',['req','-new','-x509','-key',key,'-passin','file:'+pass,'-days','1','-out',cert,'-subj','/CN=Synthetic Batch Fixture'],{stdio:'ignore'});
   const certificate=new X509Certificate(readFileSync(cert)),sourceSha='a'.repeat(40);const layouts=[['darwin','arm64'],['darwin','x64'],['linux','arm64'],['linux','x64'],['win32','x64']] as const;
   const make=(prefix:string)=>layouts.map(([platform,architecture],i)=>{const directory=join(root,prefix+i);mkdirSync(directory,{mode:0o700});const names=[platform==='win32'?'node.exe':'node','installer.mjs','manifest.mjs','archive.mjs','application.tar.gz','NODE_LICENSE'];for(const n of names)writeFileSync(join(directory,n),'fixture');const manifest=encodeManifest({version:'0.2.0',sourceSha,platform,architecture,nodeVersion:'24.21.0',artifacts:ARTIFACT_ROLES.map((role,j)=>({role,name:names[j]!,size:7,sha256:sha(Buffer.from('fixture'))}))});writeFileSync(join(directory,'manifest.tsv'),manifest);return {directory,platform,architecture,manifestSha256:sha(manifest)}});
   let prompts=0;const candidates=make('good');await signCandidates(candidates,{sourceSha,keyPath:key,certificatePath:cert,signerPin:sha(certificate.raw),prompt:async(_s:string,options:{hidden:boolean})=>{prompts++;expect(options.hidden).toBe(true);return 'fixture-only'}});expect(prompts).toBe(1);
   for(const c of candidates)expect(verify('sha256',readFileSync(join(c.directory,'manifest.tsv')),{key:certificate.publicKey,padding:constants.RSA_PKCS1_PADDING},readFileSync(join(c.directory,'manifest.sig')))).toBe(true);
   const altered=make('altered');await expect(signCandidates(altered,{sourceSha,keyPath:key,certificatePath:cert,signerPin:sha(certificate.raw),prompt:async()=>{writeFileSync(join(altered[4]!.directory,'installer.mjs'),'changed');return 'fixture-only'}})).rejects.toThrow();for(const c of altered)expect(existsSync(join(c.directory,'manifest.sig'))).toBe(false);
   await expect(signCandidates(make('wrongpin'),{sourceSha,keyPath:key,certificatePath:cert,signerPin:'0'.repeat(64),prompt:async()=>{throw Error('must not prompt')}})).rejects.toThrow('untrusted_signer');
  }finally{rmSync(root,{recursive:true,force:true})}
 },30000);
});
