import { describe,it,expect } from 'vitest';
import { gzipSync,gunzipSync } from 'node:zlib';
import { encodeReleaseTar,decodeReleaseTar,encodeReleaseZip,SIGNED_FILES } from '../releasePackage.js';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';import { join,resolve } from 'node:path';import { pathToFileURL } from 'node:url';
const {runtimeEntry}=await import(pathToFileURL(resolve('scripts/install/runtime-entry.mjs')).href);
const files=():Map<string,Buffer>=>new Map(SIGNED_FILES.map(name=>[name,Buffer.alloc(name==='manifest.sig'?384:3,1)]));
describe('signed release transport',()=>{
 it('round-trips nine flat files and is deterministic',()=>{const value=files();expect(decodeReleaseTar(encodeReleaseTar(value))).toEqual(value);expect(encodeReleaseTar(value)).toEqual(encodeReleaseTar(value))});
 it('rejects extra paths, missing files, malformed headers and hidden data',()=>{
  const value=files();value.set('../escape',Buffer.from('bad'));expect(()=>encodeReleaseTar(value)).toThrow();value.delete('../escape');value.delete('node');expect(()=>encodeReleaseTar(value)).toThrow();
  const raw=gunzipSync(encodeReleaseTar(files()));raw[156]=50;expect(()=>decodeReleaseTar(gzipSync(raw))).toThrow();
  expect(()=>decodeReleaseTar(gzipSync(Buffer.concat([gunzipSync(encodeReleaseTar(files())),Buffer.alloc(512,1)])))).toThrow();
 });
 it('produces a Windows ZIP with identical bounded entries and no directories',()=>{
  const value=files();value.set('node.exe',value.get('node')!);value.delete('node');const dir=mkdtempSync(join(tmpdir(),'tg-release-zip-'));try{const zip=join(dir,'release.zip');writeFileSync(zip,encodeReleaseZip(value));for(const [name,data] of value)expect(runtimeEntry(zip,name,134217728,true)).toEqual(data);expect(()=>runtimeEntry(zip,'../escape',134217728,true)).toThrow()}finally{rmSync(dir,{recursive:true,force:true})}
 });
});
