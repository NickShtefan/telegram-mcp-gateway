// Read the checksum-authenticated official Windows archive with the production reader.
// No Windows executable, service, signing key or privileged operation is used.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runtimeEntry } from '../install/runtime-entry.mjs';
const catalog=JSON.parse(readFileSync(new URL('../install/runtime-catalog.json',import.meta.url),'utf8'));
const record=catalog.runtimes.find(r=>r.version==='24.21.0'&&r.platform==='win32'&&r.architecture==='x64');
const archive=process.argv[2];if(!archive)throw new Error('archive argument missing');
if(createHash('sha256').update(readFileSync(archive)).digest('hex')!==record.sha256)throw new Error('official digest mismatch');
const bytes=runtimeEntry(archive,'node-v24.21.0-win-x64/node.exe',134217728,true);
const license=runtimeEntry(archive,'node-v24.21.0-win-x64/LICENSE',1048576,true);
if(bytes.readUInt16LE(0)!==0x5a4d||license.length===0)throw new Error('payload mismatch');
let rejected=false;try{runtimeEntry(archive,'node-v24.21.0-win-x64/node.exe',bytes.length-1,true)}catch{rejected=true};if(!rejected)throw new Error('budget not enforced');
rejected=false;try{runtimeEntry(archive,'missing',134217728,true)}catch{rejected=true};if(!rejected)throw new Error('missing entry accepted');
console.log(JSON.stringify({bytes:bytes.length,budget_rejection:true,missing_rejection:true}));
