# Private installation check: Apple Silicon Mac

Target: macOS arm64. Use a fresh uninstalled environment; this chat/development Mac is arm64. If you already installed another candidate, stop and plan migration rather than overwriting it.

**Installation result: passed, owner-confirmed.** The owner reported successful installation on the Apple Silicon M1 Mac on 2026-10-29 and reconfirmed it on 2026-10-30. The checklist below is retained for reproducibility and future candidate regression checks.

## Steps and expected results

1. Obtain access to the owner-signed draft and a trusted README. Private draft access is a prerequisite (`gh auth login` with an authorized account); do not use unsigned CI files as a user installer.
2. Use an administrator account. Pick the README block for this platform, or the same block from the draft's release notes, which also pins the exact source commit. Command 1 downloads the bootstrap and archive into Downloads. Expected: no build, npm or local signing operation.
3. Run commands 1 and 2 exactly from an ordinary terminal. Expected: checksum OK; signature/source/platform checks succeed; protected service provisioning ends with needs_api_credentials and the service is not yet started.
4. Continue with Configure now in the same ordinary terminal, or run the installed setup command for a deferred/retry attempt. Normal labels use defaults silently; use setup --advanced only for custom labels. Stop agents/capture before secret entry; the wizard shows a concise warning. Enter Telegram values directly into the private wizard. Console API ID/phone are visible, API hash starts hidden with Ctrl+T reveal, and code/2FA stay hidden; console QR uses the same protected worker.
5. Select a client and approve only an explicitly shown conflicting-entry replacement. Expected: sdk_connectivity_verified true, tokens absent from output, command returns without hanging.
6. Restart the chosen client and request a real telegram_gateway tg_status call. Expected: the chosen account connected. Plain prose or SDK-only success is insufficient.
7. Repeat the same wizard/candidate with the same labels. Expected: no token rotation or new Telegram login. In a separate trial, cancel and resume while preserving state.
8. Record safe OS/client versions, source/public certificate/manifest hashes, step outcomes and error codes in [outsider-test.md](outsider-test.md). Current installation result: **passed, owner-confirmed**; see the report below. Never include secret values or recordings.

Each machine creates its own gateway session; never copy from another project/machine. Default private chats and writes remain closed. Real writes, migration, destructive uninstall and publication are separate owner actions.

## Owner-reported installation result

On 2026-10-29, the owner reported that installation on the M1 Mac (macOS ARM64) had completed successfully. On 2026-10-30, the owner reconfirmed that both macOS installations were successful and identified only Ubuntu, Windows and Arch as the remaining platform installation tests.

The report does not specify an exact source SHA or OS build. Keep those details unspecified rather than assigning the Intel Mac's source or the current checkout. This is a completed owner installation trial; any checks of a changed installer candidate are recorded separately.

## Maintainer-only signing files

Owner draft preparation is separate from this user trial. The owner passes the key and certificate paths explicitly (see [release-qualification.md](release-qualification.md)); an agent/tester must never inspect those files.
