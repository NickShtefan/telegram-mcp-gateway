# Synthetic process test: leave stdin open/silent; the reader must not block its coordinator.
$ErrorActionPreference='Stop'
$exe=(Resolve-Path -LiteralPath 'service-host.exe').Path
$probe=Join-Path ([IO.Path]::GetTempPath()) ('tg-input-'+[guid]::NewGuid().ToString()+'.ps1')
try {
  @'
param([string]$Assembly)
$ErrorActionPreference='Stop'
$null=[Reflection.Assembly]::LoadFrom($Assembly)
$reader=New-Object OwnerInputReader
try {
  $clock=[Diagnostics.Stopwatch]::StartNew()
  while($clock.ElapsedMilliseconds -lt 300){
    if($null -ne $reader.TryRead(50)){throw 'unexpected input'}
  }
  [Console]::Out.WriteLine('deadline_observed')
} finally {$reader.Dispose()}
'@|Set-Content -LiteralPath $probe -Encoding UTF8
  $power=Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
  $start=New-Object Diagnostics.ProcessStartInfo
  $start.FileName=$power;$start.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$probe+'" -Assembly "'+$exe+'"'
  $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  $child=New-Object Diagnostics.Process;$child.StartInfo=$start
  $null=$child.Start()
  try {
    # Do not close stdin: EOF would hide synchronous blocking.
    if(-not $child.WaitForExit(10000)){$child.Kill();throw 'silent stdin blocked deadline'}
    if($child.ExitCode -ne 0 -or $child.StandardOutput.ReadToEnd().Trim() -cne 'deadline_observed'){throw 'input cancellation regression'}
  } finally {if(-not $child.HasExited){$child.Kill()};$child.Dispose()}
} finally {Remove-Item -LiteralPath $probe -ErrorAction SilentlyContinue}
