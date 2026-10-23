# Requires an independently authenticated candidate and an explicitly elevated owner terminal.
# No download, secret input, code compilation or general service-user shell is performed.
param([Parameter(Mandatory=$true)][string]$Candidate,[Parameter(Mandatory=$true)][string]$SourceSha,[Parameter(Mandatory=$true)][string]$SignerSha256,[int]$Port=7777,[switch]$PlanOnly)
$ErrorActionPreference='Stop'
function Fail {throw 'provision_failed'}
function RunClean([string]$Executable,[string[]]$Arguments) {
  $start=New-Object Diagnostics.ProcessStartInfo
  $start.FileName=$Executable;$start.UseShellExecute=$false
  # Closed arguments use Windows CRT quoting, including terminal backslashes.
  $quoted=foreach($argument in $Arguments){'"'+([regex]::Replace([regex]::Replace($argument,'(\\*)"','$1$1\"'),'(\\+)$','$1$1'))+'"'}
  $start.Arguments=$quoted -join ' '
  $start.EnvironmentVariables.Clear()
  $system=[Environment]::GetFolderPath('System');$windows=[Environment]::GetFolderPath('Windows')
  $start.EnvironmentVariables['SystemRoot']=$windows
  $start.EnvironmentVariables['WINDIR']=$windows
  $start.EnvironmentVariables['PATH']=$system
  $process=[Diagnostics.Process]::Start($start)
  try{$process.WaitForExit();if($process.ExitCode -ne 0){Fail}}finally{$process.Dispose()}
}
function NoReparse([string]$Path) {
  $item=Get-Item -LiteralPath $Path -Force
  if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){Fail}
  return $item
}
function Sid([object]$Identity) {
  if($Identity -is [Security.Principal.IdentityReference]){return $Identity.Translate([Security.Principal.SecurityIdentifier]).Value}
  if([string]$Identity -match '^S-1-'){return (New-Object Security.Principal.SecurityIdentifier ([string]$Identity)).Value}
  return (New-Object Security.Principal.NTAccount ([string]$Identity)).Translate([Security.Principal.SecurityIdentifier]).Value
}
function AssertProtected([string]$Path,[string]$ServiceSid='',[bool]$Private=$false,[bool]$ServiceWritable=$false,[bool]$Anchor=$false) {
  $item=NoReparse $Path;$acl=Get-Acl -LiteralPath $Path;$owner=Sid $acl.Owner
  $admins=@('S-1-5-32-544','S-1-5-18')
  $owners=$admins;if($ServiceSid -and $Private){$owners+=@($ServiceSid)}
  if($owner -notin $owners){Fail}
  $mutation=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
  $aclMutation=[Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
  if($Anchor){$mutation=$mutation -band (-bnot ([Security.AccessControl.FileSystemRights]::CreateFiles -bor [Security.AccessControl.FileSystemRights]::CreateDirectories))}
  foreach($rule in $acl.Access){
    if($rule.AccessControlType -ne 'Allow'){continue};$identity=Sid $rule.IdentityReference
    if($identity -in $admins){continue}
    if($ServiceSid -and $identity -eq $ServiceSid){
      if(($rule.FileSystemRights -band $aclMutation) -or (-not $ServiceWritable -and ($rule.FileSystemRights -band $mutation))){Fail};continue
    }
    if($Private -or ($rule.FileSystemRights -band $mutation)){Fail}
  }
  return $item
}
function AssertAncestors([string]$Path) {
  $current=Get-Item -LiteralPath $Path -Force
  for(;$current;$current=$current.Parent){
    $anchor=$current.FullName -in @('C:\','C:\ProgramData')
    $null=AssertProtected $current.FullName '' $false $false $anchor
  }
}
function AssertTree([IO.FileSystemInfo]$Item,[string]$ServiceSid='',[bool]$Private=$false,[bool]$Writable=$false) {
  $null=AssertProtected $Item.FullName $ServiceSid $Private $Writable
  if($Item -is [IO.DirectoryInfo]){foreach($child in $Item.EnumerateFileSystemInfos()){AssertTree $child $ServiceSid $Private $Writable}}
}
function Protect([string]$Path,[string]$ServiceSid,[bool]$Private,[bool]$Writable) {
  $item=NoReparse $Path
  $acl=if($item.PSIsContainer){New-Object Security.AccessControl.DirectorySecurity}else{New-Object Security.AccessControl.FileSecurity}
  $acl.SetAccessRuleProtection($true,$false)
  $inheritance=if($item.PSIsContainer){'ContainerInherit,ObjectInherit'}else{'None'}
  $admin=New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544';$system=New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'
  $acl.SetOwner($admin)
  foreach($sid in @($admin,$system)){
    $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$inheritance,'None','Allow');$acl.AddAccessRule($rule)
  }
  if($ServiceSid){$rights=if($Writable){'Modify'}else{'ReadAndExecute'};$sid=New-Object Security.Principal.SecurityIdentifier $ServiceSid;$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,$rights,$inheritance,'None','Allow')))}
  if(-not $Private){$users=New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-545';$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($users,'ReadAndExecute',$inheritance,'None','Allow')))}
  Set-Acl -LiteralPath $Path -AclObject $acl
}
try {
  if($SourceSha -cnotmatch '^[0-9a-f]{40}$' -or $SignerSha256 -cnotmatch '^[0-9a-f]{64}$' -or $Port -lt 1 -or $Port -gt 65535){Fail}
  $common=[Environment]::GetFolderPath('CommonApplicationData');if($common -cne 'C:\ProgramData'){Fail}
  $sc=Join-Path ([Environment]::GetFolderPath('System')) 'sc.exe'
  $prefix=Join-Path $common 'TelegramMCPGateway';$release=Join-Path (Join-Path $prefix 'releases') $SourceSha
  $layout=@{format_version=1;service='TelegramMCPGateway';account='NT SERVICE\TelegramMCPGateway';node=(Join-Path $release 'node.exe');entry=(Join-Path $release 'application\dist\cli\index.js');state=(Join-Path $prefix 'state');files=(Join-Path $prefix 'files');logs=(Join-Path $prefix 'logs');port=$Port;toolsets='core'}
  if($PlanOnly){@{format_version=1;phase='needs_system_approval';service=$layout.service;service_started=$false}|ConvertTo-Json -Compress;exit 0}
  $principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){Fail}
  $source=NoReparse $Candidate;if(-not $source.PSIsContainer){Fail}
  AssertAncestors $Candidate
  AssertTree $source
  # Reverify inside protected staging with its approved Node, not a caller's runtime.
  $node=Join-Path $Candidate 'node.exe';$null=NoReparse $node
  RunClean $node @((Join-Path $Candidate 'installer.mjs'),'--version','0.2.0','--source-sha',$SourceSha,'--signer-sha256',$SignerSha256,'--verify-extracted')
  $application=NoReparse (Join-Path $Candidate 'application');if(-not $application.PSIsContainer){Fail}
  $metadata=Get-Content -LiteralPath (Join-Path $application.FullName 'package.json') -Raw|ConvertFrom-Json
  if($metadata.version -cne '0.2.0'){Fail}
  $serviceHostPath=Join-Path $application.FullName 'dist\native\service-host.exe';$null=NoReparse $serviceHostPath
  function AssertAdminOwned([string]$Path) { $null=AssertProtected $Path }
  $receiptPath=Join-Path $prefix 'install.json'
  $receipt=@{format_version=1;source_sha=$SourceSha;signer_sha256=$SignerSha256;port=$Port;stage='prefix'}
  if(Test-Path -LiteralPath $prefix) {
    AssertAdminOwned $prefix;AssertAdminOwned $receiptPath
    $saved=Get-Content -LiteralPath $receiptPath -Raw|ConvertFrom-Json
    if($saved.format_version -ne 1 -or $saved.source_sha -cne $SourceSha -or $saved.signer_sha256 -cne $SignerSha256 -or $saved.port -ne $Port -or $saved.stage -notin @('prefix','release','service','state','complete')){Fail}
    $receipt.stage=$saved.stage
  } else {
    if(Get-Service -Name $layout.service -ErrorAction SilentlyContinue){Fail}
    $null=New-Item -ItemType Directory -Path $prefix;Protect $prefix '' $true $false
    $receipt|ConvertTo-Json -Compress|Set-Content -LiteralPath $receiptPath -Encoding UTF8
    Protect $receiptPath '' $true $false
  }
  function SaveStage([string]$Name) {
    $receipt.stage=$Name;$temporary=$receiptPath+'.next'
    if(Test-Path -LiteralPath $temporary){AssertAdminOwned $temporary;Remove-Item -LiteralPath $temporary}
    $receipt|ConvertTo-Json -Compress|Set-Content -LiteralPath $temporary -Encoding UTF8
    Protect $temporary '' $true $false;Move-Item -LiteralPath $temporary -Destination $receiptPath -Force
  }
  function CopyMatching([string]$From,[string]$To) {
    $item=NoReparse $From
    if($item.PSIsContainer){
      if(Test-Path -LiteralPath $To){$target=NoReparse $To;AssertAdminOwned $To;if(-not $target.PSIsContainer){Fail}}
      else{$null=New-Item -ItemType Directory -Path $To}
      foreach($child in $item.EnumerateFileSystemInfos()){CopyMatching $child.FullName (Join-Path $To $child.Name)}
    } else {
      if(Test-Path -LiteralPath $To){$target=NoReparse $To;AssertAdminOwned $To;if($target.PSIsContainer -or (Get-FileHash -LiteralPath $To -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath $From -Algorithm SHA256).Hash){Fail}}
      else{Copy-Item -LiteralPath $From -Destination $To}
    }
  }
  AssertAncestors $prefix
  if(-not(Test-Path -LiteralPath (Join-Path $prefix 'releases'))){$null=New-Item -ItemType Directory -Path (Join-Path $prefix 'releases')}
  AssertAncestors (Join-Path $prefix 'releases')
  if(-not(Test-Path -LiteralPath $release)){$null=New-Item -ItemType Directory -Path $release}
  AssertAncestors $release;AssertTree (Get-Item -LiteralPath $release)
  CopyMatching $node $layout.node;CopyMatching $application.FullName (Join-Path $release 'application');SaveStage 'release'
  $installedHost=Join-Path $release 'application\dist\native\service-host.exe'
  $existing=Get-CimInstance Win32_Service -Filter "Name='TelegramMCPGateway'"
  if($existing){if($existing.StartName -cne $layout.account -or $existing.PathName -cne ('"'+$installedHost+'"') -or $existing.State -ne 'Stopped' -or $existing.StartMode -cne 'Manual'){Fail}}
  else{& $sc create $layout.service binPath= ('"'+$installedHost+'"') start= demand obj= $layout.account;if($LASTEXITCODE -ne 0){Fail}}
  $sid=(New-Object Security.Principal.NTAccount($layout.account)).Translate([Security.Principal.SecurityIdentifier]).Value;SaveStage 'service'
  Protect $prefix $sid $false $false
  foreach($directory in @($layout.state,$layout.files,$layout.logs)){
    if(Test-Path -LiteralPath $directory){AssertTree (Get-Item -LiteralPath $directory) $sid ($directory -ne $layout.files) $true}
    else{$null=New-Item -ItemType Directory -Path $directory;Protect $directory $sid ($directory -ne $layout.files) $true}
  }
  SaveStage 'state'
  $definition=Join-Path $prefix 'service.json';$expected=$layout|ConvertTo-Json -Compress
  if(Test-Path -LiteralPath $definition){AssertAdminOwned $definition;if((Get-Content -LiteralPath $definition -Raw).Trim() -cne $expected){Fail}}
  else{$expected|Set-Content -LiteralPath $definition -Encoding UTF8;Protect $definition $sid $false $false}
  & $sc failureflag $layout.service 1;if($LASTEXITCODE -ne 0){Fail}
  & $sc failure $layout.service reset= 86400 actions= restart/3000/restart/10000/restart/30000;if($LASTEXITCODE -ne 0){Fail}
  $bin=Join-Path $prefix 'bin'
  if(-not(Test-Path -LiteralPath $bin)){$null=New-Item -ItemType Directory -Path $bin;Protect $bin $sid $false $false}
  AssertAncestors $bin
  $launcher=Join-Path $bin 'tg-mcp-owner.cmd'
  $command="@echo off`r`nsetlocal`r`nif not `"%~1`"==`"setup`" exit /b 1`r`nif not `"%~2`"==`"`" exit /b 1`r`nset NODE_OPTIONS=`r`nset NODE_PATH=`r`nset NODE_USE_ENV_PROXY=`r`n`""+$layout.node+"`" `""+(Join-Path $release 'application\dist\setup\ownerLauncher.js')+"`"`r`nexit /b %ERRORLEVEL%`r`n"
  if(Test-Path -LiteralPath $launcher){AssertAdminOwned $launcher;if((Get-Content -LiteralPath $launcher -Raw) -cne $command){Fail}}
  else{[IO.File]::WriteAllText($launcher,$command,[Text.Encoding]::ASCII);Protect $launcher $sid $false $false}
  SaveStage 'complete'
  @{format_version=1;phase='needs_api_credentials';service_started=$false}|ConvertTo-Json -Compress
} catch {[Console]::Error.WriteLine('{"format_version":1,"error_code":"provision_failed"}');exit 1}
