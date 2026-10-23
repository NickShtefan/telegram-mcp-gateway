# Synthetic handle-reader regressions. Never run bootstrap body, elevation or provisioning.
$ErrorActionPreference='Stop'
$source=(Resolve-Path -LiteralPath 'scripts/install/bootstrap-windows.ps1').Path
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'parse failed'}
foreach($name in @('Fail','AssertSignerPin','NativeReader','BoundedBytes','ReadReleaseArchive')){
  $function=$ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$true)
  if(@($function).Count -ne 1){throw 'missing helper'};. ([scriptblock]::Create($function[0].Extent.Text))
}
AssertSignerPin 'f6d3d70c8909d302f24c6853dfb82dad1ab7a2a2006221699002117b6a22c682'
$failed=$false;try{AssertSignerPin ('0'*64)}catch{$failed=$true};if(-not $failed){throw 'unapproved signer accepted'}
$directory=Join-Path ([IO.Path]::GetTempPath()) ('tg-reader-'+[guid]::NewGuid().ToString());$null=New-Item -ItemType Directory -Path $directory
try {
  $file=Join-Path $directory 'regular';[IO.File]::WriteAllBytes($file,[byte[]](1,2,3))
  [byte[]]$bytes=BoundedBytes $file 3
  if($bytes.Length -ne 3 -or $bytes[2] -ne 3){throw 'regular reader failed'}
  $failed=$false;try{$null=BoundedBytes $file 2}catch{$failed=$true};if(-not $failed){throw 'oversize accepted'}
  $link=Join-Path $directory 'hardlink';$null=New-Item -ItemType HardLink -Path $link -Target $file
  $failed=$false;try{$null=BoundedBytes $link 3}catch{$failed=$true};if(-not $failed){throw 'hardlink accepted'}
  $failed=$false;try{$null=BoundedBytes $directory 3}catch{$failed=$true};if(-not $failed){throw 'directory accepted'}
  $framework=Join-Path ([Environment]::GetFolderPath('Windows')) 'Microsoft.NET\Framework64\v4.0.30319'
  $null=[Reflection.Assembly]::LoadFrom((Join-Path $framework 'System.IO.Compression.dll'))
  $archive=Join-Path $directory 'release.zip';$stream=[IO.File]::Open($archive,[IO.FileMode]::CreateNew);$zip=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create,$false)
  try{foreach($name in @('manifest.tsv','manifest.sig','signer.der','node.exe','installer.mjs','manifest.mjs','archive.mjs','application.tar.gz','NODE_LICENSE')){$entry=$zip.CreateEntry($name);$output=$entry.Open();try{$output.WriteByte(42)}finally{$output.Dispose()}}}finally{$zip.Dispose();$stream.Dispose()}
  $transport=ReadReleaseArchive $archive;if($transport.Count -ne 9 -or $transport['node.exe'][0] -ne 42){throw 'release ZIP mismatch'}
}finally{Remove-Item -LiteralPath $directory -Recurse -Force}
