# Fixed service-private attestation helper for the installed owner worker.
param([Parameter(Mandatory=$true)][string]$Path,[switch]$RequireServiceIdentity)
$ErrorActionPreference='Stop'
try {
  $prefix='C:\ProgramData\TelegramMCPGateway'
  $sid=(New-Object Security.Principal.NTAccount('NT SERVICE\TelegramMCPGateway')).Translate([Security.Principal.SecurityIdentifier]).Value
  if($RequireServiceIdentity -and [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne $sid){throw 'invalid'}
  $full=[IO.Path]::GetFullPath($Path)
  if(-not $full.StartsWith($prefix+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'invalid'}
  $mutation=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
  function Check([string]$Target,[bool]$Private,[bool]$Writable) {
    $item=Get-Item -LiteralPath $Target -Force
    if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'invalid'}
    $acl=Get-Acl -LiteralPath $Target;$owner=$acl.Owner
    $owner=if($owner -match '^S-1-'){(New-Object Security.Principal.SecurityIdentifier $owner).Value}else{(New-Object Security.Principal.NTAccount($owner)).Translate([Security.Principal.SecurityIdentifier]).Value}
    if($owner -notin @('S-1-5-32-544','S-1-5-18',$sid)){throw 'invalid'}
    if(-not $Private -and $owner -eq $sid){throw 'invalid'}
    foreach($rule in $acl.Access){
      if($rule.AccessControlType -ne 'Allow'){continue}
      $who=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
      if($who -in @('S-1-5-32-544','S-1-5-18')){continue}
      if($who -eq $sid){
        $forbidden=if($Writable){[Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership}else{$mutation}
        if($rule.FileSystemRights -band $forbidden){throw 'invalid'}
      } elseif($Private -or ($rule.FileSystemRights -band $mutation)){throw 'invalid'}
    }
    if($Private -and $item -is [IO.DirectoryInfo]){foreach($child in $item.EnumerateFileSystemInfos()){Check $child.FullName $true $Writable}}
  }
  # Installed parent is immutable to the service; private subtrees are inherited to it only.
  Check $prefix $false $false
  $current=[IO.Path]::GetDirectoryName($full)
  while($current -and $current -ne $prefix){
    $private=$current -eq (Join-Path $prefix 'state') -or $current -eq (Join-Path $prefix 'owner-setup')
    Check $current $private $private
    $current=[IO.Path]::GetDirectoryName($current)
  }
  $private=$full -eq (Join-Path $prefix 'state') -or $full.StartsWith((Join-Path $prefix 'state')+'\',[StringComparison]::OrdinalIgnoreCase) -or $full -eq (Join-Path $prefix 'owner-setup') -or $full.StartsWith((Join-Path $prefix 'owner-setup')+'\',[StringComparison]::OrdinalIgnoreCase)
  Check $full $private $private
} catch {[Console]::Error.WriteLine('protection_unverified');exit 1}
