import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
const {runtimeEntry}=await import(pathToFileURL(resolve('scripts/install/runtime-entry.mjs')).href);
function zip(method=0,duplicate=false):Buffer {
  const name=Buffer.from('payload'),data=Buffer.from('abc'),encoded=method===8?deflateRawSync(data):data;
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(method,8);local.writeUInt32LE(0x352441c2,14);local.writeUInt32LE(encoded.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
  const payload=Buffer.concat([local,name,encoded]);const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(method,10);central.writeUInt32LE(0x352441c2,16);central.writeUInt32LE(encoded.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);
  const record=Buffer.concat([central,name]);const directory=duplicate?Buffer.concat([record,record]):record;
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(duplicate?2:1,8);end.writeUInt16LE(duplicate?2:1,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(payload.length,16);
  return Buffer.concat([payload,directory,end]);
}
function withArchive(bytes:Buffer,check:(path:string)=>void):void {
  const directory=mkdtempSync(join(tmpdir(),'tg-zip-test-'));const path=join(directory,'fixture.zip');
  try {writeFileSync(path,bytes);check(path)}finally{rmSync(directory,{recursive:true,force:true})}
}
describe('bounded official-runtime ZIP entry reader',()=>{
  it.each([0,8])('preserves binary bytes with method %s',method=>withArchive(zip(method),path=>expect(runtimeEntry(path,'payload',3,true)).toEqual(Buffer.from('abc'))));
  it('rejects missing entries, duplicates and output over the requested budget',()=>{
    withArchive(zip(),path=>{expect(()=>runtimeEntry(path,'missing',3,true)).toThrow();expect(()=>runtimeEntry(path,'payload',2,true)).toThrow()});
    withArchive(zip(0,true),path=>expect(()=>runtimeEntry(path,'payload',3,true)).toThrow());
  });
  it.each(['crc','local_name','encrypted','truncated','disk','size'])('rejects %s corruption before returning bytes',kind=>{
    let bytes=zip();const central=40;
    if(kind==='crc')bytes[37]=0;
    if(kind==='local_name')bytes[30]=0;
    if(kind==='encrypted'){bytes.writeUInt16LE(1,6);bytes.writeUInt16LE(1,central+8)}
    if(kind==='truncated')bytes=bytes.subarray(0,bytes.length-1);
    if(kind==='disk')bytes.writeUInt16LE(1,bytes.length-18);
    if(kind==='size')bytes.writeUInt32LE(100,central+20);
    withArchive(bytes,path=>expect(()=>runtimeEntry(path,'payload',3,true)).toThrow());
  });
});
