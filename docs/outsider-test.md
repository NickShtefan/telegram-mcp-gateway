# README-only installation acceptance

On 2026-11-20, the maintainer confirmed testing installation on macOS, Ubuntu and Arch Linux during development. Windows 11 x64 is the only platform still awaiting a manual installation test.

## Environment and access

For the remaining [Windows trial](windows-private-test.md), use a Windows 11 x64 VM or computer with a fresh administrator account and no existing gateway installation. Start the wizard from ordinary, unelevated PowerShell. Do not reuse or alter a global installation, copy a Telegram session, or ask an agent to handle a signing key/password/login code.

Start with the signed release and an independently trusted copy of its README. For a private draft, arrange authorized access or have the maintainer provide the signed assets. Record how the tester obtained them.

## Trial

1. Let the tester choose the correct asset using only README. Record confusion around arm64/Intel, Linux architecture and draft access.
2. Run the two commands for the platform from README, or the same commands from the release notes with the exact source pin; record which. No Node/npm, compiler, local signing or typed hashes may be required. Record any browser download and what it did to the archive.
3. Approve system changes manually. On Linux inspect/confirm only the displayed official-source prerequisite transaction with `y`/`yes` at `[y/N]`; Enter/no/EOF cancels.
4. Continue with Configure now (or test Configure later and the separate retry command), then complete automatic defaults, API application creation, phone/code/2FA and client selection. Secrets remain in the human terminal with agents/capture stopped.
5. Restart the selected client and observe a real `telegram_gateway` / `tg_status` call. SDK success without model tool loading is incomplete.
6. Repeat the same setup without a new login/token. Test cancellation/retry on the same candidate in a separate controlled run. Preserve state on failures.

## Evidence sheet

| Target | Installation result | Evidence | Remaining installation action |
| --- | --- | --- | --- |
| macOS ARM64 (Apple Silicon M1) | **Passed, owner-confirmed** | Reported 2026-10-29 and reconfirmed 2026-10-30; [ARM Mac result](mac-arm-private-test.md#owner-reported-installation-result) | None for the reported installation |
| macOS x64 (Intel/x86-64) | **Passed, owner-confirmed** | Source `7b6a5a692ff78983ff2b15b19902c4876059c629`; reported 2026-10-29 and reconfirmed 2026-10-30; [Intel Mac result](mac-intel-private-test.md#owner-reported-installation-result) | None for the reported installation |
| Ubuntu 24.04 (x64 and arm64 packages) | Tested by maintainer | The 2026-11-20 report covers Ubuntu at the distribution level. An [earlier x64 test.3 trial](linux-private-test.md#ubuntu-x64-owner-trial-test3) failed during private-storage preparation. | None at the platform level |
| Arch Linux x64 | Tested by maintainer | Reported 2026-11-20 | None at the platform level |
| Windows 11 x64 | **Manual installation pending** | Automated checks cover the Windows package. | Run the [Windows installation trial](windows-private-test.md) |

Record only safe metadata/error codes and where wording failed. Do not attach client-profile contents, tokens, sessions, secret-terminal recordings or screenshots. Mark a row passed only after execution, including an explicit owner report of successful execution. Publication is outside this checklist.

## Owner installation evidence

On 2026-10-29, the owner reported successful installation on both the M1 and Intel Macs. The owner reconfirmed both installations on 2026-10-30.

The Intel report identifies source `7b6a5a692ff78983ff2b15b19902c4876059c629` and successful browser setup. The M1 report does not identify a source SHA or exact OS build; those fields remain unspecified. Do not attach the Intel SHA or the current checkout SHA to the M1 result without evidence.

The maintainer's November report covers installation testing during development. The Linux installer revisions and per-client results were unspecified. Record checks of a particular signed release against its source commit.
