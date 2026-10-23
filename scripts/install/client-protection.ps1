# Original unelevated user's fixed profile attestation and empty temporary-file ACL setup.
param([Parameter(Mandatory=$true)][string]$Path,[switch]$PrivateFile,[switch]$PrepareEmptyFile)
$ErrorActionPreference='Stop'
try {
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent();$principal=New-Object Security.Principal.WindowsPrincipal($identity)
  if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'elevated'}
  $sid=$identity.User.Value;$home=[Environment]::GetFolderPath('UserProfile');$full=[IO.Path]::GetFullPath($Path)
  if($full -cne $home -and -not $full.StartsWith($home+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'outside_profile'}
  function Check([string]$Target,[bool]$Private) {
    $item=Get-Item -LiteralPath $Target -Force
    if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'redirected'}
    $acl=Get-Acl -LiteralPath $Target
    $owner=if($acl.Owner -match '^S-1-'){$acl.Owner}else{(New-Object Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value}
    if($owner -notin @($sid,'S-1-5-32-544','S-1-5-18')){throw 'foreign_owner'}
    $mutation=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
    if($item.FullName -eq 'C:\'){$mutation=$mutation -band (-bnot ([Security.AccessControl.FileSystemRights]::CreateFiles -bor [Security.AccessControl.FileSystemRights]::CreateDirectories))}
    foreach($rule in $acl.Access){
      if($rule.AccessControlType -ne 'Allow'){continue};$who=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
      if($who -in @($sid,'S-1-5-32-544','S-1-5-18')){continue}
      if($Private -or ($rule.FileSystemRights -band $mutation)){throw 'foreign_access'}
    }
    return $item
  }
  $target=Check $full $false
  $parent=if($target -is [IO.DirectoryInfo]){$target.Parent}else{$target.Directory}
  for(;$parent;$parent=$parent.Parent){$null=Check $parent.FullName $false}
  if($PrepareEmptyFile){
    if($target -isnot [IO.FileInfo] -or $target.Length -ne 0 -or $target.Name -cnotmatch '^\.telegram-gateway-[0-9a-f-]{36}\.next$'){throw 'not_empty_temporary'}
    $acl=New-Object Security.AccessControl.FileSecurity;$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($identity.User)
    foreach($who in @($sid,'S-1-5-32-544','S-1-5-18')){$rule=New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $who),'FullControl','Allow');$acl.AddAccessRule($rule)}
    Set-Acl -LiteralPath $full -AclObject $acl
  }
  $null=Check $full ([bool]$PrivateFile)
} catch {[Console]::Error.WriteLine('owner_profile_unverified');exit 1}
