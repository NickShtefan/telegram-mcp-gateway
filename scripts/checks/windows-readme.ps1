# Run the README Windows install command literally in verification mode against a disposable signed fixture.
# Command 1 (gh release download) is checked, not run; its two assets are placed in a fixture Downloads folder. In
# command 2 only three things are substituted: the Downloads folder, the bootstrap pin (the fixture bootstrap differs
# only by its pinned signer certificate) and the -Install switch (removed). Never installs, provisions
# or runs the owner wizard. Command 2 creates its protected copy under Program Files, so the runner must be elevated.
# Requires npm run build.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'windows-release-fixture.ps1')
$text=Get-Content README.md -Raw
$blocks=[regex]::Matches($text,'(?s)```powershell\r?\n(.*?)```')
if($blocks.Count -ne 1){throw 'Windows README command block missing'}
$block=$blocks[0].Groups[1].Value
$tokens=$null;$errors=$null;$null=[Management.Automation.Language.Parser]::ParseInput($block,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Windows README command syntax failed'}
$commands=@($block -split '\r?\n' | Where-Object { $_.Trim() })
if($commands.Count -ne 3){throw 'Windows README must contain exactly three commands'}
# Command 3 starts the installed owner wizard: check its path and argument, never run it.
$third=[Management.Automation.Language.Parser]::ParseInput($commands[2],[ref]$tokens,[ref]$errors)
$call=@($third.EndBlock.Statements)[0].PipelineElements[0]
if($errors.Count -or $call.InvocationOperator -ne 'Ampersand' -or $call.CommandElements.Count -ne 2 -or $call.CommandElements[1].Extent.Text -cne 'setup'){throw 'owner command shape changed'}
$launcher=$ExecutionContext.InvokeCommand.ExpandString($call.CommandElements[0].Value)
if($launcher -cne 'C:\ProgramData\TelegramMCPGateway\bin\tg-mcp-owner.cmd' -or -not (Get-Content scripts/install/bootstrap-windows.ps1 -Raw).Contains("run $launcher setup")){throw 'owner command differs from the installed launcher'}
# Command 1 downloads the release with gh: check that it fetches exactly the two assets into Downloads, never run it.
$bootstrapName='telegram-mcp-gateway-0.2.0-bootstrap-windows.ps1';$archiveName='telegram-mcp-gateway-0.2.0-windows-x64.zip'
if(-not $commands[0].StartsWith('Set-Location "$HOME\Downloads"; gh release download ') -or -not $commands[0].Contains("--pattern $bootstrapName") -or -not $commands[0].Contains("--pattern $archiveName")){throw 'README download command changed'}
$pin=[regex]::Match($commands[1],"-ne '([0-9a-f]{64})'")
if(-not $pin.Success){throw 'README bootstrap pin missing'}
$readmePin=$pin.Groups[1].Value
# The pin equals the committed (LF) bootstrap bytes: src/install/__tests__/installCommands.test.ts checks that.
if([regex]::Matches($commands[1],' -Install(?=[;\s])').Count -ne 1){throw 'README install switch changed'}
function ReadmeFixture([string]$Command,[string]$Pin) {
  if(-not $Command.Contains('$HOME\Downloads\')){throw 'README download location changed'}
  return $Command.Replace('$HOME\Downloads\','$TgFixtureDownloads\').Replace($readmePin,$Pin)
}
$protected=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'TelegramMCPBootstrap-*'
$before=@(Get-ChildItem -Path $protected -Directory -ErrorAction SilentlyContinue).Count
$root=Join-Path ([IO.Path]::GetTempPath()) ('tg-readme-'+[guid]::NewGuid().ToString());$null=New-Item -ItemType Directory $root
try {
  $fixture=New-TgReleaseFixture $root
  $TgFixtureDownloads=Join-Path $root 'Downloads';$null=New-Item -ItemType Directory $TgFixtureDownloads
  # Command 1's result: the two release assets in Downloads.
  $bootstrap=Join-Path $TgFixtureDownloads $bootstrapName;$archive=Join-Path $TgFixtureDownloads $archiveName
  Copy-Item -LiteralPath $fixture.Bootstrap -Destination $bootstrap
  Write-TgReleaseZip $fixture.Payload (Join-Path $root 'payload') $archive
  $fixturePin=(Get-FileHash -LiteralPath $bootstrap -Algorithm SHA256).Hash.ToLowerInvariant()
  $second=[scriptblock]::Create((ReadmeFixture ([regex]::Replace($commands[1],' -Install(?=[;\s])','')) $fixturePin))
  # Command 2 must stop when the downloaded bootstrap differs from its pin.
  Copy-Item -LiteralPath (Resolve-Path -LiteralPath 'scripts/install/bootstrap-windows.ps1').Path -Destination $bootstrap -Force
  $stopped=$false;try{$null=& $second}catch{$stopped=$true};if(-not $stopped){throw 'README command 2 accepted a different bootstrap'}
  Copy-Item -LiteralPath $fixture.Bootstrap -Destination $bootstrap -Force
  $output=@(& $second)
  if($output.Count -ne 1){throw 'README command 2 verification output changed'}
  $meta=$output[0]|ConvertFrom-Json
  if($meta.phase -cne 'bundle_verified' -or $meta.source_sha -cne $fixture.Source -or $meta.installed){throw 'README command 2 verification identity failed'}
  # Command 2 must stop when the bootstrap rejects the archive.
  Remove-Item -LiteralPath $archive
  $fixture.Payload['node.exe']=[byte[]](43);Write-TgReleaseZip $fixture.Payload (Join-Path $root 'tampered') $archive
  $previous=$ErrorActionPreference;$ErrorActionPreference='Continue';$stopped=$false
  try { $null=& $second } catch { $stopped=$true } finally { $ErrorActionPreference=$previous }
  if(-not $stopped){throw 'README command 2 accepted a tampered archive'}
  if(@(Get-ChildItem -Path $protected -Directory -ErrorAction SilentlyContinue).Count -ne $before){throw 'README protected bootstrap copy remained'}
  # The expected rejection must not become this step's exit status.
  $global:LASTEXITCODE=0
  Write-Output 'README Windows download command checked; install command verified the signed fixture and stopped on a changed bootstrap and a tampered archive.'
}finally{Remove-Item -LiteralPath $root -Recurse -Force}
