# Private installation check: Intel Mac

Target: macOS x64. Use an otherwise uninstalled Intel Mac or a clean VM. An existing global gateway installation is not a clean-install environment; do not stop or alter it to make this test pass.

## Steps and expected results

1. Obtain access to the owner-signed draft and a trusted README. Private draft access is a prerequisite (`gh auth login` with an authorized account); do not use unsigned CI files as a user installer.
2. Use an administrator account. Pick the README block for this platform, or the same block from the draft's release notes, which also pins the exact source commit. Command 1 downloads the bootstrap and archive into Downloads. Expected: no build, npm or local signing operation.
3. Run commands 1 and 2 exactly from an ordinary terminal. Expected: checksum OK; signature/source/platform checks succeed; protected service provisioning ends with needs_api_credentials and the service is not yet started.
4. Continue with Configure now in the same ordinary terminal, or run the installed setup command for a deferred/retry attempt. Normal labels use defaults silently; use setup --advanced only for custom labels. Stop agents/capture before secret entry; the wizard shows a concise warning. Enter Telegram application credentials, phone/code/2FA directly into hidden prompts.
5. Select a client and approve only an explicitly shown conflicting-entry replacement. Expected: sdk_connectivity_verified true, tokens absent from output, command returns without hanging.
6. Restart the chosen client and request a real telegram_gateway tg_status call. Expected: the chosen account connected. Plain prose or SDK-only success is insufficient.
7. Repeat the same wizard/candidate with the same labels. Expected: no token rotation or new Telegram login. In a separate trial, cancel and resume while preserving state.
8. Record safe OS/client versions, source/public certificate/manifest hashes, step outcomes and error codes in [outsider-test.md](outsider-test.md). Current full-checklist result: **not completed**; see the owner-reported installation result below. Never include secret values or recordings.

Each machine creates its own gateway session; never copy from another project/machine. Default private chats and writes remain closed. Real writes, migration, destructive uninstall and publication are separate owner actions.

## Owner-reported installation result

On 2026-10-29, the owner confirmed successful installation on macOS x86-64 using source `7b6a5a692ff78983ff2b15b19902c4876059c629`. The supplied non-secret progress confirmed checksum/signature checks and protected service installation; the owner also reported successful browser setup. Detailed progress and the browser guide were useful. The eight approved usability follow-ups are tracked in [issue #4](https://github.com/NickShtefan/telegram-mcp-gateway/issues/4).

This is a passed owner installation trial for that source. A clean/no-Node environment, actual model `tg_status`, reboot persistence, cancel/resume, repeated setup without rotation and the remaining isolation checks were not established by this report. The full checklist and README-only acceptance therefore remain incomplete. This result does not qualify future changed installer candidates or other operating systems.
