# Signed ZIP bootstrap regression on the repository release encoder with a disposable in-memory certificate.
# Requires npm run build. No Node payload, service or elevation is executed.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'windows-release-fixture.ps1')
$root=Join-Path ([IO.Path]::GetTempPath()) ('tg-signed-zip-'+[guid]::NewGuid().ToString());$null=New-Item -ItemType Directory $root
try {
  $fixture=New-TgReleaseFixture $root
  $archive=Join-Path $root 'good.zip';Write-TgReleaseZip $fixture.Payload (Join-Path $root 'good') $archive
  $powershell=Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
  $result=& $powershell -NoLogo -NoProfile -NonInteractive -File $fixture.Bootstrap -Archive $archive
  if($LASTEXITCODE -ne 0){throw 'signed archive rejected'};$meta=$result|ConvertFrom-Json
  if($meta.source_sha -cne $fixture.Source -or $meta.phase -cne 'bundle_verified' -or $meta.installed){throw 'archive identity failed'}
  $fixture.Payload['node.exe']=[byte[]](43);$bad=Join-Path $root 'bad.zip';Write-TgReleaseZip $fixture.Payload (Join-Path $root 'bad') $bad
  $previous=$ErrorActionPreference;$ErrorActionPreference='Continue'
  try { & $powershell -NoLogo -NoProfile -NonInteractive -File $fixture.Bootstrap -Archive $bad 2>$null; $rejectedExit=$LASTEXITCODE } finally { $ErrorActionPreference=$previous }
  if($rejectedExit -eq 0){throw 'tampered archive accepted'}
  # The expected rejection must not become this step's exit status.
  $global:LASTEXITCODE=0
  Write-Output 'Signed Windows ZIP from the repository encoder and payload tamper rejection passed.'
}finally{Remove-Item -LiteralPath $root -Recurse -Force}
