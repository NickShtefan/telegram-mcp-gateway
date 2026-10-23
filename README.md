# Unofficial Telegram MCP Gateway

An MCP gateway for Telegram user accounts. One daemon owns the MTProto sessions and exposes tools to Claude Code, Codex, OpenCode and other MCP clients. Agents can read and search chats, fetch media, export messages, inspect channel counters, build a local index and prepare confirmed writes.

The gateway is a tool for an agent. It does not run models, watch chats, start agents or manage negotiation goals. Every Telegram operation begins with a tool call. This project is independent of Telegram.

**Development snapshot:** source is public under MIT; installer and platform/client qualification continue in this repository. No signed release or npm publication is available from this repository yet. Use the [source development workflow](#development) for now. Known setup limitations are recorded in [setup.md](docs/setup.md). Source checks and unsigned CI artifacts are available in [Platform foundations](https://github.com/NickShtefan/telegram-mcp-gateway/actions/workflows/platform-checks.yml).

## Capabilities

23 tools in five toolsets; `core` is enabled by default.

| Toolset | Capabilities |
| --- | --- |
| core | Account dialogs, chat resolution, search, history, comments, forum topics, JSONL/CSV exports, photos and previews |
| discover | Channel name search, similar channels and forwarding sources |
| analytics | Public channel counters, reach, engagement and trends |
| index | Explicit chat indexing and local substring search without Telegram calls |
| write | Preview and confirm replies, sends, reactions, joins and callback button presses |

One process owns each session. Bearer tokens separate gateway users and their account grants. Private conversations are closed by default. Every MTProto call passes through an account queue with limits and a deadline. A hung operation stops queued work and exits with code 1 for supervisor restart. Telegram text is labeled as untrusted data.

Write tools return a preview and `approval_id`. The agent must show it to the owner and call `tg_confirm` only after consent. The gateway cannot independently verify human approval; client permissions are part of this boundary.

## Installation

### Install with your agent

Copy this prompt into your coding agent:

```text
Install Telegram MCP Gateway on this computer by following the complete instructions at:
https://raw.githubusercontent.com/NickShtefan/telegram-mcp-gateway/main/INSTALL.md
Do the non-secret preparation and verification yourself. Keep system authorization
and Telegram credentials/codes/passwords in my own terminal, outside the agent.
```

The agent selects the matching signed release, downloads and verifies it, prepares the owner-only terminal steps and checks the actual MCP client afterwards. You choose the client, approve system changes and enter Telegram values yourself. The [agent installation guide](INSTALL.md) defines the workflow; release-specific prompts also pin its exact source commit.

**Current availability:** the managed installer is a qualification candidate and no signed release is published here yet. Until one is available, the agent reports `release_unavailable` without installing an unsigned build or falling back to source. [Source development](#development) remains available. Draft/test candidates require an explicit selection and authorized GitHub access; see [tester qualification](docs/outsider-test.md).

<details>
<summary>Manual installation and qualification commands</summary>

The commands below are templates for planned signed `v0.2.0` assets. Use them only when the maintainer provides the matching signed candidate. The intended end-user path needs no Node/npm, compiler, local signing key or typed hash; only the maintainer signs releases.

Before you start:

- Use an **administrator account**: a macOS Administrator, a Linux user allowed to use `sudo`, or a Windows administrator account. A standard account cannot authorize command 2. Command 3 runs unelevated as that same user. On Windows, elevate your own account: elevating with another account's credentials changes `$HOME`, so the commands would read another profile's Downloads.
- For a maintainer-provided draft, install [GitHub CLI](https://cli.github.com/) (for example `brew install gh`, `sudo apt install gh`, `sudo pacman -S github-cli` or `winget install GitHub.cli`) and sign in with an account authorized to download the draft (`gh auth login`). Command 1 uses it to download, including from a draft.
- The current Node 24 bundle needs macOS 13.5 or later. macOS 13.0-13.4 requires a separately prepared Node 22 bundle and is not qualified by these assets. Other platforms/versions remain unqualified until tested. See [platform checks](docs/outsider-test.md).

When the matching signed candidate is available, use the three commands for your platform, each as shown:

1. Download the bootstrap and the archive of release `v0.2.0` into Downloads under their exact names. Downloads is staging; the gateway is installed into its protected system prefix. Do not open or extract the archive.
2. Install with system authorization. The command copies the bootstrap into a fresh protected directory, checks it against the SHA-256 pinned in this README and only then runs it on the archive.
3. Run the wizard. Press Enter for local account/user labels if appropriate, choose clients, and enter your own Telegram API credentials, phone/code/2FA directly into its hidden prompts. Restart the selected clients afterwards, then ask for an actual `telegram_gateway` / `tg_status` tool call.

Expected: on macOS and Linux the checksum line ends in `OK`; then `needs_api_credentials` with no service started yet; the wizard then verifies the authenticated connection and tells you which clients to restart. Stop if a checksum fails or an existing/foreign installation is reported. Keep the same archive for retries.

### macOS Apple Silicon (arm64)

```sh
/bin/mkdir -p "$HOME/Downloads" && cd "$HOME/Downloads" && gh release download v0.2.0 --repo NickShtefan/telegram-mcp-gateway --clobber --pattern telegram-mcp-gateway-0.2.0-bootstrap-posix.sh --pattern telegram-mcp-gateway-0.2.0-macos-arm64.tar.gz
sudo /bin/sh -c 'set -eu; d=$(/usr/bin/mktemp -d /private/tmp/tg-bootstrap.XXXXXX); trap '\''/bin/rm -rf "$d"'\'' EXIT; /bin/cp "$1" "$d/bootstrap.sh"; printf "5154fcc944091cd2184983630c412970d0daf6722a2c11c4919dc86466144771  %s\n" "$d/bootstrap.sh" | /usr/bin/shasum -a 256 -c -; shift; /bin/sh "$d/bootstrap.sh" "$@" install' sh "$HOME/Downloads/telegram-mcp-gateway-0.2.0-bootstrap-posix.sh" "$HOME/Downloads/telegram-mcp-gateway-0.2.0-macos-arm64.tar.gz"
'/Library/Application Support/TelegramMCPGateway/bin/tg-mcp-owner' setup
```

### macOS Intel (x64)

```sh
/bin/mkdir -p "$HOME/Downloads" && cd "$HOME/Downloads" && gh release download v0.2.0 --repo NickShtefan/telegram-mcp-gateway --clobber --pattern telegram-mcp-gateway-0.2.0-bootstrap-posix.sh --pattern telegram-mcp-gateway-0.2.0-macos-x64.tar.gz
sudo /bin/sh -c 'set -eu; d=$(/usr/bin/mktemp -d /private/tmp/tg-bootstrap.XXXXXX); trap '\''/bin/rm -rf "$d"'\'' EXIT; /bin/cp "$1" "$d/bootstrap.sh"; printf "5154fcc944091cd2184983630c412970d0daf6722a2c11c4919dc86466144771  %s\n" "$d/bootstrap.sh" | /usr/bin/shasum -a 256 -c -; shift; /bin/sh "$d/bootstrap.sh" "$@" install' sh "$HOME/Downloads/telegram-mcp-gateway-0.2.0-bootstrap-posix.sh" "$HOME/Downloads/telegram-mcp-gateway-0.2.0-macos-x64.tar.gz"
'/Library/Application Support/TelegramMCPGateway/bin/tg-mcp-owner' setup
```

The Terminal may ask once for access to the Downloads folder: allow it.

### Ubuntu 24.04 x64 and Arch Linux x64

```sh
/bin/mkdir -p "$HOME/Downloads" && cd "$HOME/Downloads" && gh release download v0.2.0 --repo NickShtefan/telegram-mcp-gateway --clobber --pattern telegram-mcp-gateway-0.2.0-bootstrap-posix.sh --pattern telegram-mcp-gateway-0.2.0-linux-x64.tar.gz
sudo /bin/sh -c 'set -eu; d=$(/usr/bin/mktemp -d /tmp/tg-bootstrap.XXXXXX); trap '\''/bin/rm -rf "$d"'\'' EXIT; /bin/cp "$1" "$d/bootstrap.sh"; printf "5154fcc944091cd2184983630c412970d0daf6722a2c11c4919dc86466144771  %s\n" "$d/bootstrap.sh" | /usr/bin/sha256sum -c -; shift; /bin/sh "$d/bootstrap.sh" "$@" install' sh "$HOME/Downloads/telegram-mcp-gateway-0.2.0-bootstrap-posix.sh" "$HOME/Downloads/telegram-mcp-gateway-0.2.0-linux-x64.tar.gz"
/opt/telegram-mcp-gateway/bin/tg-mcp-owner setup
```

### Ubuntu 24.04 arm64

```sh
/bin/mkdir -p "$HOME/Downloads" && cd "$HOME/Downloads" && gh release download v0.2.0 --repo NickShtefan/telegram-mcp-gateway --clobber --pattern telegram-mcp-gateway-0.2.0-bootstrap-posix.sh --pattern telegram-mcp-gateway-0.2.0-linux-arm64.tar.gz
sudo /bin/sh -c 'set -eu; d=$(/usr/bin/mktemp -d /tmp/tg-bootstrap.XXXXXX); trap '\''/bin/rm -rf "$d"'\'' EXIT; /bin/cp "$1" "$d/bootstrap.sh"; printf "5154fcc944091cd2184983630c412970d0daf6722a2c11c4919dc86466144771  %s\n" "$d/bootstrap.sh" | /usr/bin/sha256sum -c -; shift; /bin/sh "$d/bootstrap.sh" "$@" install' sh "$HOME/Downloads/telegram-mcp-gateway-0.2.0-bootstrap-posix.sh" "$HOME/Downloads/telegram-mcp-gateway-0.2.0-linux-arm64.tar.gz"
/opt/telegram-mcp-gateway/bin/tg-mcp-owner setup
```

Arch ARM is not part of this release. If OS utilities are missing, the installer shows the complete official-source package transaction and asks you to type `INSTALL`. Cancel to leave gateway provisioning unstarted. It uses isolated Ubuntu official sources or Arch core/extra, never AUR/third-party repositories, and does not perform a full OS upgrade. Resolve stale Arch package databases by updating your OS yourself before retrying; the installer does not refresh the host database. [Linux checklist](docs/linux-private-test.md).

### Windows 11 x64

Open **Windows PowerShell as Administrator** with your own administrator account for commands 1 and 2. After command 2 finishes, close that elevated window and run command 3 in an ordinary (unelevated) PowerShell:

```powershell
Set-Location "$HOME\Downloads"; gh release download v0.2.0 --repo NickShtefan/telegram-mcp-gateway --clobber --pattern telegram-mcp-gateway-0.2.0-bootstrap-windows.ps1 --pattern telegram-mcp-gateway-0.2.0-windows-x64.zip; if($LASTEXITCODE -ne 0){throw 'Download failed'}
& { $acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); $admin=New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'; $acl.SetOwner($admin); foreach($sid in @($admin,(New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'))){ $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))) }; $d=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) ('TelegramMCPBootstrap-'+[guid]::NewGuid()); $null=[IO.Directory]::CreateDirectory($d,$acl); try{ Copy-Item -LiteralPath "$HOME\Downloads\telegram-mcp-gateway-0.2.0-bootstrap-windows.ps1" -Destination "$d\bootstrap.ps1"; if((Get-FileHash "$d\bootstrap.ps1" -Algorithm SHA256).Hash.ToLowerInvariant() -ne '14a97a5a93728c239ae38b587705698f230007ce00c524816eea9667e9e993ad'){throw 'Bootstrap checksum mismatch'}; & "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$d\bootstrap.ps1" -Archive "$HOME\Downloads\telegram-mcp-gateway-0.2.0-windows-x64.zip" -Install; if($LASTEXITCODE -ne 0){throw 'Installation failed: preserve state'} }finally{Remove-Item -LiteralPath $d -Recurse -Force} }
& "$env:ProgramData\TelegramMCPGateway\bin\tg-mcp-owner.cmd" setup
```

The process-scoped PowerShell execution policy does not change machine policy or replace signature verification. An organization policy may refuse execution. Expected: installation creates a stopped manual service; the unelevated wizard performs login and starts/verifies it. [Windows checklist](docs/windows-private-test.md).

### Browser downloads

Command 1 is the supported download path: no browser touches the files. If you download in a browser instead, save both files into Downloads under their exact names and do not open them. Safari's default "Open safe files after downloading" (Safari > Settings > General) expands a `.tar.gz` into a folder and removes the archive, and other browsers may rename a repeated download. Command 2 then stops with `bootstrap_archive_missing` (or `bootstrap_verification_failed` for a renamed or altered file). Delete the expanded folder or renamed copy and use command 1, or turn that Safari option off and download again.

### Exact release pin

A commit cannot contain its own commit SHA, so the commands above cannot name the source commit of the release they install. They download only the assets of tag `v0.2.0` and accept any owner-signed 0.2.0 build found there. The notes of each [release](https://github.com/NickShtefan/telegram-mcp-gateway/releases), generated by the owner's draft command, repeat these commands with that release's source commit added as the last argument of command 2 (`-SourceSha` on Windows); the bootstrap then rejects every other owner-signed build. Prefer those commands when the owner gave you the release link. They come from the release page, which is not an independent trust root: check that the SHA-256 in their command 2 equals the value here and that they differ from these commands only by the added commit.

### Bootstrap trust and limits

The bootstrap is the trust root. This README pins its SHA-256 in command 2, which checks a protected copy before running it, so the download location of the bootstrap does not matter. Authenticate this README independently (for example a reviewed clone or a known maintainer channel). A checksum from the same compromised release page is not independent proof. Replacing both an untrusted README and the bootstrap, compromising the repository/maintainer account, or compromising the local OS remains outside this protection.

The bootstrap accepts only a manifest signed by the embedded owner certificate (DER SHA-256 `f6d3d70c8909d302f24c6853dfb82dad1ab7a2a2006221699002117b6a22c682`) and verifies the certificate, signature and every payload before executing bundled Node; a package that is not owner-signed fails. Without the exact release pin it does not reject a different owner-signed 0.2.0 build: someone able to change the release assets, or a mistaken upload, can substitute an older or test build signed by the same owner, and the installation receipt then keeps that build until a deliberate migration. Test drafts carry their own tag in every asset name (for example `telegram-mcp-gateway-0.2.0-test.1-macos-arm64.tar.gz`), so the commands above never download them. The release's `SHA256SUMS` file detects corrupted downloads but is not an independent authenticity root.

No key, token or session is included. Private chats and writes default to disabled; secrets go only into the human terminal with agents/capture stopped.

</details>

## Maintainer draft preparation

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

Read-only `tg-mcp setup preflight` is implemented; see [setup preflight](docs/setup.md). The terminal bootstrap, protected service and owner/four-client components are under staged release preparation. Source/synthetic checks do not prove a complete no-Node installation on an owner machine.

The [artifact foundation](docs/install-artifacts.md) verifies signed version/platform-bound candidates and provides no-Node verification entries. Protected apply paths are implemented as release candidates. Independent verifier/signer trust and live platform qualification remain required.

Candidate guides: [independent owner installation](docs/install-owner.md), [agent-assisted installation](docs/install-agent.md), and [client adapters](docs/client-adapters.md). Development changes use pull requests with passing checks and owner-approved merges; see [CONTRIBUTING.md](CONTRIBUTING.md). npm publishing remains disabled until its exact release commit is qualified and separately approved.
