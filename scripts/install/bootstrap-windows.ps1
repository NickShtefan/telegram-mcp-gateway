# Independently authenticated verification entry. Install requires an elevated owner terminal.
param([string]$Bundle,[string]$Archive,[string]$SignerSha256='f6d3d70c8909d302f24c6853dfb82dad1ab7a2a2006221699002117b6a22c682',[string]$SourceSha,[switch]$Prepare,[switch]$Install)
$ErrorActionPreference='Stop'
function Fail { throw 'bootstrap_verification_failed' }
function AssertSignerPin([string]$Value) { if($Value -cne 'f6d3d70c8909d302f24c6853dfb82dad1ab7a2a2006221699002117b6a22c682'){Fail} }
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
function Regular([string]$Path,[long]$Maximum) {
  $item=Get-Item -LiteralPath $Path -Force
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt $Maximum) { Fail }
  return $item
}
function AssertStagingAncestors([string]$Path) {
  $current=Get-Item -LiteralPath $Path -Force
  for(;$current;$current=$current.Parent){
    if($current.Attributes -band [IO.FileAttributes]::ReparsePoint){Fail}
    $acl=Get-Acl -LiteralPath $current.FullName
    $owner=if($acl.Owner -match '^S-1-'){$acl.Owner}else{(New-Object Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value}
    if($owner -notin @('S-1-5-32-544','S-1-5-18')){Fail}
    $mutation=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
    if($current.FullName -in @('C:\','C:\ProgramData')){$mutation=$mutation -band (-bnot ([Security.AccessControl.FileSystemRights]::CreateFiles -bor [Security.AccessControl.FileSystemRights]::CreateDirectories))}
    foreach($rule in $acl.Access){
      if($rule.AccessControlType -ne 'Allow' -or ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)){continue}
      if($rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-32-544','S-1-5-18') -and ($rule.FileSystemRights -band $mutation)){Fail}
    }
  }
}
function RemoveStaging([string]$Parent,[string]$Path) {
  # Only this run's GUID directory directly inside the attested staging parent. Links are removed, never followed.
  if([IO.Path]::GetDirectoryName($Path) -cne $Parent -or [IO.Path]::GetFileName($Path) -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'){Fail}
  AssertStagingAncestors $Parent
  $root=New-Object IO.DirectoryInfo $Path
  if(-not $root.Exists){return}
  if($root.Attributes -band [IO.FileAttributes]::ReparsePoint){$root.Delete();return}
  RemoveTree $root
}
function RemoveTree([IO.DirectoryInfo]$Directory) {
  foreach($child in @($Directory.EnumerateFileSystemInfos())){
    $link=[bool]($child.Attributes -band [IO.FileAttributes]::ReparsePoint)
    if($child -is [IO.DirectoryInfo] -and -not $link){RemoveTree $child;continue}
    if(-not $link -and ($child.Attributes -band [IO.FileAttributes]::ReadOnly)){$child.Attributes=[IO.FileAttributes]::Normal}
    # A non-recursive delete of a junction or symbolic link removes only the link.
    $child.Delete()
  }
  $Directory.Delete()
}
function NativeReader {
  if('TgBootstrapNative' -as [type]){return}
  $assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName 'TgBootstrapNative'),[Reflection.Emit.AssemblyBuilderAccess]::Run)
  $module=$assembly.DefineDynamicModule('Native');$type=$module.DefineType('TgBootstrapNative',[Reflection.TypeAttributes]::Public)
  $flags=[Reflection.MethodAttributes]::Public -bor [Reflection.MethodAttributes]::Static -bor [Reflection.MethodAttributes]::PinvokeImpl
  $signature=@([string],[uint32],[uint32],[IntPtr],[uint32],[uint32],[IntPtr])
  $method=$type.DefinePInvokeMethod('CreateFileW','kernel32.dll',$flags,[Reflection.CallingConventions]::Standard,[IntPtr],$signature,[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
  $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
  $method=$type.DefinePInvokeMethod('GetFileInformationByHandle','kernel32.dll',$flags,[Reflection.CallingConventions]::Standard,[bool],@([IntPtr],[IntPtr]),[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
  $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
  $method=$type.DefinePInvokeMethod('GetFinalPathNameByHandleW','kernel32.dll',$flags,[Reflection.CallingConventions]::Standard,[uint32],@([IntPtr],[Text.StringBuilder],[uint32],[uint32]),[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
  $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
  $null=$type.CreateType()
}
function BoundedBytes([string]$Path,[long]$Maximum) {
  NativeReader
  $full=[IO.Path]::GetFullPath($Path);if($full -cnotmatch '^[A-Za-z]:\\'){Fail}
  # Share-read only, open the final reparse object itself, then inspect the handle.
  $handle=[TgBootstrapNative]::CreateFileW($full,[uint32]2147483648,1,[IntPtr]::Zero,3,[uint32]2097152,[IntPtr]::Zero)
  if($handle -eq [IntPtr](-1)){Fail}
  $safe=New-Object Microsoft.Win32.SafeHandles.SafeFileHandle($handle,$true)
  $information=[Runtime.InteropServices.Marshal]::AllocHGlobal(52)
  try {
    if(-not [TgBootstrapNative]::GetFileInformationByHandle($handle,$information)){Fail}
    $attributes=[Runtime.InteropServices.Marshal]::ReadInt32($information,0)
    $sizeHigh=[uint32][Runtime.InteropServices.Marshal]::ReadInt32($information,32);$sizeLow=[uint32][Runtime.InteropServices.Marshal]::ReadInt32($information,36)
    $links=[Runtime.InteropServices.Marshal]::ReadInt32($information,40)
    if(($attributes -band 1040) -or $links -ne 1 -or $sizeHigh -ne 0 -or $sizeLow -gt $Maximum){Fail}
    $resolved=New-Object Text.StringBuilder 32768;$count=[TgBootstrapNative]::GetFinalPathNameByHandleW($handle,$resolved,32768,0)
    if($count -eq 0 -or $count -ge 32768 -or -not [string]::Equals($resolved.ToString(),'\\?\'+$full,[StringComparison]::OrdinalIgnoreCase)){Fail}
    $stream=New-Object IO.FileStream($safe,[IO.FileAccess]::Read)
    try {
      $memory=New-Object IO.MemoryStream
      try {$buffer=New-Object byte[] 65536
        while(($count=$stream.Read($buffer,0,$buffer.Length)) -gt 0){if($memory.Length+$count -gt $Maximum){Fail};$memory.Write($buffer,0,$count)}
        return ,$memory.ToArray()
      }finally{$memory.Dispose()}
    }finally{$stream.Dispose()}
  }finally{[Runtime.InteropServices.Marshal]::FreeHGlobal($information);$safe.Dispose()}
}
function ReadReleaseArchive([string]$Path) {
  [byte[]]$bytes=BoundedBytes $Path 134217728
  $framework=Join-Path ([Environment]::GetFolderPath('Windows')) 'Microsoft.NET\Framework64\v4.0.30319'
  $null=[Reflection.Assembly]::LoadFrom((Join-Path $framework 'System.IO.Compression.dll'))
  $memory=[IO.MemoryStream]::new($bytes,$false)
  $zip=[IO.Compression.ZipArchive]::new($memory,[IO.Compression.ZipArchiveMode]::Read,$false)
  $limits=@{'manifest.tsv'=8192;'manifest.sig'=384;'signer.der'=16384;'node.exe'=134217728;'installer.mjs'=1048576;'manifest.mjs'=1048576;'archive.mjs'=1048576;'application.tar.gz'=134217728;'NODE_LICENSE'=1048576}
  $result=@{};$total=0
  try {
    if($zip.Entries.Count -ne 9){Fail}
    foreach($entry in $zip.Entries){
      if($entry.FullName -cnotin @($limits.Keys) -or $result.ContainsKey($entry.FullName) -or $entry.Length -lt 1 -or $entry.Length -gt $limits[$entry.FullName] -or (($entry.ExternalAttributes -shr 16) -band 61440) -notin @(0,32768)){Fail}
      $total+=$entry.Length;if($total -gt 300000000){Fail}
      $input=$entry.Open();$output=New-Object IO.MemoryStream
      try {$buffer=New-Object byte[] 65536;while(($count=$input.Read($buffer,0,$buffer.Length)) -gt 0){if($output.Length+$count -gt $limits[$entry.FullName]){Fail};$output.Write($buffer,0,$count)}
        if($output.Length -ne $entry.Length){Fail};$result[$entry.FullName]=$output.ToArray()
      }finally{$input.Dispose();$output.Dispose()}
    }
    return $result
  }finally{$zip.Dispose();$memory.Dispose()}
}
function HashBytes([byte[]]$Bytes) {
  $sha=[Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
}
$stage=$null;$keep=$false
try {
  AssertSignerPin $SignerSha256
  if($SignerSha256 -cnotmatch '^[0-9a-f]{64}$' -or ($SourceSha -and $SourceSha -cnotmatch '^[0-9a-f]{40}$') -or ([bool]$Bundle -eq [bool]$Archive)){Fail}
  $transport=if($Archive){ReadReleaseArchive $Archive}else{$null}
  if($transport){[byte[]]$manifest=$transport['manifest.tsv'];[byte[]]$signature=$transport['manifest.sig'];[byte[]]$certificateBytes=$transport['signer.der']}
  else{
    $manifestPath=Join-Path $Bundle 'manifest.tsv';$signaturePath=Join-Path $Bundle 'manifest.sig';$certificatePath=Join-Path $Bundle 'signer.der'
    [byte[]]$manifest=(BoundedBytes $manifestPath 8192);[byte[]]$signature=(BoundedBytes $signaturePath 384);[byte[]]$certificateBytes=(BoundedBytes $certificatePath 16384)
  }
  if($signature.Length -ne 384){Fail}
  if((HashBytes $certificateBytes) -cne $SignerSha256){Fail}
  $certificate=New-Object Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList @(,$certificateBytes)
  $rsa=[Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($certificate)
  try {
    if($rsa.KeySize -ne 3072 -or -not $rsa.VerifyData($manifest,$signature,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)){Fail}
  } finally { $rsa.Dispose();$certificate.Dispose() }
  foreach($byte in $manifest){if($byte -gt 127 -or ($byte -lt 32 -and $byte -ne 9 -and $byte -ne 10)){Fail}}
  $lines=([Text.Encoding]::ASCII.GetString($manifest)).Split([char]10)
  if(-not $SourceSha){if($lines.Length -ne 13 -or $lines[2] -cnotmatch '^source_sha\t([0-9a-f]{40})$'){Fail};$SourceSha=$lines[2].Split([char]9)[1]}
  if($lines.Length -ne 13 -or $lines[12] -cne '' -or $lines[0] -cne 'TG_MCP_RELEASE_V1' -or $lines[1] -cne "version`t0.2.0" -or $lines[2] -cne "source_sha`t$SourceSha" -or $lines[3] -cne "platform`twin32"){Fail}
  $arch=if([Environment]::Is64BitOperatingSystem){'x64'}else{Fail}
  if($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64'){$arch='arm64'}
  if($lines[4] -cne "architecture`t$arch" -or $lines[5] -cnotmatch '^node_version\t(22|24)\.[0-9]{1,3}\.[0-9]{1,3}$'){Fail}
  $nodeVersion=$lines[5].Split([char]9)[1];$numbers=$nodeVersion.Split('.')
  if($numbers[0] -eq '22' -and [int]$numbers[1] -lt 13){Fail}
  $roles=@('node','installer','manifest_helper','archive_helper','application','node_license');$names=@('node.exe','installer.mjs','manifest.mjs','archive.mjs','application.tar.gz','NODE_LICENSE')
  $payloads=@{}
  for($i=0;$i -lt 6;$i++) {
    $fields=$lines[$i+6].Split([char]9);$max=if($i -eq 0 -or $i -eq 4){134217728}else{1048576}
    if($fields.Length -ne 5 -or $fields[0] -cne 'file' -or $fields[1] -cne $roles[$i] -or $fields[2] -cne $names[$i] -or $fields[3] -cnotmatch '^[1-9][0-9]{0,8}$' -or [long]$fields[3] -gt $max -or $fields[4] -cnotmatch '^[0-9a-f]{64}$'){Fail}
    [byte[]]$bytes=if($transport){$transport[$names[$i]]}else{BoundedBytes (Join-Path $Bundle $names[$i]) $max}
    if($bytes.Length -ne [long]$fields[3] -or (HashBytes $bytes) -cne $fields[4]){Fail}
    $payloads[$names[$i]]=$bytes
  }
  if($Prepare -or $Install){
    $principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){Fail}
    $parent='C:\ProgramData\TelegramMCPGatewayStaging'
    function PrivateDirectory([string]$Path) {
      $item=Get-Item -LiteralPath $Path -Force;if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){Fail}
      $acl=Get-Acl -LiteralPath $Path;$owner=if($acl.Owner -match '^S-1-'){$acl.Owner}else{(New-Object Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value}
      if($owner -notin @('S-1-5-32-544','S-1-5-18')){Fail}
      foreach($rule in $acl.Access){if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-32-544','S-1-5-18')){Fail}}
    }
    function CreatePrivateDirectory([string]$Path) {
      $acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false)
      $admin=New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544';$acl.SetOwner($admin)
      foreach($sid in @($admin,(New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'))){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))}
      $null=[IO.Directory]::CreateDirectory($Path,$acl);PrivateDirectory $Path
    }
    AssertStagingAncestors 'C:\ProgramData'
    if(Test-Path -LiteralPath $parent){PrivateDirectory $parent}else{CreatePrivateDirectory $parent}
    AssertStagingAncestors $parent
    $stage=Join-Path $parent ([guid]::NewGuid().ToString());CreatePrivateDirectory $stage
    foreach($name in $names){[IO.File]::WriteAllBytes((Join-Path $stage $name),$payloads[$name])}
    [IO.File]::WriteAllBytes((Join-Path $stage 'manifest.tsv'),$manifest);[IO.File]::WriteAllBytes((Join-Path $stage 'manifest.sig'),$signature);[IO.File]::WriteAllBytes((Join-Path $stage 'signer.der'),$certificateBytes)
    $node=Join-Path $stage 'node.exe'
    AssertStagingAncestors $parent
    RunClean $node @((Join-Path $stage 'installer.mjs'),'--version','0.2.0','--source-sha',$SourceSha,'--signer-sha256',$SignerSha256,'--extract')
    if($Install){
      AssertStagingAncestors $parent
      RunClean (Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe') @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $stage 'application\dist\setup\provision-windows.ps1'),'-Candidate',$stage,'-SourceSha',$SourceSha,'-SignerSha256',$SignerSha256)
    }
    if($Install){[Console]::Error.WriteLine('Installation prepared. In an ordinary terminal run C:\ProgramData\TelegramMCPGateway\bin\tg-mcp-owner.cmd setup.');@{format_version=1;phase='needs_api_credentials';installed=$true;service_started=$false}|ConvertTo-Json -Compress}
    else{$keep=$true;@{format_version=1;phase='candidate_staged';candidate=$stage;installed=$false}|ConvertTo-Json -Compress}
    return
  }
  # Verification does not execute agent-writable Node/helpers or grant administration.
  @{format_version=1;phase='bundle_verified';version='0.2.0';source_sha=$SourceSha;platform='win32';architecture=$arch;node_version=$nodeVersion;installed=$false}|ConvertTo-Json -Compress
} catch { [Console]::Error.WriteLine('{"format_version":1,"error_code":"bootstrap_verification_failed"}');exit 1 }
finally {
  # Install and failed attempts leave no staged node.exe or application; -Prepare keeps the candidate it reported.
  if($stage -and -not $keep){try{RemoveStaging $parent $stage}catch{[Console]::Error.WriteLine('{"format_version":1,"warning_code":"staging_cleanup_failed"}')}}
}
