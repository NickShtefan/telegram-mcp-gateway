import { mkdirSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (process.platform === 'darwin') {
  const source=fileURLToPath(new URL('./install/lease-helper.c',import.meta.url));
  const output=fileURLToPath(new URL('../dist/native/lease-darwin',import.meta.url));
  mkdirSync(new URL('../dist/native/',import.meta.url),{recursive:true});
  execFileSync('/usr/bin/clang',['-arch','arm64','-arch','x86_64','-mmacosx-version-min=13.0','-Os','-Wall','-Wextra','-Werror',source,'-o',output],{stdio:'inherit',timeout:30000});
}

if (process.platform === 'win32') {
  const source=fileURLToPath(new URL('./install/service-host.cs',import.meta.url));
  const output=fileURLToPath(new URL('../dist/native/service-host.exe',import.meta.url));
  mkdirSync(new URL('../dist/native/',import.meta.url),{recursive:true});
  const compiler=(process.env.SystemRoot || 'C:\\Windows')+'\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  execFileSync(compiler,['/nologo','/target:exe','/out:'+output,'/r:System.ServiceProcess.dll','/r:System.Web.Extensions.dll',source],{stdio:'inherit',timeout:30000});
}

if (process.platform === 'win32') {
  mkdirSync(new URL('../dist/setup/', import.meta.url), { recursive: true });
  for (const name of ['owner-protection.ps1', 'owner-windows.ps1', 'provision-windows.ps1', 'client-protection.ps1']) copyFileSync(new URL('./install/' + name, import.meta.url), new URL('../dist/setup/' + name, import.meta.url));
}
