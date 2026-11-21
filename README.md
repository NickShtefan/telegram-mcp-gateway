# Unofficial Telegram MCP Gateway

An MCP gateway for Telegram user accounts. One daemon owns the MTProto sessions and exposes tools to Claude Code, Codex, OpenCode and other MCP clients. Agents can read and search chats, fetch media, export messages, inspect channel counters, build a local index and prepare confirmed writes.

## Install with your agent

You'll need administrator access, your Telegram API ID and API hash, and your phone. The installer includes Node.js.

After setup, ask your agent to find a post in a channel you choose and return its Telegram link.

To install, copy this prompt into your coding agent.

```text
Install Telegram MCP Gateway on this computer by following the complete instructions at:
https://raw.githubusercontent.com/NickShtefan/telegram-mcp-gateway/main/INSTALL.md
Do the non-secret preparation and verification yourself. Keep system authorization
and Telegram credentials/codes/passwords in my own terminal, outside the agent.
```

The agent selects the matching signed release, downloads and verifies it, prepares the owner-only terminal steps and checks the actual MCP client afterwards. You choose the client, approve system changes and enter Telegram values yourself. The [agent installation guide](INSTALL.md) defines the workflow; release-specific prompts also pin its exact source commit.

Download the signed **v0.2.0** installer for macOS, Linux or Windows. The release page includes instructions for fresh installations and updates to existing managed Macs. [GitHub Release v0.2.0](https://github.com/NickShtefan/telegram-mcp-gateway/releases/tag/v0.2.0)

The maintainer reported successful installations on Apple Silicon and Intel Macs and development installation tests on Ubuntu and Arch Linux. The Linux report did not identify the installer builds or Ubuntu architecture. Windows 11 x64 still awaits its first manual trial. [Installation results as of 2026-11-20](docs/outsider-test.md#evidence-sheet).

## Capabilities

The gateway is a tool for an agent. It does not run models, watch chats, start agents or manage negotiation goals. Every Telegram operation begins with a tool call. This project is independent of Telegram.

24 tools in five toolsets; `core` is enabled by default.

| Toolset | Capabilities |
| --- | --- |
| core | Account dialogs, chat resolution, search, history, comments, forum topics, JSONL/CSV exports, photos and previews |
| discover | Channel name search, similar channels and forwarding sources |
| analytics | Public channel counters, reach, engagement and trends |
| index | Explicit chat indexing and local substring search without Telegram calls |
| write | Publish and edit channel posts, preview and confirm replies, sends, reactions, joins and callback button presses |

One process owns each session. Bearer tokens separate gateway users and their account grants. Private conversations are closed by default. Every MTProto call passes through an account queue with limits and a deadline. A hung operation stops queued work and exits with code 1 for supervisor restart. Telegram text is labeled as untrusted data.

Write tools return a preview and `approval_id`. The agent must show it to the owner and call `tg_confirm` only after consent. The gateway cannot independently verify human approval; client permissions are part of this boundary.

To manage a channel, add the gateway's Telegram account as an administrator in Telegram. Grant **Post Messages** to publish and **Edit Messages** to edit other admins' posts. In a managed build with this feature, run `tg-mcp-owner setup` and choose **Read and write** for the gateway profile. The default is **Read only**. Publish text with `tg_send` and edit a published post or media caption with `tg_edit_post`. Builds with `op=replace_link_url` can change one hidden link in a text post while preserving its formatting. Builds advertising `op=replace_range` also support editing literal text, formatting and standalone captions. Builds advertising `op=set_link_preview` can select, resize, position or disable a link card, or restore Telegram’s automatic selection. Builds advertising `op=replace_media` can replace an attachment or one album item while preserving captions. Scheduled edits and supported keyboard and poll operations use the same preview and confirmation flow. [Channel workflow](docs/scenarios.md#publish-and-edit-a-channel-post) · [Content edit operations](docs/tools.md#edit-text-formatting-and-captions).

## Installation

You can [install with your agent](#install-with-your-agent) or use the manual commands below.

The owner wizard offers an optional local browser guide for application credentials, QR/phone/2FA login and a checklist for Codex, Claude Code, Cursor, Hermes, OpenCode and OpenClaw. You can choose several apps or connect them later. A complete console path offers terminal QR or phone login without a browser listener. API ID and phone are visible while typing; the API hash starts hidden and Ctrl+T toggles its display in a suitable terminal. Login codes and 2FA passwords stay hidden. Both entries use the same protected session worker. See [owner setup](docs/owner-setup.md) and [adapter formats](docs/client-adapters.md).

<details>
<summary>Manual installation commands</summary>

The commands below download the public v0.2.0 packages directly from GitHub. The archive includes Node and the gateway application.

Before you start:

- Use an **administrator account**: a macOS Administrator, a Linux user allowed to use `sudo`, or a Windows administrator account. Start from an ordinary, unelevated terminal. Command 2 requests system authorization only for installation, then continues setup as the original user. On Windows, approve elevation with your own administrator account.
- The public download commands use curl on macOS and Linux and Invoke-WebRequest in Windows PowerShell.
- The current Node 24 bundle needs macOS 13.5 or later. macOS 13.0-13.4 requires a separately prepared Node 22 bundle and is not qualified by these assets. Other platforms/versions remain unqualified until tested. See [platform checks](docs/outsider-test.md).

Run these two commands for your platform in order:

1. Download the bootstrap and the archive of release `v0.2.0` into Downloads under their exact names. Downloads is staging; the gateway is installed into its protected system prefix. Do not open or extract the archive.
2. Install with system authorization. The command copies the bootstrap into a fresh protected directory, checks it against the SHA-256 pinned in this README and only then runs it on the archive. In the same terminal, choose Configure now or Configure later. Setup runs as your ordinary user, uses normal account/profile defaults, and offers browser or console entry. Enter your own Telegram API credentials and QR/phone/code/2FA directly into the private wizard. Restart the selected tools as instructed, then request an actual `telegram_gateway` / `tg_status` tool call.

For retries or deferred setup, run `tg-mcp-owner setup` using its installed path. Existing custom account/profile labels require `setup --advanced`. The generated commands skip the wizard when input/error output is redirected, so agents perform only non-secret preparation and hand the combined command to the owner.

Expected: on macOS and Linux the checksum line ends in `OK`. The installer shows signature checks, completed application-file counts, service preparation and a plain-language next step. The service stays stopped until the owner wizard connects Telegram. Long asynchronous checks repeat their current step every ten seconds. The wizard then verifies the authenticated connection and tells you which clients to restart. Human progress goes to stderr; redirected stdout retains JSON results. The wizard shows one capture warning without a typed readiness phrase. Use arrows/Enter for choices and Space for multiple clients; limited terminals accept numbers or names. SSH recommends console, local desktops recommend browser. Press C in the waiting browser terminal to continue in console, or Ctrl+C to cancel. Stop if a checksum fails or an existing/foreign installation is reported. Keep the same archive for retries.

### macOS Apple Silicon (arm64)

```sh
/bin/mkdir -p "$HOME/Downloads" && cd "$HOME/Downloads" && curl -fL --proto '=https' -O https://github.com/NickShtefan/telegram-mcp-gateway/releases/download/v0.2.0/telegram-mcp-gateway-0.2.0-bootstrap-posix.sh -O https://github.com/NickShtefan/telegram-mcp-gateway/releases/download/v0.2.0/telegram-mcp-gateway-0.2.0-macos-arm64.tar.gz
[ "$(/usr/bin/id -u)" -ne 0 ] && sudo /bin/sh -c 'set -eu; d=$(/usr/bin/mktemp -d /private/tmp/tg-bootstrap.XXXXXX); trap '\''/bin/rm -rf "$d"'\'' EXIT; /bin/cp "$1" "$d/bootstrap.sh"; printf "3973dd4223e5782ddfb27d85097a29086a5f77e2eb7f4dfb6ab4bb33a8ac11ce  %s\n" "$d/bootstrap.sh" | /usr/bin/shasum -a 256 -c -; shift; /bin/sh "$d/bootstrap.sh" "$@" install' sh "$HOME/Downloads/telegram-mcp-gateway-0.2.0-bootstrap-posix.sh" "$HOME/Downloads/telegram-mcp-gateway-0.2.0-macos-arm64.tar.gz" && if [ -t 0 ] && [ -t 2 ]; then '/Library/Application Support/TelegramMCPGateway/bin/tg-mcp-owner' setup --after-install; else printf '%s\n' 'Installation prepared. Run /Library/Application Support/TelegramMCPGateway/bin/tg-mcp-owner setup in an ordinary terminal.' >&2; fi
```

### macOS Intel (x64)

```sh
/bin/mkdir -p "$HOME/Downloads" && cd "$HOME/Downloads" && curl -fL --proto '=https' -O https://github.com/NickShtefan/telegram-mcp-gateway/releases/download/v0.2.0/telegram-mcp-gateway-0.2.0-bootstrap-posix.sh -O https://github.com/NickShtefan/telegram-mcp-gateway/releases/download/v0.2.0/telegram-mcp-gateway-0.2.0-macos-x64.tar.gz
[ "$(/usr/bin/id -u)" -ne 0 ] && sudo /bin/sh -c 'set -eu; d=$(/usr/bin/mktemp -d /private/tmp/tg-bootstrap.XXXXXX); trap '\''/bin/rm -rf "$d"'\'' EXIT; /bin/cp "$1" "$d/bootstrap.sh"; printf "3973dd4223e5782ddfb27d85097a29086a5f77e2eb7f4dfb6ab4bb33a8ac11ce  %s\n" "$d/bootstrap.sh" | /usr/bin/shasum -a 256 -c -; shift; /bin/sh "$d/bootstrap.sh" "$@" install' sh "$HOME/Downloads/telegram-mcp-gateway-0.2.0-bootstrap-posix.sh" "$HOME/Downloads/telegram-mcp-gateway-0.2.0-macos-x64.tar.gz" && if [ -t 0 ] && [ -t 2 ]; then '/Library/Application Support/TelegramMCPGateway/bin/tg-mcp-owner' setup --after-install; else printf '%s\n' 'Installation prepared. Run /Library/Application Support/TelegramMCPGateway/bin/tg-mcp-owner setup in an ordinary terminal.' >&2; fi
```

The Terminal may ask once for access to the Downloads folder: allow it.

### Ubuntu 24.04 x64 and Arch Linux x64

```sh
/bin/mkdir -p "$HOME/Downloads" && cd "$HOME/Downloads" && curl -fL --proto '=https' -O https://github.com/NickShtefan/telegram-mcp-gateway/releases/download/v0.2.0/telegram-mcp-gateway-0.2.0-bootstrap-posix.sh -O https://github.com/NickShtefan/telegram-mcp-gateway/releases/download/v0.2.0/telegram-mcp-gateway-0.2.0-linux-x64.tar.gz
[ "$(/usr/bin/id -u)" -ne 0 ] && sudo /bin/sh -c 'set -eu; d=$(/usr/bin/mktemp -d /tmp/tg-bootstrap.XXXXXX); trap '\''/bin/rm -rf "$d"'\'' EXIT; /bin/cp "$1" "$d/bootstrap.sh"; printf "3973dd4223e5782ddfb27d85097a29086a5f77e2eb7f4dfb6ab4bb33a8ac11ce  %s\n" "$d/bootstrap.sh" | /usr/bin/sha256sum -c -; shift; /bin/sh "$d/bootstrap.sh" "$@" install' sh "$HOME/Downloads/telegram-mcp-gateway-0.2.0-bootstrap-posix.sh" "$HOME/Downloads/telegram-mcp-gateway-0.2.0-linux-x64.tar.gz" && if [ -t 0 ] && [ -t 2 ]; then /opt/telegram-mcp-gateway/bin/tg-mcp-owner setup --after-install; else printf '%s\n' 'Installation prepared. Run /opt/telegram-mcp-gateway/bin/tg-mcp-owner setup in an ordinary terminal.' >&2; fi
```

### Ubuntu 24.04 arm64

```sh
/bin/mkdir -p "$HOME/Downloads" && cd "$HOME/Downloads" && curl -fL --proto '=https' -O https://github.com/NickShtefan/telegram-mcp-gateway/releases/download/v0.2.0/telegram-mcp-gateway-0.2.0-bootstrap-posix.sh -O https://github.com/NickShtefan/telegram-mcp-gateway/releases/download/v0.2.0/telegram-mcp-gateway-0.2.0-linux-arm64.tar.gz
[ "$(/usr/bin/id -u)" -ne 0 ] && sudo /bin/sh -c 'set -eu; d=$(/usr/bin/mktemp -d /tmp/tg-bootstrap.XXXXXX); trap '\''/bin/rm -rf "$d"'\'' EXIT; /bin/cp "$1" "$d/bootstrap.sh"; printf "3973dd4223e5782ddfb27d85097a29086a5f77e2eb7f4dfb6ab4bb33a8ac11ce  %s\n" "$d/bootstrap.sh" | /usr/bin/sha256sum -c -; shift; /bin/sh "$d/bootstrap.sh" "$@" install' sh "$HOME/Downloads/telegram-mcp-gateway-0.2.0-bootstrap-posix.sh" "$HOME/Downloads/telegram-mcp-gateway-0.2.0-linux-arm64.tar.gz" && if [ -t 0 ] && [ -t 2 ]; then /opt/telegram-mcp-gateway/bin/tg-mcp-owner setup --after-install; else printf '%s\n' 'Installation prepared. Run /opt/telegram-mcp-gateway/bin/tg-mcp-owner setup in an ordinary terminal.' >&2; fi
```

Arch ARM is not part of this release. If OS utilities are missing, the installer shows the complete official-source package transaction and asks `Install ...? [y/N]`. Answer `y` or `yes` to approve; Enter, `n`, EOF or cancellation leaves gateway provisioning unstarted. The native package manager may ask for its own confirmation afterwards. It uses isolated Ubuntu official sources or Arch core/extra, never AUR/third-party repositories, and does not perform a full OS upgrade. Resolve stale Arch package databases by updating your OS yourself before retrying; the installer does not refresh the host database. [Linux checklist](docs/linux-private-test.md).

### Windows 11 x64

Open ordinary, **unelevated Windows PowerShell** under your administrator account. Command 2 opens a separate system-authorized installer, waits for it, then continues setup in your original terminal:

```powershell
Set-Location "$HOME\Downloads"; foreach($n in @('telegram-mcp-gateway-0.2.0-bootstrap-windows.ps1','telegram-mcp-gateway-0.2.0-windows-x64.zip')){ Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/NickShtefan/telegram-mcp-gateway/releases/download/v0.2.0/$n" -OutFile $n }
& {
  $principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent()); if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Start this command in ordinary, unelevated PowerShell.'}
  $tgInstall=@'
$ErrorActionPreference='Stop'; $acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); $admin=New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'; $acl.SetOwner($admin); foreach($sid in @($admin,(New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'))){ $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))) }; $d=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) ('TelegramMCPBootstrap-'+[guid]::NewGuid()); $null=[IO.Directory]::CreateDirectory($d,$acl); try{ Copy-Item -LiteralPath __TG_BOOTSTRAP__ -Destination "$d\bootstrap.ps1"; if((Get-FileHash "$d\bootstrap.ps1" -Algorithm SHA256).Hash.ToLowerInvariant() -ne '0a6b2fe828bdf17904975d7697a6d28bdc543116d1ec2175ca9343f8b99eb410'){throw 'Bootstrap checksum mismatch'}; & "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$d\bootstrap.ps1" -Archive __TG_ARCHIVE__ -Install; if($LASTEXITCODE -ne 0){throw 'Installation failed: preserve state'} }finally{Remove-Item -LiteralPath $d -Recurse -Force}
'@
  $tgBootstrap="$HOME\Downloads\telegram-mcp-gateway-0.2.0-bootstrap-windows.ps1"; $tgArchive="$HOME\Downloads\telegram-mcp-gateway-0.2.0-windows-x64.zip"; $quote={param([string]$value) "'"+$value.Replace("'","''")+"'"}; $tgInstall=$tgInstall.Replace('__TG_BOOTSTRAP__',(& $quote $tgBootstrap)).Replace('__TG_ARCHIVE__',(& $quote $tgArchive)); $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($tgInstall)); $child=Start-Process -FilePath "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList @('-NoLogo','-NoProfile','-EncodedCommand',$encoded) -Verb RunAs -Wait -PassThru; if($child.ExitCode -ne 0){throw 'Installation failed: preserve state'}
  if(-not [Console]::IsInputRedirected -and -not [Console]::IsErrorRedirected){ & "$env:ProgramData\TelegramMCPGateway\bin\tg-mcp-owner.cmd" setup --after-install; if($LASTEXITCODE -ne 0){throw 'Setup incomplete: preserve state'} }else{[Console]::Error.WriteLine('Installation prepared. In an ordinary terminal run C:\ProgramData\TelegramMCPGateway\bin\tg-mcp-owner.cmd setup.')}
}
```

The process-scoped PowerShell execution policy does not change machine policy or replace signature verification. An organization policy may refuse execution. Expected: installation creates a stopped manual service; the unelevated wizard performs login and starts/verifies it. [Windows checklist](docs/windows-private-test.md).

### Browser downloads

Command 1 is the supported download path: no browser touches the files. If you download in a browser instead, save both files into Downloads under their exact names and do not open them. Safari's default "Open safe files after downloading" (Safari > Settings > General) expands a `.tar.gz` into a folder and removes the archive, and other browsers may rename a repeated download. Command 2 then stops with `bootstrap_archive_missing` (or `bootstrap_verification_failed` for a renamed or altered file). Delete the expanded folder or renamed copy and use command 1, or turn that Safari option off and download again.

### Exact release pin

A commit cannot contain its own commit SHA, so the commands above cannot name the source commit of the release they install. They download only the assets of tag `v0.2.0` and accept any owner-signed 0.2.0 build found there. The [v0.2.0 release notes](https://github.com/NickShtefan/telegram-mcp-gateway/releases/tag/v0.2.0) add the exact source commit to command 2 (`-SourceSha` on Windows). The bootstrap then rejects every other owner-signed build. Check that the bootstrap hash for v0.2.0 matches the pin below. For a later release, independently authenticate its version-specific pin from the exact source checkout before executing a bootstrap.

### Bootstrap trust and limits

The bootstrap is the trust root. This README pins its SHA-256 in command 2, which checks a protected copy before running it, so the download location of the bootstrap does not matter. Authenticate this README independently (for example a reviewed clone or a known maintainer channel). A checksum from the same compromised release page is not independent proof. Replacing both an untrusted README and the bootstrap, compromising the repository/maintainer account, or compromising the local OS remains outside this protection.

The bootstrap accepts only a manifest signed by the embedded owner certificate (DER SHA-256 `f6d3d70c8909d302f24c6853dfb82dad1ab7a2a2006221699002117b6a22c682`) and verifies the certificate, signature and every payload before executing bundled Node; a package that is not owner-signed fails. Without the exact release pin it does not reject a different owner-signed 0.2.0 build: someone able to change the release assets, or a mistaken upload, can substitute an older or test build signed by the same owner, and the installation receipt then keeps that build until a deliberate migration. Test drafts carry their own tag in every asset name (for example `telegram-mcp-gateway-0.2.0-test.1-macos-arm64.tar.gz`), so the commands above never download them. The release's `SHA256SUMS` file detects corrupted downloads but is not an independent authenticity root.

No key, token or session is included. Private chats and writes default to disabled; secrets go only into the human terminal with agents/capture stopped.

</details>

### Update an installed Mac

Open the signed release for your Mac and use the two commands under **Update an existing managed Mac** for Apple Silicon or Intel. The first downloads the package. The second verifies it, switches the service to the new version, and checks that a previously running gateway is listening on its original port. The existing Telegram session, MCP credentials and client settings stay in place. Restart your MCP client and call `tg_status`. [Update and recovery details](docs/owner-setup.md#updating-a-managed-mac)

## Maintainer draft preparation

The development candidate is `0.3.0`. The public Installation section is pinned to the published `v0.2.0` assets. For an unpublished candidate, derive the bootstrap checksum from its independently authenticated source commit.

Only the owner runs the [one-command draft procedure](docs/release-qualification.md), entering the signing passphrase once. Never give the signing key/passphrase to an agent or CI. Links, CI and release commands use `NickShtefan/telegram-mcp-gateway`. Build and sign from this repository's exact chosen commit; earlier development artifacts cannot be relabeled as that commit. Source publication does not publish a tag, GitHub Release or npm package. The npm package retains `private: true` until an exact release is qualified and separately approved; do not run `npx tg-mcp` (that package belongs to another project).

## Development

Requires Node.js 22.13 or later and npm. macOS source builds also need the Xcode Command Line Tools to build the small universal kernel-lease helper; the release installer will bundle it, so target users need no compiler. The release policy is to recommend a tested LTS branch and verify the minimum Node version separately. Local and hosted source checks cover macOS, Linux and Windows; tested Node versions and live support evidence are recorded separately before release.

```bash
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test
node dist/cli/index.js help
```

The build removes old outputs before compiling. The npm archive contains JavaScript, declarations, this README and license notices when provided; tests, source maps, private records and runtime state are excluded.

State defaults to `~/.tg-mcp`, or `TG_MCP_HOME`. Use only sessions created by this gateway's own login, separately on each machine. Never share session strings with another process or project. Store credentials, database and session key outside the checkout and away from agents with shell access.

## Source directory map

| Path | Contents |
| --- | --- |
| src/core | Session pool, limiter, watchdog, configuration, login and file safety |
| src/storage | SQLite implementation, interfaces and immutable migrations |
| src/services | Reads, search, export, media, index, statistics and actions |
| src/policy, src/writegate | User access, scopes, untrusted content, audit and write confirmation |
| src/mcp, src/transport | MCP tools, compact responses, HTTP server and stdio proxy |
| src/cli | Owner administration and daemon commands |
| docs | Architecture, tool contracts, connections, risks and synthetic scenarios |

The source checkout contains the detailed documents; they are not part of the runtime npm archive. Contributor agent instructions live in `AGENTS.md`.

Read-only `tg-mcp setup preflight` is implemented; see [setup preflight](docs/setup.md). The signed installer includes the terminal bootstrap, protected service and owner setup. Source/synthetic checks do not prove a complete no-Node installation on an owner machine.

The [artifact foundation](docs/install-artifacts.md) verifies signed version/platform-bound candidates and provides no-Node verification entries. The v0.2.0 packages include the protected installation paths. Independent verifier/signer trust and live platform qualification remain required.

Candidate guides: [independent owner installation](docs/install-owner.md), [agent-assisted installation](docs/install-agent.md), and [client adapters](docs/client-adapters.md). Development changes use pull requests with passing checks and owner-approved merges; see [CONTRIBUTING.md](CONTRIBUTING.md). npm publishing remains disabled until its exact release commit is qualified and separately approved.
