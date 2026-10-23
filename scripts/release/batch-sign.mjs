// Owner-operated library; tests use disposable keys only. No key access on import.
import { constants as fsConstants, openSync, closeSync, fstatSync, lstatSync, readSync, writeFileSync } from 'node:fs';
import { createHash, createPrivateKey, constants, sign, X509Certificate } from 'node:crypto';
import { join } from 'node:path';
import { parseManifest, verifyArtifact } from '../../dist/install/manifest.js';
export const OWNER_PIN='f6d3d70c8909d302f24c6853dfb82dad1ab7a2a2006221699002117b6a22c682';
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export function readRegular(path,maximum,privateFile=false){
 const before=lstatSync(path);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>maximum)throw new Error('invalid_signing_file');
 const fd=openSync(path,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW|fsConstants.O_NONBLOCK);
 try{const st=fstatSync(fd);if(!st.isFile()||st.nlink!==1||st.size>maximum||st.ino!==before.ino||st.dev!==before.dev)throw new Error('invalid_signing_file');if(privateFile&&(!process.getuid||st.uid!==process.getuid()||(st.mode&0o077)))throw new Error('private_key_protection');
 const b=Buffer.alloc(st.size+1),n=readSync(fd,b,0,b.length,0);if(n!==st.size)throw new Error('signing_file_changed');return b.subarray(0,n);}finally{closeSync(fd)}
}
export function inspectCandidate(candidate,sourceSha){
 const st=lstatSync(candidate.directory);if(!st.isDirectory()||st.isSymbolicLink()||!process.getuid||st.uid!==process.getuid()||(st.mode&0o077))throw new Error('candidate_protection');
 const manifest=readRegular(join(candidate.directory,'manifest.tsv'),8192),parsed=parseManifest(manifest);
 if(parsed.sourceSha!==sourceSha||parsed.version!=='0.2.0'||sha256(manifest)!==candidate.manifestSha256||(candidate.platform&&parsed.platform!==candidate.platform)||(candidate.architecture&&parsed.architecture!==candidate.architecture))throw new Error('candidate_identity');
 for(const artifact of parsed.artifacts)verifyArtifact(artifact,readRegular(join(candidate.directory,artifact.name),artifact.size));return {manifest,parsed};
}
export async function signCandidates(candidates,{sourceSha,certificatePath,keyPath,prompt,signerPin=OWNER_PIN}){
 if(!/^[0-9a-f]{40}$/.test(sourceSha)||!candidates.length||candidates.length>5)throw new Error('signing_plan');
 const inspected=candidates.map(c=>inspectCandidate(c,sourceSha));const identities=inspected.map(x=>x.parsed.platform+'/'+x.parsed.architecture);if(new Set(identities).size!==identities.length)throw new Error('duplicate_candidate');
 const certificate=new X509Certificate(readRegular(certificatePath,16384));if(sha256(certificate.raw)!==signerPin)throw new Error('untrusted_signer');
 for(const candidate of candidates)for(const file of ['manifest.sig','signer.der']){try{lstatSync(join(candidate.directory,file));throw new Error('candidate_already_signed')}catch(e){if(e.code!=='ENOENT')throw e}}
 const pem=readRegular(keyPath,16384,true);try{
 if(!pem.toString('ascii').startsWith('-----BEGIN ENCRYPTED PRIVATE KEY-----'))throw new Error('encrypted_key_required');
 const passphrase=await prompt('Owner signing key passphrase (all five candidates): ',{hidden:true});const key=createPrivateKey({key:pem,passphrase});
 if(key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails?.modulusLength!==3072||!certificate.checkPrivateKey(key))throw new Error('signing_key_mismatch');
 // Validate every candidate again before writing any signature, after human input.
 candidates.forEach((candidate,i)=>{const now=inspectCandidate(candidate,sourceSha);if(!now.manifest.equals(inspected[i].manifest))throw new Error('candidate_changed')});
 const signatures=inspected.map(x=>sign('sha256',x.manifest,{key,padding:constants.RSA_PKCS1_PADDING}));
 candidates.forEach((candidate,i)=>{writeFileSync(join(candidate.directory,'signer.der'),certificate.raw,{flag:'wx',mode:0o600});writeFileSync(join(candidate.directory,'manifest.sig'),signatures[i],{flag:'wx',mode:0o600})});
 return inspected.map(x=>({source_sha:x.parsed.sourceSha,platform:x.parsed.platform,architecture:x.parsed.architecture,manifest_sha256:sha256(x.manifest),signer_sha256:signerPin}));
 }finally{pem.fill(0)}
}
