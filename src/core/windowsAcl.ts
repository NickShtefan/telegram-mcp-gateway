/**
 * Windows ACL check of the shared files directories. Node reports POSIX-like mode bits there that say nothing about
 * who can write, so one fixed PowerShell process reads the security descriptors of a whole batch of directories.
 */
import { spawn } from 'node:child_process';

/** First directory that failed and why, or null when every directory passed. */
export type DirectoryVerdict = { path: string; why: string } | null;
/** Checks existing directories: no reparse point, owner and every write-capable allow entry limited to trusted identities. */
export type DirectoryAttestor = (paths: readonly string[]) => Promise<DirectoryVerdict>;

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const REASONS: Record<string, string> = {
  missing: 'is missing',
  type: 'is not a directory',
  reparse: 'is a reparse point (symbolic link or junction)',
  owner: 'belongs to another user',
  writable: 'is writable by other users',
};
// Trusted: Administrators, SYSTEM and the identity of this process (the service SID when run as the service).
// Write, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions and TakeOwnership, plus the unmapped
// GENERIC_ALL/GENERIC_WRITE bits that inheritable entries keep, count as write access. Deny entries only remove rights.
// One line with explicit separators, like the installer's attestation helper.
const SCRIPT = [
  "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$i=0;",
  "function Fail([string]$Reason){[Console]::Out.Write([string]$i+' '+$Reason);exit 1};",
  'try{',
  "$trusted=@('S-1-5-32-544','S-1-5-18',[Security.Principal.WindowsIdentity]::GetCurrent().User.Value);",
  "$mutation=[int][Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership' -bor 0x50000000;",
  'foreach($p in ([Console]::In.ReadToEnd()|ConvertFrom-Json)){',
  "$item=Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue;if(-not $item){Fail 'missing'};",
  "if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){Fail 'reparse'};if(-not $item.PSIsContainer){Fail 'type'};",
  "$acl=Get-Acl -LiteralPath $p;if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted){Fail 'owner'};",
  "foreach($r in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Value -notin $trusted -and ([int]$r.FileSystemRights -band $mutation)){Fail 'writable'}};",
  '$i++}',
  "}catch{Fail 'unverified'}",
].join('');

/** One PowerShell process for the whole batch; any failure to run or parse fails closed on the first path. */
export function attestWindowsDirectories(paths: readonly string[], timeoutMs = 30_000): Promise<DirectoryVerdict> {
  if (paths.length === 0) return Promise.resolve(null);
  // ASCII-only JSON: Windows PowerShell decodes standard input with the OEM code page.
  const input = JSON.stringify(paths).replace(/[^ -~]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return new Promise(resolve => {
    let output = ''; let settled = false;
    const finish = (verdict: DirectoryVerdict): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(verdict); } };
    const unverified = (): void => finish({ path: paths[0]!, why: 'could not be checked' });
    const child = spawn(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', SCRIPT],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { SystemRoot: 'C:\\Windows' } });
    const timer = setTimeout(() => { child.kill(); unverified(); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { if (output.length < 256) output += chunk.toString('ascii'); });
    child.on('error', unverified);
    child.stdin.on('error', () => { child.kill(); unverified(); });
    child.on('close', code => {
      if (code === 0) return finish(null);
      const match = /(\d+) ([a-z]+)$/.exec(output.trim()); const path = match ? paths[Number(match[1])] : undefined;
      if (!match || !path) return unverified();
      finish({ path, why: REASONS[match[2]!] ?? 'could not be checked' });
    });
    child.stdin.end(input);
  });
}
