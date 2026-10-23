import { constants, createHash, createPrivateKey, sign, X509Certificate } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { constants as fsConstants, openSync, closeSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARTIFACT_ROLES, encodeManifest, parseManifest, verifyArtifact, verifyManifest, type ReleaseManifest } from '../manifest.js';
import { encodeReleaseTar } from '../releasePackage.js';
import { decodeApplicationArchive, encodeApplicationArchive, extractApplicationArchive } from '../archive.js';

const sourceSha = 'a'.repeat(40);
const names = ['node', 'installer.mjs', 'manifest.mjs', 'archive.mjs', 'application.tar.gz', 'NODE_LICENSE'];
const manifest: ReleaseManifest = {
  version: '0.2.0', sourceSha, platform: 'darwin', architecture: 'arm64', nodeVersion: '24.10.0',
  artifacts: ARTIFACT_ROLES.map((role, i) => ({ role, name: names[i]!, size: 1, sha256: createHash('sha256').update('x').digest('hex') })),
};
const roots: string[] = [];
function root(): string { const path = mkdtempSync(join(tmpdir(), 'tg-artifact-')); roots.push(path); return path; }
afterAll(() => { for (const path of roots) rmSync(path, { recursive: true, force: true }); });
function mutation(bytes: Buffer, change: (raw: Buffer) => void): Buffer {
  const raw = gunzipSync(bytes); change(raw);
  raw.fill(32, 148, 156); const sum = raw.subarray(0,512).reduce((s,b)=>s+b,0);
  raw.write(sum.toString(8).padStart(6,'0')+'\0 ',148,8,'ascii'); return gzipSync(raw);
}

describe('closed canonical manifest', () => {
  it('round-trips ordered release identity and bounded artifact roles', () => {
    expect(parseManifest(encodeManifest(manifest))).toEqual(manifest);
  });
  it.each([
    ['platform\tdarwin','platform\twin32'], ['architecture\tarm64','architecture\tmips'],
    ['node_version\t24.10.0','node_version\t22.12.0'], ['node_version\t24.10.0','node_version\t26.0.0'],
    ['file\tnode\tnode\t1','file\tnode\t../node\t1'], ['\t1\t','\t0\t'],
  ])('rejects invalid or inconsistent metadata', (before, after) => {
    expect(() => parseManifest(Buffer.from(encodeManifest(manifest).toString().replace(before,after)))).toThrow('invalid_manifest');
  });
  it('rejects unknown/duplicate records, trailing data and control/non-ASCII content', () => {
    const text = encodeManifest(manifest).toString();
    for (const value of [text+'token\tfixture-secret\n', text.replace('file\tinstaller','file\tnode'), text+'\0',text.replace('node_license','node_licensé')]) {
      expect(() => parseManifest(Buffer.from(value))).toThrow('invalid_manifest');
    }
  });
  it('requires exact size and digest on artifact bytes', () => {
    expect(() => verifyArtifact(manifest.artifacts[0]!, Buffer.from('x'))).not.toThrow();
    expect(() => verifyArtifact(manifest.artifacts[0]!, Buffer.from('y'))).toThrow('artifact_mismatch');
    expect(() => verifyArtifact(manifest.artifacts[0]!, Buffer.from('xx'))).toThrow('artifact_mismatch');
  });
});

