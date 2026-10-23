/** Transport containers contain only the nine flat, regular signed-bundle files. */
import { gzipSync, gunzipSync } from 'node:zlib';
export const SIGNED_FILES = ['manifest.tsv','manifest.sig','signer.der','node','installer.mjs','manifest.mjs','archive.mjs','application.tar.gz','NODE_LICENSE'] as const;
const table=Uint32Array.from({length:256},(_,v)=>{for(let i=0;i<8;i++)v=v&1?0xedb88320^(v>>>1):v>>>1;return v>>>0;});
export function crc32(bytes:Buffer):number {let v=0xffffffff;for(const b of bytes)v=table[(v^b)&255]!^(v>>>8);return (v^0xffffffff)>>>0;}
function check(files:ReadonlyMap<string,Buffer>):void {
  const expected=SIGNED_FILES.map(n=>files.has('node.exe')&&n==='node'?'node.exe':n);
  if(files.size!==9||expected.some(n=>!files.has(n)))throw new Error('invalid_release_files');
  let total=0;for(const [name,data] of files){const max=name==='node'||name==='node.exe'||name==='application.tar.gz'?134217728:name==='manifest.tsv'?8192:name==='manifest.sig'?384:name==='signer.der'?16384:1048576;
    total+=data.length;if(data.length<1||data.length>max)throw new Error('release_budget');}
  if(total>300000000)throw new Error('release_budget');
}
export function encodeReleaseTar(files:ReadonlyMap<string,Buffer>):Buffer {
  check(files);const chunks:Buffer[]=[];
  for(const [name,data] of [...files].sort(([a],[b])=>a.localeCompare(b))){
    const h=Buffer.alloc(512);h.write(name,0,100,'ascii');
    const oct=(at:number,len:number,n:number)=>h.write(n.toString(8).padStart(len-1,'0')+'\0',at,len,'ascii');
    oct(100,8,0o600);oct(108,8,0);oct(116,8,0);oct(124,12,data.length);oct(136,12,0);h.fill(32,148,156);h[156]=48;h.write('ustar\0',257,6,'ascii');h.write('00',263,2,'ascii');
    h.write(h.reduce((sum,b)=>sum+b,0).toString(8).padStart(6,'0')+'\0 ',148,8,'ascii');chunks.push(h,data,Buffer.alloc((512-data.length%512)%512));
  }
  const bytes=gzipSync(Buffer.concat([...chunks,Buffer.alloc(1024)]),{level:6});if(bytes.length>134217728)throw new Error('release_budget');return bytes;
}
export function decodeReleaseTar(bytes:Buffer):Map<string,Buffer> {
  const raw=gunzipSync(bytes,{maxOutputLength:300000000});const files=new Map<string,Buffer>();let at=0;let ended=false;
  const num=(h:Buffer,o:number,n:number)=>{const s=h.subarray(o,o+n).toString('ascii').replace(/\0.*$/,'');if(!/^[0-7]+$/.test(s))throw new Error('invalid_release_tar');return parseInt(s,8);};
  while(at+512<=raw.length){const h=raw.subarray(at,at+512);if(h.every(b=>b===0)){if(raw.length-at<1024||raw.subarray(at).some(b=>b!==0))throw new Error('invalid_release_tar');ended=true;break;}
    const name=h.subarray(0,100).toString('ascii').replace(/\0.*$/,'');const size=num(h,124,12);
    if(files.has(name)||h[156]!==48||h.subarray(157,257).some(b=>b!==0)||h.subarray(345).some(b=>b!==0)||h.subarray(257,263).toString()!=='ustar\0'||num(h,148,8)!==h.reduce((s,b,i)=>s+(i>=148&&i<156?32:b),0)||at+512+size>raw.length)throw new Error('invalid_release_tar');
    const end=at+512+size;const next=at+512+Math.ceil(size/512)*512;if(raw.subarray(end,next).some(b=>b!==0))throw new Error('invalid_release_tar');files.set(name,raw.subarray(at+512,end));at=next;
  }
  if(!ended)throw new Error('invalid_release_tar');check(files);return files;
}
export function encodeReleaseZip(files:ReadonlyMap<string,Buffer>):Buffer {
  check(files);const local:Buffer[]=[];const central:Buffer[]=[];let offset=0;
  for(const [name,data] of [...files].sort(([a],[b])=>a.localeCompare(b))){const n=Buffer.from(name);const crc=crc32(data);const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt32LE(crc,14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(n.length,26);
    const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(0x314,4);c.writeUInt16LE(20,6);c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE((0o100600<<16)>>>0,38);c.writeUInt32LE(offset,42);local.push(h,n,data);central.push(c,n);offset+=h.length+n.length+data.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.size,8);end.writeUInt16LE(files.size,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);const result=Buffer.concat([...local,directory,end]);if(result.length>134217728)throw new Error('release_budget');return result;
}
