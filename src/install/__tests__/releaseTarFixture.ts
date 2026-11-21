import { gunzipSync } from 'node:zlib';
import { SIGNED_FILES } from '../releasePackage.js';

/** Independent reader for testing the release encoder. The shipped bootstrap has its own transport reader. */
export function decodeReleaseTar(bytes:Buffer):Map<string,Buffer> {
  const raw=gunzipSync(bytes,{maxOutputLength:300000000});const files=new Map<string,Buffer>();let at=0;let ended=false;
  const num=(h:Buffer,o:number,n:number)=>{const s=h.subarray(o,o+n).toString('ascii').replace(/\0.*$/,'');if(!/^[0-7]+$/.test(s))throw new Error('invalid_release_tar');return parseInt(s,8);};
  while(at+512<=raw.length){const h=raw.subarray(at,at+512);if(h.every(b=>b===0)){if(raw.length-at<1024||raw.subarray(at).some(b=>b!==0))throw new Error('invalid_release_tar');ended=true;break;}
    const name=h.subarray(0,100).toString('ascii').replace(/\0.*$/,'');const size=num(h,124,12);
    if(files.has(name)||h[156]!==48||h.subarray(157,257).some(b=>b!==0)||h.subarray(345).some(b=>b!==0)||h.subarray(257,263).toString()!=='ustar\0'||num(h,148,8)!==h.reduce((s,b,i)=>s+(i>=148&&i<156?32:b),0)||at+512+size>raw.length)throw new Error('invalid_release_tar');
    const end=at+512+size;const next=at+512+Math.ceil(size/512)*512;if(raw.subarray(end,next).some(b=>b!==0))throw new Error('invalid_release_tar');files.set(name,raw.subarray(at+512,end));at=next;
  }
  if(!ended)throw new Error('invalid_release_tar');const expected=SIGNED_FILES.map(name=>name==='node'&&files.has('node.exe')?'node.exe':name);
  if(files.size!==expected.length||expected.some(name=>!files.has(name)))throw new Error('invalid_release_tar');
  return files;
}
