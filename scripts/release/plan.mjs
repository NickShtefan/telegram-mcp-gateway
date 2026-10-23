/** Validate public CI evidence, release names, user commands and draft-only arguments without opening signing files. */
// Public development repository. Release candidates must bind to a commit from this repository.
export const REPOSITORY='NickShtefan/telegram-mcp-gateway';
export const TARGETS=[['macos-15','darwin','arm64','macos-arm64'],['macos-15-intel','darwin','x64','macos-x64'],['ubuntu-24.04','linux','x64','linux-x64'],['ubuntu-24.04-arm','linux','arm64','linux-arm64'],['windows-latest','win32','x64','windows-x64']];
const TAG=/^v0\.2\.0(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;
const REPO=/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/;
export function requireRun(ci,sha){if(!/^[0-9a-f]{40}$/.test(sha)||ci.head_sha!==sha||ci.status!=='completed'||ci.conclusion!=='success'||ci.path!=='.github/workflows/platform-checks.yml')throw new Error('successful_exact_source_ci_required')}
// The API needs the run ID from .../actions/runs/<id>, not the short per-workflow run number.
export function requireRunId(run){if(typeof run!=='string'||!/^[1-9][0-9]{7,19}$/.test(run))throw new Error('ci_run_id_required');return run}
export function manifestEvidence(logs,sha){const records=[...logs.matchAll(/\{"format_version":1,"phase":"unsigned_candidate_created"[^\r\n]*\}/g)].map(m=>JSON.parse(m[0]));if(records.length!==1||records[0].source_sha!==sha||!/^[a-f0-9]{64}$/.test(records[0].manifest_sha256??''))throw new Error('ci_manifest_evidence_missing');return records[0].manifest_sha256}
/** Every asset name carries the release name, so a test draft is never mistaken for the final release. */
export function assetNames(tag){
 if(typeof tag!=='string'||!TAG.test(tag))throw new Error('invalid_release_tag');
 const prefix=`telegram-mcp-gateway-${tag.slice(1)}`;
 return {prefix,archive:label=>`${prefix}-${label}.${label==='windows-x64'?'zip':'tar.gz'}`,posixBootstrap:`${prefix}-bootstrap-posix.sh`,windowsBootstrap:`${prefix}-bootstrap-windows.ps1`,checksums:`${prefix}-SHA256SUMS`};
}
export const PLATFORMS=[
 {label:'macos-arm64',title:'macOS Apple Silicon (arm64)',os:'darwin'},
 {label:'macos-x64',title:'macOS Intel (x64)',os:'darwin'},
 {label:'linux-x64',title:'Ubuntu 24.04 x64 and Arch Linux x64',os:'linux'},
 {label:'linux-arm64',title:'Ubuntu 24.04 arm64',os:'linux'},
 {label:'windows-x64',title:'Windows 11 x64',os:'win32'},
];
const WINDOWS_STAGE=`$acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); $admin=New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'; $acl.SetOwner($admin); foreach($sid in @($admin,(New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'))){ $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))) }; $d=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) ('TelegramMCPBootstrap-'+[guid]::NewGuid()); $null=[IO.Directory]::CreateDirectory($d,$acl)`;
/**
 * Ready user commands per platform: 1 terminal download, 2 authorized installation from a
 * protected bootstrap copy checked against the pinned SHA-256, 3 the unelevated wizard.
 * With sourceSha the bootstrap accepts only that exact owner-signed build.
 * download 'gh' works for drafts and private repositories; 'public' needs no GitHub account.
 */
export function installCommands({repo,tag,sourceSha,bootstrapSha256,download}){
 if(!REPO.test(repo??'')||(sourceSha!==undefined&&!/^[0-9a-f]{40}$/.test(sourceSha))||!['gh','public'].includes(download)||!/^[0-9a-f]{64}$/.test(bootstrapSha256?.posix??'')||!/^[0-9a-f]{64}$/.test(bootstrapSha256?.windows??''))throw new Error('install_commands_invalid');
 const names=assetNames(tag);
 return PLATFORMS.map(({label,title,os})=>{
  const archive=names.archive(label);
  if(os==='win32'){
   const boot=names.windowsBootstrap;
   const fetch=download==='gh'
    ?`Set-Location "$HOME\\Downloads"; gh release download ${tag} --repo ${repo} --clobber --pattern ${boot} --pattern ${archive}; if($LASTEXITCODE -ne 0){throw 'Download failed'}`
    :`Set-Location "$HOME\\Downloads"; foreach($n in @('${boot}','${archive}')){ Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/${repo}/releases/download/${tag}/$n" -OutFile $n }`;
   const install=`& { ${WINDOWS_STAGE}; try{ Copy-Item -LiteralPath "$HOME\\Downloads\\${boot}" -Destination "$d\\bootstrap.ps1"; if((Get-FileHash "$d\\bootstrap.ps1" -Algorithm SHA256).Hash.ToLowerInvariant() -ne '${bootstrapSha256.windows}'){throw 'Bootstrap checksum mismatch'}; & "$env:WINDIR\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$d\\bootstrap.ps1" -Archive "$HOME\\Downloads\\${archive}"${sourceSha?` -SourceSha '${sourceSha}'`:''} -Install; if($LASTEXITCODE -ne 0){throw 'Installation failed: preserve state'} }finally{Remove-Item -LiteralPath $d -Recurse -Force} }`;
   return {label,title,language:'powershell',text:[fetch,install,'& "$env:ProgramData\\TelegramMCPGateway\\bin\\tg-mcp-owner.cmd" setup'].join('\n')};
  }
  const boot=names.posixBootstrap;
  const fetch=download==='gh'
   ?`/bin/mkdir -p "$HOME/Downloads" && cd "$HOME/Downloads" && gh release download ${tag} --repo ${repo} --clobber --pattern ${boot} --pattern ${archive}`
   :`/bin/mkdir -p "$HOME/Downloads" && cd "$HOME/Downloads" && curl -fL --proto '=https' -O https://github.com/${repo}/releases/download/${tag}/${boot} -O https://github.com/${repo}/releases/download/${tag}/${archive}`;
  const [temporary,check,owner]=os==='darwin'
   ?['/private/tmp','/usr/bin/shasum -a 256',`'/Library/Application Support/TelegramMCPGateway/bin/tg-mcp-owner' setup`]
   :['/tmp','/usr/bin/sha256sum','/opt/telegram-mcp-gateway/bin/tg-mcp-owner setup'];
  const install=`sudo /bin/sh -c 'set -eu; d=$(/usr/bin/mktemp -d ${temporary}/tg-bootstrap.XXXXXX); trap '\\''/bin/rm -rf "$d"'\\'' EXIT; /bin/cp "$1" "$d/bootstrap.sh"; printf "${bootstrapSha256.posix}  %s\\n" "$d/bootstrap.sh" | ${check} -c -; shift; /bin/sh "$d/bootstrap.sh" "$@" install' sh "$HOME/Downloads/${boot}" "$HOME/Downloads/${archive}"${sourceSha?` ${sourceSha}`:''}`;
  return {label,title,language:'sh',text:[fetch,install,owner].join('\n')};
 });
}
/** Agent instructions are immutable for a release; discovery on main is never the execution pin. */
export function agentInstallPrompt({repo,tag,sourceSha}){
 if(typeof repo!=='string'||!REPO.test(repo)||repo.split('/').some(part=>part==='.'||part==='..')||typeof sourceSha!=='string'||!/^[0-9a-f]{40}$/.test(sourceSha))throw new Error('agent_install_prompt_invalid');
 assetNames(tag);
 return [`Install Telegram MCP Gateway from ${repo} release ${tag} on this computer.`,
  `Fetch and follow the complete instructions at https://raw.githubusercontent.com/${repo}/${sourceSha}/INSTALL.md`,
  `Use exactly source commit ${sourceSha}. Do the non-secret preparation and verification yourself.`,
  'Keep system authorization and Telegram credentials/codes/passwords in my own terminal, outside the agent. Verify the selected MCP client before reporting completion.'].join('\n');
}
export function releaseNotes({repo,tag,sourceSha,run,signerSha256,bootstrapSha256}){
 requireRunId(run);if(!/^[0-9a-f]{64}$/.test(signerSha256??''))throw new Error('release_notes_invalid');
 const commands=installCommands({repo,tag,sourceSha,bootstrapSha256,download:'gh'}),test=tag!=='v0.2.0';
 return [`# ${test?'Test draft':'Release'} ${tag}`,'',
  ...(test?[`This is a test draft, not the final release. Every asset name carries \`${tag.slice(1)}\`, so the final release commands never download these files.`,'']:[]),
  `Source commit: \`${sourceSha}\`. CI run ID: ${run}. Owner certificate DER SHA-256: \`${signerSha256}\`.`,'',
  '## Install with an agent','',
  'Copy this prompt into your coding agent. System approval and Telegram input remain in your own terminal.','',
  '```text',agentInstallPrompt({repo,tag,sourceSha}),'```','',
  '## Manual installation','',
  'These are the README Installation commands for this release with its exact source commit pinned (the last argument of command 2, `-SourceSha` on Windows). The bootstrap then rejects every other owner-signed build. The release page is not an independent trust root: before running, check that the bootstrap SHA-256 in command 2 equals the value in the README Installation commands and that nothing else differs from them. No Node/npm, compiler or signing key is needed.','',
  ...commands.flatMap(c=>[`## ${c.title}`,'',`\`\`\`${c.language}`,c.text,'```','']),
  'This is a draft. Publishing, repository visibility and npm are separate owner decisions.',''].join('\n');
}
export function draftArguments({tag,repo,sha,notes,assets}){if(typeof tag!=='string'||!TAG.test(tag)||!REPO.test(repo)||!/^[0-9a-f]{40}$/.test(sha)||!Array.isArray(assets)||assets.length!==8)throw new Error('draft_plan_invalid');return ['release','create',tag,'--repo',repo,'--target',sha,'--draft','--title',`${tag.slice(1)} installer qualification`,'--notes-file',notes,...assets]}
