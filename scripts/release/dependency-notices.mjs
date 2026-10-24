// Collect installed production dependency notices, retaining complete upstream text.
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
const root=resolve('.');
let check=false;
try {
  const {values}=parseArgs({options:{check:{type:'boolean',default:false}}});check=values.check;
  const directories=execFileSync(process.execPath,[process.env.npm_execpath||'node_modules/npm/bin/npm-cli.js','ls','--omit=dev','--all','--parseable'],{encoding:'utf8',maxBuffer:1048576,timeout:30000}).trim().split(/\r?\n/).filter(path=>path!==root);
  const rows=[];
  for(const path of [...new Set(directories)].sort()) {
    if(!path.startsWith(join(root,'node_modules')+'/')&&!path.startsWith(join(root,'node_modules')+'\\'))throw new Error();
    const st=lstatSync(path);if(!st.isDirectory()||st.isSymbolicLink())throw new Error();
    const metadata=JSON.parse(readFileSync(join(path,'package.json'),'utf8'));
    const files=readdirSync(path).filter(name=>/^(license|licence|copying|notice)(?:\..*)?$/i.test(name));
    if(!metadata.name||!metadata.version||!metadata.license)throw new Error('missing notice');
    if(!files.length&&metadata.name==='imurmurhash')files.push('README.md');
    if(!files.length&&metadata.name==='store2')files.push('dist/store2.js');
    if(!files.length&&metadata.name==='qrcode-generator')files.push('dist/qrcode.mjs','dist/qrcode.d.ts');
    if(!files.length)throw new Error('missing notice');
    const notices=files.sort().map(name=>{const file=join(path,name);const info=lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.size>1048576)throw new Error();let text=readFileSync(file,'utf8');
      if(metadata.name==='imurmurhash')text=text.slice(text.indexOf('License (MIT)'));
      if(metadata.name==='store2'){const banner=text.slice(0,text.indexOf('*/')+2);const copyright=banner.match(/Copyright \(c\) [^;\r\n]+/)?.[0];const template=readFileSync('LICENSE','utf8');if(metadata.license!=='MIT'||!copyright||!template.startsWith('MIT License\n'))throw new Error();const mit=template.replace(/^Copyright .*$/m,copyright);text=banner+'\n\n'+mit;}
      if(metadata.name==='qrcode-generator'){const banner=text.slice(0,text.indexOf('\n\n'));const copyright=banner.match(/Copyright \(c\) [^\r\n]+/)?.[0];const template=readFileSync('LICENSE','utf8');if(metadata.license!=='MIT'||!banner.includes('MIT license')||!copyright||!template.startsWith('MIT License\n'))throw new Error();text=banner+'\n\n'+template.replace(/^Copyright .*$/m,copyright);}
      const origin=metadata.name==='imurmurhash'?'package README license section':['store2','qrcode-generator'].includes(metadata.name)?'package copyright banner plus standard MIT text':'package license/notice file';
      return {name,text,origin,sha256:createHash('sha256').update(text).digest('hex')};});
    rows.push({name:metadata.name,version:metadata.version,license:metadata.license,path:relative(root,path).replace(/\\/g,'/'),notices});
  }
  let output='# Third-party dependency notices\n\nGenerated from the installed production dependency graph. Upstream license/notice text and copyright attribution are retained below. The imurmurhash license is its package README license section. The store2 and qrcode-generator packages supply copyright/MIT banners; those banners are retained with the standard MIT grant using their stated copyrights. These exceptions are labeled explicitly. Node.js installer bundles separately include the exact official NODE_LICENSE.\n\n';
  for(const row of rows){output+=`## ${row.name} ${row.version}\n\nDeclared license: ${row.license}. Installed path: ${row.path}.\n\n`;for(const notice of row.notices){output+=`### ${notice.name}\n\nOrigin: ${notice.origin}. SHA-256: ${notice.sha256}.\n\n\`\`\`text\n${notice.text.replace(/\r\n/g,'\n')}\n\`\`\`\n\n`;}}
  const provenance=JSON.stringify({format_version:1,packages:rows.map(({notices,...row})=>({...row,notices:notices.map(({text,...notice})=>notice)}))},null,2)+'\n';
  if(check){
    if(readFileSync('THIRD_PARTY_NOTICES.md','utf8').replace(/\r\n/g,'\n')!==output||readFileSync('docs/dependency-provenance.json','utf8').replace(/\r\n/g,'\n')!==provenance)throw new Error();
  }else{
    writeFileSync('THIRD_PARTY_NOTICES.md',output);
    writeFileSync('docs/dependency-provenance.json',provenance);
  }
  process.stdout.write(JSON.stringify({format_version:1,production_packages:rows.length,checked:check})+'\n');
}catch{process.stderr.write(check?'dependency_notice_check_failed\n':'dependency_notice_collection_failed\n');process.exitCode=1;}
