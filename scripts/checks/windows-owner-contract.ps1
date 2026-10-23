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