describe('application archive safety', () => {
  const good = () => encodeApplicationArchive([{ path:'dist/cli/index.js',data:Buffer.from('fixture') },{path:'package.json',data:Buffer.from('{}')}]);
  it('round-trips canonical regular files deterministically', () => {
    expect(good()).toEqual(good());
    expect(decodeApplicationArchive(good()).map(f=>f.path)).toEqual(['dist/cli/index.js','package.json']);
  });
  it.each(['../outside','/absolute','a/../b','a//b','C:/stream','node_modules\\bad','NUL','con.txt','file.'])('rejects unsafe path %s', path => {
    expect(()=>encodeApplicationArchive([{path,data:Buffer.from('x')}])).toThrow('unsafe_archive');
  });
  it('rejects duplicate, case-colliding and file/directory-conflicting entries', () => {
    for(const paths of [['a','a'],['A','a'],['a','a/b'],['A/x','a/y']]) {
      expect(()=>encodeApplicationArchive(paths.map(path=>({path,data:Buffer.from('x')})))).toThrow('unsafe_archive');
    }
  });
  it.each(['1','2','3','5','6','x','L'])('rejects link/device/directory/extension type %s', type => {
    expect(()=>decodeApplicationArchive(mutation(good(),b=>{b[156]=type.charCodeAt(0)}))).toThrow('unsafe_archive');
  });
  it('rejects dangerous names, modes, broken checksums and nonzero padding', () => {
    const unsafePath=mutation(good(),b=>{b.fill(0,0,100);b.write('../outside',0)});
    const unsafeMode=mutation(good(),b=>{b.write('0004755\0',100,8,'ascii')});
    const checksum=gunzipSync(good());checksum[20]=33;
    const padding=gunzipSync(good());padding[520]=33;
    for(const bytes of [unsafePath,unsafeMode,gzipSync(checksum),gzipSync(padding)])expect(()=>decodeApplicationArchive(bytes)).toThrow('unsafe_archive');
  });
  it('rejects truncated payloads and hidden trailing archives', () => {
    const raw=gunzipSync(good()); expect(()=>decodeApplicationArchive(gzipSync(raw.subarray(0,raw.length-512)))).toThrow('unsafe_archive');
    expect(()=>decodeApplicationArchive(gzipSync(Buffer.concat([raw,Buffer.alloc(512,1)])))).toThrow('unsafe_archive');
  });
  it('validates the complete archive before modifying an empty destination', async () => {
    const path=root();
    await expect(extractApplicationArchive(mutation(good(),b=>{b[156]=50}),path)).rejects.toThrow('unsafe_archive');
    expect(readdirSync(path)).toEqual([]);
  });
  it.skipIf(process.platform === 'win32')('extracts only into a new owned empty directory and never overwrites it', async () => {
    const path=root();expect(await extractApplicationArchive(good(),path)).toBe(2);
    expect(readFileSync(join(path,'dist/cli/index.js'),'utf8')).toBe('fixture');
    await expect(extractApplicationArchive(good(),path)).rejects.toThrow('unsafe_archive');
  });
  it('does not grant execution permission to arbitrary archive files', () => {
    expect(()=>encodeApplicationArchive([{path:'dist/cli/index.js',data:Buffer.from('fixture'),executable:true}])).toThrow('unsafe_archive');
  });
  it.skipIf(process.platform !== 'darwin')('executes the extracted native helper and preserves descriptor lease exclusion/release', async () => {
    const path=root();const bytes=readFileSync(resolve('dist/native/lease-darwin'));
    await extractApplicationArchive(encodeApplicationArchive([{path:'dist/native/lease-darwin',data:bytes,executable:true}]),path);
    const helper=join(path,'dist/native/lease-darwin');const lock=join(path,'lease');
    expect(lstatSync(helper).mode&0o100).toBe(0o100);
    let first: number|undefined=openSync(lock,fsConstants.O_RDWR|fsConstants.O_CREAT,0o600);let second: number|undefined;
    try {
      expect(spawnSync(helper,[],{stdio:['ignore','ignore','ignore',first]}).status).toBe(0);
      second=openSync(lock,fsConstants.O_RDWR);
      expect(spawnSync(helper,[],{stdio:['ignore','ignore','ignore',second]}).status).toBe(75);
      closeSync(first);first=undefined;
      expect(spawnSync(helper,[],{stdio:['ignore','ignore','ignore',second]}).status).toBe(0);
    } finally {if(first!==undefined)closeSync(first);if(second!==undefined)closeSync(second);}
  });
});

