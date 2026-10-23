# Run the installed script in an elevated human terminal, with agents and capture stopped.
param([Parameter(Mandatory=$true)][string]$SourceSha,[switch]$BrokerStdio)
$ErrorActionPreference='Stop'
$service='TelegramMCPGateway';$started=$false;$frozen=$false;$mailbox=$null;$ownerLock=$null;$failed=$false;$activate=$false;$brokerToken=$null;$clients=@();$deadline=[DateTime]::UtcNow.AddMinutes(15)
try {
  if($SourceSha -cnotmatch '^[0-9a-f]{40}$'){throw 'invalid'}
  $principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or (-not $BrokerStdio -and [Console]::IsInputRedirected)){throw 'invalid'}
  if($BrokerStdio){[Console]::InputEncoding=New-Object Text.UTF8Encoding($false,$true);[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false,$true)}
  $prefix='C:\ProgramData\TelegramMCPGateway';$release=Join-Path (Join-Path $prefix 'releases') $SourceSha
  $source=Join-Path $release 'application\dist\setup\provision-windows.ps1'
  # The installed bootstrap and code have already been independently authenticated.
  # Load only its checked-in protection functions, never the provisioning body.
  # Verify the imported file and all parents before evaluating even function definitions.
  $bootstrapItem=Get-Item -LiteralPath $source -Force
  for($item=$bootstrapItem;$item;$item=if($item -is [IO.DirectoryInfo]){$item.Parent}else{$item.Directory}){
    if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'invalid'}
    $acl=Get-Acl -LiteralPath $item.FullName
    $owner=if($acl.Owner -match '^S-1-'){$acl.Owner}else{(New-Object Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value}
    if($owner -notin @('S-1-5-32-544','S-1-5-18')){throw 'invalid'}
    $mutation=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
    if($item.FullName -in @('C:\','C:\ProgramData')){$mutation=$mutation -band (-bnot ([Security.AccessControl.FileSystemRights]::CreateFiles -bor [Security.AccessControl.FileSystemRights]::CreateDirectories))}
    foreach($rule in $acl.Access){if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-32-544','S-1-5-18') -and ($rule.FileSystemRights -band $mutation)){throw 'invalid'}}
  }
  $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
  if($errors.Count){throw 'invalid'}
  $functions=$ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst]},$true)
  foreach($name in @('Fail','NoReparse','Sid','AssertProtected','AssertAncestors','AssertTree','Protect')){
    $definition=@($functions|Where-Object {$_.Name -ceq $name});if($definition.Count -ne 1){throw 'invalid'}
    . ([scriptblock]::Create($definition[0].Extent.Text))
  }
  AssertAncestors $release;AssertTree (Get-Item -LiteralPath $release)
  $sc=Join-Path ([Environment]::GetFolderPath('System')) 'sc.exe'
  $sid=(New-Object Security.Principal.NTAccount('NT SERVICE\TelegramMCPGateway')).Translate([Security.Principal.SecurityIdentifier]).Value
  $receiptPath=Join-Path $prefix 'install.json';$null=AssertProtected $receiptPath
  if((Get-Item -LiteralPath $receiptPath).Length -gt 16384){throw 'invalid'}
  $receipt=Get-Content -LiteralPath $receiptPath -Raw|ConvertFrom-Json
  if($receipt.source_sha -cne $SourceSha -or $receipt.stage -cne 'complete'){throw 'invalid'}
  $definition=Join-Path $prefix 'service.json';$null=AssertProtected $definition
  if((Get-Item -LiteralPath $definition).Length -gt 16384){throw 'invalid'}
  $config=Get-Content -LiteralPath $definition -Raw|ConvertFrom-Json
  if($config.node -cne (Join-Path $release 'node.exe') -or $config.entry -cne (Join-Path $release 'application\dist\cli\index.js') -or $config.state -cne (Join-Path $prefix 'state') -or $config.files -cne (Join-Path $prefix 'files') -or $config.logs -cne (Join-Path $prefix 'logs') -or $config.port -ne $receipt.port -or $config.toolsets -cne 'core'){throw 'invalid'}
  $existing=Get-CimInstance Win32_Service -Filter "Name='TelegramMCPGateway'"
  $hostPath=Join-Path $release 'application\dist\native\service-host.exe'
  $readyPath=Join-Path $prefix 'owner-ready.json';$ready=$false
  if(Test-Path -LiteralPath $readyPath){$null=AssertProtected $readyPath;if((Get-Item -LiteralPath $readyPath).Length -gt 2048){throw 'invalid'};$record=Get-Content -LiteralPath $readyPath -Raw|ConvertFrom-Json;$ready=$record.source_sha -ceq $SourceSha -and $record.activated -eq $true}
  if($existing.StartName -cne 'NT SERVICE\TelegramMCPGateway' -or $existing.PathName -cne ('"'+$hostPath+'"') -or ($existing.StartMode -cne 'Manual' -and -not($ready -and $existing.StartMode -ceq 'Auto'))){throw 'invalid'}
  $lockPath=Join-Path $prefix 'owner-windows.lock'
  if(Test-Path -LiteralPath $lockPath){$null=AssertProtected $lockPath}
  $ownerLock=New-Object IO.FileStream($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  Protect $lockPath '' $true $false
  $wasRunning=$existing.State -eq 'Running'
  function BrokerWrite([object]$Message) {
    $text=$Message|ConvertTo-Json -Depth 8 -Compress
    if([Text.Encoding]::UTF8.GetByteCount($text) -gt 2048){throw 'frame_too_large'}
    [Console]::Out.WriteLine($text);[Console]::Out.Flush()
  }
  $brokerReader=$null
  if($BrokerStdio){
    $null=[Reflection.Assembly]::LoadFrom($hostPath)
    $brokerReader=New-Object OwnerInputReader
  }
  function BrokerRead {
    while([DateTime]::UtcNow -lt $deadline){
      if($started -and (Get-Service $service).Status -eq 'Stopped'){throw 'worker_ended'}
      $line=$brokerReader.TryRead(100)
      if($null -ne $line){return ($line|ConvertFrom-Json)}
      if($brokerReader.Failed){throw 'coordinator_ended'}
    }
    throw 'input_timeout'
  }
  $mailbox=Join-Path $prefix 'owner-setup';$planPath=Join-Path $mailbox 'plan.json';$saved=$null;$id=[guid]::NewGuid().ToString()
  if(Test-Path -LiteralPath $mailbox){AssertTree (Get-Item -LiteralPath $mailbox) $sid $true $true}
  if(Test-Path -LiteralPath $planPath){
    $null=AssertProtected $planPath $sid $true $true
    if((Get-Item -LiteralPath $planPath).Length -gt 2048){throw 'invalid'}
    $saved=Get-Content -LiteralPath $planPath -Raw|ConvertFrom-Json
    if($saved.source_sha -cne $SourceSha){throw 'invalid'};$id=$saved.plan.setup_id
  }
  if($id -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'){throw 'invalid'}
  function OwnerOperationId([string]$User) {
    if($User -cnotmatch '^[a-z0-9][a-z0-9_-]{0,31}$'){throw 'invalid'}
    $digest=[Security.Cryptography.SHA256]::Create()
    try{$hash= -join ($digest.ComputeHash([Text.Encoding]::UTF8.GetBytes('telegram-gateway-owner:'+$SourceSha+':'+$User))|ForEach-Object {$_.ToString('x2')})}finally{$digest.Dispose()}
    $value=$hash.Substring(0,32);$value=$value.Remove(12,1).Insert(12,'4')
    $variant='89ab'.Substring(([Convert]::ToInt32($value.Substring(16,1),16) -band 3),1);$value=$value.Remove(16,1).Insert(16,$variant)
    return ($value.Substring(0,8)+'-'+$value.Substring(8,4)+'-'+$value.Substring(12,4)+'-'+$value.Substring(16,4)+'-'+$value.Substring(20,12))
  }
  $legacyId=if($saved){$saved.plan.setup_id}else{$null}
  if($BrokerStdio){
    BrokerWrite @{kind='profile';setup_id=$id;port=$receipt.port}
    $frame=BrokerRead
    if($frame.kind -cne 'plan' -or $frame.plan.replace_session -ne $false -or $frame.plan.rotate_token -ne $false){throw 'invalid'}
    $account=$frame.plan.account;$user=$frame.plan.user;$clients=@($frame.plan.clients);$brokerToken=@($frame.existing_tokens)
    $id=OwnerOperationId $user;if($frame.plan.setup_id -cne $id){throw 'invalid'}
    if($clients.Count -gt 4 -or @($clients|Select-Object -Unique).Count -ne $clients.Count -or @($clients|Where-Object {$_ -cnotin @('codex','claude','opencode','hermes')}).Count){throw 'invalid'}
    if($brokerToken.Count -gt 4 -or @($brokerToken|Where-Object {$_ -cnotmatch '^[A-Za-z0-9_-]{32,256}$'}).Count){throw 'invalid'}
  } else {
    [Console]::Error.WriteLine('Stop all agents and disable terminal capture/UI automation. Same-user software is outside this protection.')
    if((Read-Host 'Type OWNER READY after completing those steps') -cne 'OWNER READY'){throw 'invalid'}
    $account=Read-Host 'Gateway account id';$user=Read-Host 'Gateway user id'
  }
  if($account -cnotmatch '^[a-z0-9][a-z0-9_-]{0,31}$' -or $user -cnotmatch '^[a-z0-9][a-z0-9_-]{0,31}$'){throw 'invalid'}
  if($saved -and $saved.plan.user -cne $user){$legacyId=$null}
  # Freeze the installed recovery policy before stopping the existing owner.
  $null=& $sc failure $service reset= 86400 actions= '""';if($LASTEXITCODE -ne 0){throw 'invalid'};$frozen=$true
  Stop-Service $service;(Get-Service $service).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(30))
  AssertTree (Get-Item -LiteralPath $config.state) $sid $true $true
  if(-not(Test-Path -LiteralPath $mailbox)){$null=New-Item -ItemType Directory -Path $mailbox;Protect $mailbox $sid $true $true}
  $planTemporary=Join-Path $mailbox 'plan.json.next'
  if(Test-Path -LiteralPath $planTemporary){$null=AssertProtected $planTemporary $sid $true $true;Remove-Item -LiteralPath $planTemporary}
  @{format_version=1;source_sha=$SourceSha;legacy_setup_id=$legacyId;plan=@{setup_id=$id;account=$account;user=$user;replace_session=$false;rotate_token=$false;clients=$clients}}|ConvertTo-Json -Depth 8 -Compress|Set-Content -LiteralPath $planTemporary -Encoding UTF8
  Protect $planTemporary $sid $true $false;Move-Item -LiteralPath $planTemporary -Destination $planPath -Force
  foreach($name in @('answer.json','answer.json.next','request.json','request.json.next','existing-credential.json','client-ack.json','client-ack.json.next','client-acknowledged.json','client-acknowledged.json.next','handoff.json','handoff.json.next')){
    $path=Join-Path $mailbox $name
    if(Test-Path -LiteralPath $path){$null=AssertProtected $path $sid $true $true;Remove-Item -LiteralPath $path}
  }
  if($null -ne $brokerToken){$credentialPath=Join-Path $mailbox 'existing-credential.json';@{tokens=$brokerToken}|ConvertTo-Json -Compress|Set-Content -LiteralPath $credentialPath -Encoding UTF8;Protect $credentialPath $sid $true $false;$brokerToken=$null}
  $null=& $sc start $service owner-setup $id;if($LASTEXITCODE -ne 0){throw 'invalid'};$started=$true
  $questions=@{api_id='Telegram application id';api_hash='Telegram application hash';phone='Telegram phone (international format)';code='Telegram verification code';password='Telegram two-factor password'}
  function ReadPrivate([string]$Question) {
    $secretInput=New-Object Security.SecureString
    $prior=[Console]::TreatControlCAsInput;[Console]::TreatControlCAsInput=$true
    [Console]::Error.Write($Question+': ')
    try {
      while([DateTime]::UtcNow -lt $deadline){
        if((Get-Service $service).Status -eq 'Stopped'){throw 'worker_ended'}
        if(-not [Console]::KeyAvailable){Start-Sleep -Milliseconds 100;continue}
        $key=[Console]::ReadKey($true)
        if(($key.Modifiers -band [ConsoleModifiers]::Control) -and $key.Key -in @([ConsoleKey]::C,[ConsoleKey]::Z)){throw 'cancelled'}
        if($key.Key -eq [ConsoleKey]::Enter){[Console]::Error.WriteLine();return $secretInput}
        if($key.Key -eq [ConsoleKey]::Backspace){if($secretInput.Length){$secretInput.RemoveAt($secretInput.Length-1)};continue}
        if(-not [char]::IsControl($key.KeyChar)){if($secretInput.Length -ge 512){throw 'input_too_long'};$secretInput.AppendChar($key.KeyChar)}
      }
      throw 'input_timeout'
    } catch {$secretInput.Dispose();throw}
    finally {[Console]::TreatControlCAsInput=$prior}
  }
  $sequence=0;$handed=$false;$requestPath=Join-Path $mailbox 'request.json';$result=$null
  while([DateTime]::UtcNow -lt $deadline){
    if(Test-Path -LiteralPath $requestPath){
      $item=AssertProtected $requestPath $sid $true $true
      if($item.PSIsContainer -or $item.Length -gt 2048){throw 'invalid'}
      $request=Get-Content -LiteralPath $requestPath -Raw|ConvertFrom-Json
      if($request.kind -ceq 'result'){$result=$request.result;break}
      if($request.kind -cne 'prompt' -or -not $questions.ContainsKey($request.question)){throw 'invalid'}
      if($request.sequence -eq $sequence){Start-Sleep -Milliseconds 100;continue}
      if($request.sequence -ne ($sequence+1)){throw 'invalid'};$sequence++
      if($BrokerStdio){
        BrokerWrite @{kind='prompt';sequence=$sequence;question=$request.question};$answerFrame=BrokerRead
        if($answerFrame.kind -cne 'answer' -or $answerFrame.sequence -ne $sequence -or $answerFrame.value -isnot [string] -or $answerFrame.value.Length -gt 512){throw 'invalid'}
        $path=Join-Path $mailbox 'answer.json.next';@{kind='answer';sequence=$sequence;value=$answerFrame.value}|ConvertTo-Json -Compress|Set-Content -LiteralPath $path -Encoding UTF8
        Protect $path $sid $true $true;Move-Item -LiteralPath $path -Destination (Join-Path $mailbox 'answer.json');$answerFrame=$null
        Start-Sleep -Milliseconds 100;continue
      }
      $secure=ReadPrivate $questions[$request.question]
      $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
      try{$answer=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer);if($answer.Length -gt 512){throw 'invalid'}
        $path=Join-Path $mailbox 'answer.json.next'
        @{kind='answer';sequence=$sequence;value=$answer}|ConvertTo-Json -Compress|Set-Content -LiteralPath $path -Encoding UTF8
        Protect $path $sid $true $true;Move-Item -LiteralPath $path -Destination (Join-Path $mailbox 'answer.json')
      } finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer);$secure.Dispose();$answer=$null}
    } elseif((Get-Service $service).Status -eq 'Stopped'){throw 'invalid'}
    Start-Sleep -Milliseconds 100
  }
  if($null -eq $result -or $result.setup_id -cne $id -or $result.format_version -ne 1 -or $result.phase -notin @('needs_client_configuration','needs_existing_client_credential','needs_service_start','failed') -or $result.error_code -notin @($null,'invalid_owner_input','owner_step_failed')){throw 'invalid'}
  # Emit an explicit allowlist, never arbitrary service-private fields.
  if($result.phase -ceq 'needs_service_start'){
    if(-not $BrokerStdio){throw 'invalid'};$handoffPath=Join-Path $mailbox 'handoff.json';$null=AssertProtected $handoffPath $sid $true $true
    if((Get-Item -LiteralPath $handoffPath).Length -gt 2048){throw 'invalid'};$handoff=Get-Content -LiteralPath $handoffPath -Raw|ConvertFrom-Json
    if($handoff.kind -cne 'handoff' -or $handoff.setup_id -cne $id -or $handoff.port -ne $receipt.port -or $handoff.token -cnotmatch '^[A-Za-z0-9_-]{32,256}$' -or (@($handoff.clients) -join ',') -cne ($clients -join ',')){throw 'invalid'}
    $activate=$true
  }
} catch {[Console]::Error.WriteLine('{"format_version":1,"error_code":"owner_step_failed"}');$failed=$true}
finally {
  if($started){Stop-Service $service;(Get-Service $service).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(30))}
  if($mailbox){foreach($name in @('answer.json','answer.json.next','request.json','request.json.next','existing-credential.json','client-ack.json','client-ack.json.next','client-acknowledged.json','client-acknowledged.json.next','handoff.json','handoff.json.next')){$path=Join-Path $mailbox $name;if(Test-Path -LiteralPath $path){$null=AssertProtected $path $sid $true $true;Remove-Item -LiteralPath $path}}}
  if($frozen){$null=& $sc failure $service reset= 86400 actions= restart/3000/restart/10000/restart/30000;if($LASTEXITCODE -ne 0){throw 'owner_restore_failed'};if($activate){$null=& $sc config $service start= auto;if($LASTEXITCODE -ne 0){throw 'owner_activate_failed'};@{source_sha=$SourceSha;activated=$true}|ConvertTo-Json -Compress|Set-Content -LiteralPath $readyPath -Encoding UTF8;Protect $readyPath $sid $false $false};if($wasRunning -or $activate){Start-Service $service}}
}
try {
  if($failed -or ($result -and $result.phase -ceq 'failed')){exit 1}
  if($activate){
    $until=[DateTime]::UtcNow.AddSeconds(15);$listener=$false
    while([DateTime]::UtcNow -lt $until){
      $serviceNow=Get-CimInstance Win32_Service -Filter "Name='TelegramMCPGateway'"
      if($serviceNow.State -cne 'Running' -or $serviceNow.ProcessId -le 0){Start-Sleep -Milliseconds 100;continue}
      $processes=Get-CimInstance Win32_Process -Filter ("ParentProcessId="+$serviceNow.ProcessId)
      foreach($process in $processes){
        if($process.ExecutablePath -cne $config.node){continue}
        $identity=Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
        if($identity.Sid -cne $sid){continue}
        $connection=Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $receipt.port -State Listen -ErrorAction SilentlyContinue|Where-Object {$_.OwningProcess -eq $process.ProcessId}
        if($connection){$listener=$true;break}
      }
      if($listener){break};Start-Sleep -Milliseconds 100
    }
    if(-not $listener){throw 'listener_unverified'}
    $digest=[Security.Cryptography.SHA256]::Create();try{$tokenHash= -join ($digest.ComputeHash([Text.Encoding]::UTF8.GetBytes($handoff.token))|ForEach-Object {$_.ToString('x2')})}finally{$digest.Dispose()}
    BrokerWrite @{kind='handoff';setup_id=$id;port=$receipt.port;token=$handoff.token;clients=$clients;service_evidence='listener_owned_by_service'}
    $ack=BrokerRead
    if($ack.kind -cne 'client_ack' -or $ack.setup_id -cne $id -or $ack.token_sha256 -cne $tokenHash){throw 'invalid'}
    $ackPath=Join-Path $mailbox 'client-ack.json.next';$ack|ConvertTo-Json -Compress|Set-Content -LiteralPath $ackPath -Encoding UTF8;Protect $ackPath $sid $true $false
    Move-Item -LiteralPath $ackPath -Destination (Join-Path $mailbox 'client-ack.json')
    $null=& $sc control $service 129;if($LASTEXITCODE -ne 0){throw 'receipt_failed'}
    $until=[DateTime]::UtcNow.AddSeconds(35);$received=$false;$receiptPath=Join-Path $mailbox 'client-acknowledged.json'
    while([DateTime]::UtcNow -lt $until){
      if(Test-Path -LiteralPath $receiptPath){$null=AssertProtected $receiptPath $sid $true $true;if((Get-Item -LiteralPath $receiptPath).Length -gt 2048){throw 'invalid'}
        $confirmation=Get-Content -LiteralPath $receiptPath -Raw|ConvertFrom-Json
        if($confirmation.setup_id -cne $id -or $confirmation.token_sha256 -cne $tokenHash){throw 'invalid'};$received=$true;break}
      Start-Sleep -Milliseconds 100
    }
    if(-not $received){throw 'receipt_failed'}
  }
  $public=@{format_version=1;setup_id=$id;phase=$result.phase;error_code=$result.error_code}
  if($BrokerStdio){BrokerWrite @{kind='result';result=$public}}else{$public|ConvertTo-Json -Compress}
} catch {[Console]::Error.WriteLine('{"format_version":1,"error_code":"owner_step_failed"}');exit 1}
finally {
  if($mailbox){foreach($name in @('client-ack.json','client-ack.json.next','client-acknowledged.json','client-acknowledged.json.next')){$path=Join-Path $mailbox $name;if(Test-Path -LiteralPath $path){$null=AssertProtected $path $sid $true $true;Remove-Item -LiteralPath $path}}}
  if($brokerReader){$brokerReader.Dispose()}
  if($ownerLock){$ownerLock.Dispose()}
}
