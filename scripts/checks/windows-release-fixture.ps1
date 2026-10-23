# Disposable signed Windows release fixture shared by the release and README checks. Dot-source only.
# In-memory RSACng key, repository ZIP encoder (requires npm run build). No Node payload, service or elevation.
function TgFixtureHash([byte[]]$Bytes){$sha=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}
function New-TgReleaseFixture([string]$Root) {
  # Windows PowerShell 5.1: RSA.Create() returns a provider whose KeySize cannot be set; ask CNG for 3072 bits directly.
  $rsa=New-Object Security.Cryptography.RSACng 3072
  try {
    $request=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=Synthetic Windows Release Fixture',$rsa,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $cert=$request.CreateSelfSigned([DateTimeOffset]::Now.AddDays(-1),[DateTimeOffset]::Now.AddDays(1))
    try{[byte[]]$der=$cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert)}finally{$cert.Dispose()}
    $pin=TgFixtureHash $der;$source='a'*40
    $roles=@('node','installer','manifest_helper','archive_helper','application','node_license');$names=@('node.exe','installer.mjs','manifest.mjs','archive.mjs','application.tar.gz','NODE_LICENSE')
    $lines=@('TG_MCP_RELEASE_V1',"version`t0.2.0","source_sha`t$source","platform`twin32","architecture`tx64","node_version`t24.21.0")
    $payload=@{};foreach($name in $names){$payload[$name]=[byte[]](42)}
    for($i=0;$i -lt 6;$i++){$digest=TgFixtureHash $payload[$names[$i]];$lines+= "file`t$($roles[$i])`t$($names[$i])`t1`t$digest"}
    [byte[]]$manifest=[Text.Encoding]::ASCII.GetBytes(($lines -join "`n")+"`n")
    $payload['manifest.tsv']=$manifest;$payload['manifest.sig']=$rsa.SignData($manifest,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1);$payload['signer.der']=$der
  } finally { $rsa.Dispose() }
  # The bootstrap under test differs from the shipped one only by its pinned signer certificate.
  $bootstrap=Join-Path $Root 'bootstrap-fixture.ps1';$original=Get-Content -LiteralPath scripts/install/bootstrap-windows.ps1 -Raw
  [IO.File]::WriteAllText($bootstrap,$original.Replace('f6d3d70c8909d302f24c6853dfb82dad1ab7a2a2006221699002117b6a22c682',$pin))
  return @{Pin=$pin;Source=$source;Bootstrap=$bootstrap;Payload=$payload}
}
function Write-TgReleaseZip([hashtable]$Payload,[string]$Directory,[string]$Path) {
  # The nine signed files go through encodeReleaseZip, the encoder of the real Windows release asset.
  $null=New-Item -ItemType Directory -Path $Directory
  foreach($name in $Payload.Keys){[IO.File]::WriteAllBytes((Join-Path $Directory $name),[byte[]]$Payload[$name])}
  $node=(Get-Command node.exe).Source
  & $node (Resolve-Path -LiteralPath 'scripts/checks/windows-release-zip.mjs').Path $Directory $Path
  if($LASTEXITCODE -ne 0){throw 'repository release ZIP encoder failed'}
}
