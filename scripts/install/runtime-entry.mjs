// Builder-only readers. Call only after verifying the complete official archive digest.
import { execFileSync } from 'node:child_process';
import { constants, openSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
const crcTable=Uint32Array.from({length:256},(_,value)=>{for(let i=0;i<8;i++)value=(value&1)?0xedb88320^(value>>>1):value>>>1;return value>>>0});
function crc32(bytes){let value=0xffffffff;for(const byte of bytes)value=crcTable[(value^byte)&255]^(value>>>8);return (value^0xffffffff)>>>0}
function zipEntry(archive, entry, maximum) {
  const fd=openSync(archive,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  let bytes;
  try {const st=fstatSync(fd);if(!st.isFile()||st.nlink!==1||st.size>134217728)throw new Error('runtime_archive_budget');bytes=readFileSync(fd);if(bytes.length!==st.size)throw new Error('runtime_archive_changed')}
  finally {closeSync(fd)}
  const bad=()=>{throw new Error('invalid_runtime_zip')};
  if(bytes.length<22)bad();
  let end=-1;
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--){if(bytes.readUInt32LE(i)===0x06054b50&&i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break}}
  if(end<0||bytes.readUInt16LE(end+4)!==0||bytes.readUInt16LE(end+6)!==0)bad();
  const count=bytes.readUInt16LE(end+10),size=bytes.readUInt32LE(end+12),offset=bytes.readUInt32LE(end+16);
  if(count===0||count>10000||bytes.readUInt16LE(end+8)!==count||offset+size!==end)bad();
  let cursor=offset,match;
  for(let i=0;i<count;i++){
    if(cursor+46>end||bytes.readUInt32LE(cursor)!==0x02014b50)bad();
    const flags=bytes.readUInt16LE(cursor+8),method=bytes.readUInt16LE(cursor+10),crc=bytes.readUInt32LE(cursor+16),compressed=bytes.readUInt32LE(cursor+20),length=bytes.readUInt32LE(cursor+24);
    const nameLength=bytes.readUInt16LE(cursor+28),extraLength=bytes.readUInt16LE(cursor+30),commentLength=bytes.readUInt16LE(cursor+32),local=bytes.readUInt32LE(cursor+42);
    const next=cursor+46+nameLength+extraLength+commentLength;
    if(next>end||bytes.readUInt16LE(cursor+34)!==0||compressed===0xffffffff||length===0xffffffff||local===0xffffffff)bad();
    const name=bytes.subarray(cursor+46,cursor+46+nameLength);
    if(name.equals(Buffer.from(entry,'utf8'))){
      if(match||flags&1||![0,8].includes(method)||(method===0&&compressed!==length)||length>maximum||local+30>offset||bytes.readUInt32LE(local)!==0x04034b50)bad();
      const localNameLength=bytes.readUInt16LE(local+26),localExtraLength=bytes.readUInt16LE(local+28),start=local+30+localNameLength+localExtraLength;
      if(bytes.readUInt16LE(local+6)!==flags||bytes.readUInt16LE(local+8)!==method||!bytes.subarray(local+30,local+30+localNameLength).equals(name)||start+compressed>offset)bad();
      match={method,crc,length,start,compressed};
    }
    cursor=next;
  }
  if(cursor!==end||!match)bad();
  const encoded=bytes.subarray(match.start,match.start+match.compressed);
  const output=match.method===0?Buffer.from(encoded):inflateRawSync(encoded,{maxOutputLength:maximum});
  if(output.length!==match.length||output.length>maximum||crc32(output)!==match.crc)bad();return output;
}
export function runtimeEntry(archive, entry, maximum, zip) {
  if(!Number.isSafeInteger(maximum)||maximum<1||maximum>134217728)throw new Error('runtime_entry_budget');
  if(zip)return zipEntry(archive,entry,maximum);
  return execFileSync('/usr/bin/tar',['-xOf',archive,entry],{maxBuffer:maximum,timeout:30000});
}
