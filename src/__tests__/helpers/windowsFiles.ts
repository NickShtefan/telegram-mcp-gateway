import { execFileSync } from 'node:child_process';

/** Explicit protected ACL like the provisioned files directory: administrators, SYSTEM and this identity full, with optional Users read. */
export function protectWindowsFixture(path: string, usersRead = true): void {
  execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false);foreach($sid in @('S-1-5-32-544','S-1-5-18',[Security.Principal.WindowsIdentity]::GetCurrent().User.Value)){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow')))};if($env:TG_TEST_USERS_READ -eq '1'){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-545'),'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')))};Set-Acl -LiteralPath $env:TG_TEST_TARGET -AclObject $acl"],
  { env: { SystemRoot: 'C:\\Windows', TG_TEST_TARGET: path, TG_TEST_USERS_READ: usersRead ? '1' : '0' }, stdio: 'ignore', timeout: 60_000 });
}
