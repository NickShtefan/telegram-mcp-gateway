# Private installation check: Ubuntu and Arch

Target: Ubuntu 24.04 x64/arm64 or fully updated Arch x64. Record distribution/architecture and Arch snapshot/package versions. Inspect the official-source prerequisite transaction and type INSTALL only if you approve it; cancel is a valid check.

## Steps and expected results

1. Obtain access to the owner-signed draft and a trusted README. Private draft access is a prerequisite (`gh auth login` with an authorized account); do not use unsigned CI files as a user installer.
2. Use an administrator account. Pick the README block for this platform, or the same block from the draft's release notes, which also pins the exact source commit. Command 1 downloads the bootstrap and archive into Downloads. Expected: no build, npm or local signing operation.
3. Run commands 1 and 2 exactly from an ordinary terminal. Expected: checksum OK; signature/source/platform checks succeed; protected service provisioning ends with needs_api_credentials and the service is not yet started.
4. Continue with Configure now in the same ordinary terminal, or run the installed setup command for a deferred/retry attempt. Normal labels use defaults silently; use setup --advanced only for custom labels. Stop agents/capture before secret entry; the wizard shows a concise warning. Enter Telegram application credentials, phone/code/2FA directly into hidden prompts.
5. Select a client and approve only an explicitly shown conflicting-entry replacement. Expected: sdk_connectivity_verified true, tokens absent from output, command returns without hanging.
6. Restart the chosen client and request a real telegram_gateway tg_status call. Expected: the chosen account connected. Plain prose or SDK-only success is insufficient.
7. Repeat the same wizard/candidate with the same labels. Expected: no token rotation or new Telegram login. In a separate trial, cancel and resume while preserving state.
8. Record safe OS/client versions, source/public certificate/manifest hashes, step outcomes and error codes in [outsider-test.md](outsider-test.md). Ubuntu x64 was attempted and failed as recorded below; Ubuntu arm64 and Arch x64 remain **not run live**. Never include secret values or recordings.

Each machine creates its own gateway session; never copy from another project/machine. Default private chats and writes remain closed. Real writes, migration, destructive uninstall and publication are separate owner actions.

## Ubuntu x64 owner trial: test.3

On 2026-10-30, the owner ran signed `v0.2.0-test.3`, source `1ab31d9e12306af84e64d87e2174d3625f719b43`, in a fresh Ubuntu 24.04.5 LTS x86-64 VM. Bootstrap and payload verification passed; the owner approved the official `acl` prerequisite transaction. The dedicated account and release files were installed, then private-storage preparation failed before service definition or Telegram login.

Read-only inspection confirmed that `/var/log` was `root:syslog` mode `0775`. The previous profile placed private logs beneath it, and the root-ancestry protection rejected that writable parent. The receipt retained only `identity` and `release`; service state and downloaded files are preserved. The final bootstrap code was `bootstrap_verification_failed`, which did not distinguish this provisioning failure from package-verification failures. The apt warnings about the deliberately absent configuration directory were not the failing step.

The corrected profile places private logs below the protected application prefix. Keep the failed trial separate from qualification of a new signed source: a receipt for test.3 does not authorize adopting another candidate. Use a fresh test environment or a separately reviewed recovery procedure; do not change system directory permissions or patch installed signed files to continue.
