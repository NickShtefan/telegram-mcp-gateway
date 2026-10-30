# Read-only synthetic parity check: do not invoke owner setup, elevation or services.
$ErrorActionPreference='Stop'
$source=(Resolve-Path -LiteralPath 'scripts/install/owner-windows.ps1').Path
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'parse failed'}
$function=$ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'OwnerOperationId'},$true)
if(@($function).Count -ne 1){throw 'missing identity helper'}
. ([scriptblock]::Create($function[0].Extent.Text))
$SourceSha='a'*40
if((OwnerOperationId 'owner') -cne 'acb1c6f3-f629-470a-adbf-cc614e532c06'){throw 'operation identity parity failed'}
if((OwnerOperationId 'wife') -ceq (OwnerOperationId 'owner')){throw 'user identities collide'}
$capabilityFunction=$ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'OwnerLoginCapabilities'},$true)
if(@($capabilityFunction).Count -ne 1){throw 'missing login capability helper'}
. ([scriptblock]::Create($capabilityFunction[0].Extent.Text))
foreach($browser in @($false,$true)){foreach($console in @($false,$true)){
  $capabilities=OwnerLoginCapabilities ([pscustomobject]@{kind='plan';plan=[pscustomobject]@{browser_login=$browser;console_qr=$console}})
  if($capabilities.browser_login -ne $browser -or $capabilities.console_qr -ne $console){throw 'login capabilities changed'}
}}
$legacy=OwnerLoginCapabilities $null
if($legacy.browser_login -or $legacy.console_qr){throw 'legacy phone fallback acquired QR capability'}
foreach($invalid in @('true',1,@())){
  $rejected=$false;try{$null=OwnerLoginCapabilities ([pscustomobject]@{kind='plan';plan=[pscustomobject]@{console_qr=$invalid}})}catch{$rejected=$true}
  if(-not $rejected){throw 'malformed QR capability accepted'}
}
