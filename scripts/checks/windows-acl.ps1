# Synthetic hosted-runner regression. Extract definitions only, never execute provisioning.
$ErrorActionPreference='Stop'
$source=(Resolve-Path -LiteralPath 'scripts/install/provision-windows.ps1').Path
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw 'parse failed'}
$names=@('Fail','NoReparse','Sid','AssertProtected','AssertAncestors','AssertTree','Protect')
foreach($name in $names){
  $functionAst=$ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)|Select-Object -First 1
  if(-not $functionAst){throw 'missing attestation helper'}
  . ([ScriptBlock]::Create($functionAst.Extent.Text))
}
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('tg-acl-'+[Guid]::NewGuid().ToString())
$null=New-Item -ItemType Directory -Path $testRoot
$file=Join-Path $testRoot 'synthetic';'fixture'|Set-Content -LiteralPath $file
try {
  # Current-user ownership is insufficient even with currently read-only ACEs.
  $ownership=Get-Acl -LiteralPath $file;$ownership.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User);Set-Acl -LiteralPath $file -AclObject $ownership
  $failed=$false;try{$null=AssertProtected $file}catch{$failed=$true};if(-not $failed){throw 'user owner accepted'}
  Protect $file '' $true $false
  $null=AssertProtected $file
  foreach($right in @('Write','ChangePermissions','TakeOwnership','Delete')){
    Protect $file '' $true $false
    $acl=Get-Acl -LiteralPath $file
    $sid=New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-545'
    $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,$right,'Allow');$acl.AddAccessRule($rule);Set-Acl -LiteralPath $file -AclObject $acl
    $failed=$false;try{$null=AssertProtected $file}catch{$failed=$true};if(-not $failed){throw 'foreign mutation right accepted'}
  }
  Protect $file '' $true $false
  $acl=Get-Acl -LiteralPath $file;$sid=New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-545'
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'Read','Allow')));Set-Acl -LiteralPath $file -AclObject $acl
  $failed=$false;try{$null=AssertProtected $file '' $true}catch{$failed=$true};if(-not $failed){throw 'private descendant leak accepted'}
  Protect $file '' $true $false
  [Console]::WriteLine('Synthetic Windows ACL regressions passed.')
} finally {Remove-Item -LiteralPath $testRoot -Recurse -Force}
