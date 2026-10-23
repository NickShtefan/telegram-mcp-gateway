# Synthetic child-environment and ancestor regressions, no bootstrap body/service operation.
$ErrorActionPreference='Stop'
$directory=Join-Path ([IO.Path]::GetTempPath()) ('tg-clean-'+[guid]::NewGuid().ToString())
$null=New-Item -ItemType Directory -Path $directory
$node=(Get-Command node.exe).Source
$oldOptions=$env:NODE_OPTIONS;$oldPath=$env:NODE_PATH
try {
  $marker=Join-Path $directory 'injected';$preload=Join-Path $directory 'preload.cjs';$probe=Join-Path $directory 'probe.cjs';$output=Join-Path $directory 'result.json'
  [IO.File]::WriteAllText($preload,('require("node:fs").writeFileSync('+($marker|ConvertTo-Json -Compress)+',"injected")'))
  [IO.File]::WriteAllText($probe,'if(process.env.NODE_OPTIONS||process.env.NODE_PATH)process.exit(1);require("node:fs").writeFileSync(process.argv[2],JSON.stringify(process.argv.slice(3)))')
  $env:NODE_OPTIONS='--require="'+$preload+'"';$env:NODE_PATH=$directory
  foreach($entry in @('bootstrap-windows.ps1','provision-windows.ps1')) {
    $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Resolve-Path ('scripts/install/'+$entry)).Path,[ref]$tokens,[ref]$errors)
    if($errors.Count){throw 'parse failed'}
    foreach($name in @('Fail','RunClean')){
      $function=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true)
      if(@($function).Count -ne 1){throw 'missing helper'};. ([scriptblock]::Create($function[0].Extent.Text))
    }
    $literal='space quote" and trailing\'
    RunClean $node @($probe,$output,$literal)
    if(Test-Path $marker){throw 'inherited preload executed'}
    $actual=@(Get-Content -LiteralPath $output -Raw|ConvertFrom-Json)
    if(@($actual).Count -ne 1 -or $actual[0] -cne $literal){throw 'argument roundtrip failed'}
  }
  $ast=[Management.Automation.Language.Parser]::ParseFile((Resolve-Path 'scripts/install/bootstrap-windows.ps1').Path,[ref]$tokens,[ref]$errors)
  $definition=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'AssertStagingAncestors'},$true)
  . ([scriptblock]::Create($definition[0].Extent.Text))
  # Mock ACL reads to prove that an unsafe ancestor cannot be hidden by a safe leaf.
  function Get-Item {param($LiteralPath,[switch]$Force) return $script:leaf}
  function Get-Acl {param($LiteralPath) return $script:acls[$LiteralPath]}
  $sid=New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-545'
  $root=[pscustomobject]@{FullName='C:\';Attributes=0;Parent=$null}
  $script:leaf=[pscustomobject]@{FullName='C:\ProgramData';Attributes=0;Parent=$root}
  $safe=[pscustomobject]@{Owner='S-1-5-32-544';Access=@()}
  $script:acls=@{'C:\'=$safe;'C:\ProgramData'=$safe}
  AssertStagingAncestors 'C:\ProgramData'
  $script:acls['C:\']=[pscustomobject]@{Owner='S-1-5-32-544';Access=@([pscustomobject]@{IdentityReference=$sid;AccessControlType='Allow';PropagationFlags=0;FileSystemRights=[Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles})}
  $failed=$false;try{AssertStagingAncestors 'C:\ProgramData'}catch{$failed=$true};if(-not $failed){throw 'unsafe ancestor ACL accepted'}
  $script:acls['C:\']=$safe;$root.Attributes=[IO.FileAttributes]::ReparsePoint
  $failed=$false;try{AssertStagingAncestors 'C:\ProgramData'}catch{$failed=$true};if(-not $failed){throw 'ancestor reparse accepted'}
  # Staging cleanup: only a GUID directory inside the attested parent, links removed without following them.
  foreach($name in @('RemoveStaging','RemoveTree')){
    $function=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true)
    if(@($function).Count -ne 1){throw 'missing cleanup helper'};. ([scriptblock]::Create($function[0].Extent.Text))
  }
  $script:attested=@();function AssertStagingAncestors {param($Path) $script:attested+=$Path}
  $parent=Join-Path $directory 'staging';$outside=Join-Path $directory 'outside'
  $null=New-Item -ItemType Directory -Path $parent;$null=New-Item -ItemType Directory -Path $outside
  $kept=Join-Path $outside 'kept.txt';[IO.File]::WriteAllText($kept,'kept')
  $stage=Join-Path $parent ([guid]::NewGuid().ToString())
  $null=New-Item -ItemType Directory -Path (Join-Path $stage 'application\dist')
  foreach($file in @('node.exe','application\dist\index.js','application\readonly.js')){[IO.File]::WriteAllText((Join-Path $stage $file),'synthetic')}
  (New-Object IO.FileInfo (Join-Path $stage 'application\readonly.js')).IsReadOnly=$true
  $null=New-Item -ItemType Junction -Path (Join-Path $stage 'application\link') -Target $outside
  $failed=$false;try{RemoveStaging $parent (Join-Path $parent 'not-a-guid')}catch{$failed=$true};if(-not $failed){throw 'non-staging name accepted'}
  $failed=$false;try{RemoveStaging $outside $stage}catch{$failed=$true};if(-not $failed -or -not (Test-Path -LiteralPath $stage)){throw 'foreign staging parent accepted'}
  if($script:attested.Count -ne 0){throw 'cleanup attested before path validation'}
  RemoveStaging $parent $stage
  if((Test-Path -LiteralPath $stage) -or -not (Test-Path -LiteralPath $kept) -or $script:attested -notcontains $parent){throw 'staging cleanup failed or followed a link'}
  RemoveStaging $parent $stage
}finally{
  Remove-Item function:Get-Item -ErrorAction SilentlyContinue;Remove-Item function:Get-Acl -ErrorAction SilentlyContinue
  $env:NODE_OPTIONS=$oldOptions;$env:NODE_PATH=$oldPath
  Remove-Item -LiteralPath $directory -Recurse -Force
}