describe.skipIf(process.platform === 'win32')('pinned signatures and no-Node POSIX entry', () => {
  let key: ReturnType<typeof createPrivateKey>;let certificate: Buffer;let signerSha256: string;let directory: string;let keyPath: string;
  beforeAll(() => {
    directory=root();keyPath=join(directory,'fixture-key.pem');const certPath=join(directory,'fixture-cert.pem');
    execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:3072','-nodes','-keyout',keyPath,'-out',certPath,'-days','1','-subj','/CN=synthetic-installer-fixture'],{stdio:'ignore',timeout:15000});
    chmodSync(keyPath,0o600);key=createPrivateKey(readFileSync(keyPath));certificate=new X509Certificate(readFileSync(certPath)).raw;
    signerSha256=createHash('sha256').update(certificate).digest('hex');
  },20000);
  it('accepts only independently pinned signer and exact release/platform', () => {
    const bytes=encodeManifest(manifest);const signature=sign('sha256',bytes,{key,padding:constants.RSA_PKCS1_PADDING});
    const policy={signerSha256,version:'0.2.0',sourceSha,platform:'darwin' as const,architecture:'arm64' as const};
    expect(verifyManifest(bytes,signature,certificate,policy)).toEqual(manifest);
    expect(()=>verifyManifest(bytes,signature,certificate,{...policy,signerSha256:'0'.repeat(64)})).toThrow('untrusted_signer');
    expect(()=>verifyManifest(bytes,signature,certificate,{...policy,sourceSha:'b'.repeat(40)})).toThrow('wrong_release');
    expect(()=>verifyManifest(bytes,signature,certificate,{...policy,platform:'linux'})).toThrow('wrong_platform');
    const changed=Buffer.from(bytes);changed[0]=88;expect(()=>verifyManifest(changed,signature,certificate,policy)).toThrow('invalid_signature');
  });
  it('builds and verifies a candidate with only system tools in PATH, then rejects tampering', () => {
    const app=join(directory,'application-source');mkdirSync(app,{mode:0o700});writeFileSync(join(app,'package.json'),'{}');
    const license=join(directory,'NODE_LICENSE');writeFileSync(license,'Synthetic license placeholder for the local fixture only.');
    const certPath=join(directory,'signer.der');writeFileSync(certPath,certificate);
    const bundle=join(directory,'bundle');
    const result=spawnSync(process.execPath,[resolve('scripts/install/build-bundle.mjs'),'--output',bundle,'--application',app,'--node',process.execPath,
      '--node-version',process.versions.node,'--node-license',license,'--signing-key',keyPath,'--certificate',certPath,
      '--source-sha',sourceSha,'--platform',process.platform,'--architecture',process.arch,'--fixture-runtime'],{encoding:'utf8',timeout:20000});
    expect(result.status,result.stderr).toBe(0);expect(readdirSync(bundle)).not.toContain('fixture-key.pem');
    const production=readFileSync(resolve('scripts/install/bootstrap-posix.sh'),'utf8');
    // Test keys are pinned only in a disposable copy; production has no pin override.
    const original=production.replace("trusted_signer_sha256='f6d3d70c8909d302f24c6853dfb82dad1ab7a2a2006221699002117b6a22c682'",`trusted_signer_sha256='${signerSha256}'`);
    expect(original).not.toBe(production);
    const fixtureBootstrap=join(directory,'fixture-bootstrap.sh');writeFileSync(fixtureBootstrap,original);
    const productionRejected=spawnSync('/bin/sh',[resolve('scripts/install/bootstrap-posix.sh'),bundle,sourceSha,'verify'],{encoding:'utf8',timeout:20000});
    expect(productionRejected.status).toBe(1);expect(productionRejected.stderr).toContain('bootstrap_verification_failed');
    const overrideRejected=spawnSync('/bin/sh',[resolve('scripts/install/bootstrap-posix.sh'),bundle,signerSha256,sourceSha,'verify'],{encoding:'utf8',timeout:20000});
    expect(overrideRejected.status).toBe(1);
    const invoke=()=>spawnSync('/bin/sh',[fixtureBootstrap,bundle,sourceSha,'verify'],{env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:20000});
    const verified=invoke();expect(verified.status,verified.stderr).toBe(0);expect(JSON.parse(verified.stdout)).toMatchObject({phase:'candidate_verified',installed:false,node_version:process.versions.node,version:'0.2.0'});
    const transport=join(directory,'release.tar.gz');
    const transportNames=['manifest.tsv','manifest.sig','signer.der',...names];
    writeFileSync(transport,encodeReleaseTar(new Map(transportNames.map(name=>[name,readFileSync(join(bundle,name))]))));
    const archiveResult=spawnSync('/bin/sh',[fixtureBootstrap,transport,'verify'],{env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:20000});
    expect(archiveResult.status,archiveResult.stderr).toBe(0);expect(JSON.parse(archiveResult.stdout)).toMatchObject({source_sha:sourceSha,installed:false});
    // Release-notes commands pin the exact source: another owner-signed build is rejected.
    const archiveRun=(...args:string[])=>spawnSync('/bin/sh',[fixtureBootstrap,...args],{env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:20000});
    const pinned=archiveRun(transport,sourceSha,'verify');expect(pinned.status,pinned.stderr).toBe(0);expect(JSON.parse(pinned.stdout)).toMatchObject({source_sha:sourceSha});
    const otherBuild=archiveRun(transport,'b'.repeat(40),'verify');expect(otherBuild.status).toBe(1);expect(otherBuild.stdout).toBe('');expect(otherBuild.stderr).toContain('bootstrap_verification_failed');
    const shortPin=archiveRun(transport,'a'.repeat(39),'verify');expect(shortPin.status).toBe(1);expect(shortPin.stderr).toContain('bootstrap_verification_failed');
    // A browser that expanded the download leaves no archive at the documented path.
    const expanded=archiveRun(join(directory,'telegram-mcp-gateway-0.2.0-macos-arm64.tar.gz'),'verify');expect(expanded.status).toBe(1);expect(expanded.stderr).toContain('bootstrap_archive_missing');
    const unpinnedDirectory=archiveRun(bundle,'verify');expect(unpinnedDirectory.status).toBe(1);expect(unpinnedDirectory.stderr).toContain('bootstrap_verification_failed');
    const archiveBytes=readFileSync(transport);writeFileSync(transport,archiveBytes.subarray(0,archiveBytes.length-8));
    const brokenArchive=spawnSync('/bin/sh',[fixtureBootstrap,transport,'verify'],{env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:20000});expect(brokenArchive.status).toBe(1);
    // Deterministic adversarial interleavings after pathname prechecks and
    // before snapshot sysopen. The injected code is a local test shim only.
    const installer=join(bundle,'installer.mjs');const originalInstaller=readFileSync(installer);
    for(const kind of ['fifo','oversized'] as const) {
      const shim=join(directory,`snapshot-${kind}.sh`);
      const attack=kind==='fifo'
        ? '/bin/rm -f "$1"; /usr/bin/mkfifo -m 600 "$1"'
        : `/usr/bin/perl -e 'open(my $f,"+<",$ARGV[0]) or die; truncate($f,2000000) or die;' "$1"`;
      const script=original.replace('snapshot() {',`snapshot() {\n  case "$1" in */installer.mjs) ${attack} ;; esac`);
      writeFileSync(shim,script);
      const attacked=spawnSync('/bin/sh',[shim,bundle,signerSha256,sourceSha,'verify'],{env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:5000});
      expect(attacked.error).toBeUndefined();expect(attacked.status).toBe(1);expect(attacked.stderr).toContain('bootstrap_verification_failed');
      rmSync(installer);writeFileSync(installer,originalInstaller,{mode:0o600});
    }
    writeFileSync(join(bundle,'application.tar.gz'),'tampered');const rejected=invoke();expect(rejected.status).toBe(1);expect(rejected.stdout).toBe('');
    expect(rejected.stderr).not.toContain(keyPath);expect(rejected.stderr).toContain('bootstrap_verification_failed');
  },30000);
});
