# README-only installation acceptance

This records platform installation results and the checklist for remaining trials. Automated archive/signature/parser tests do not replace a live install. As of 2026-10-30, both macOS installation trials have passed by owner confirmation. Ubuntu x64 test.3 failed during private-storage preparation; Ubuntu, Windows and Arch still require successful live installation qualification.

## Environment and access

For the remaining trials, use otherwise uninstalled Ubuntu 24.04 x64/arm64, Arch x64 and Windows 11 x64 VMs/test computers. Create a new, empty OS user with administrator rights yourself (the installation needs system authorization; the wizard runs unelevated). Do not reuse or alter a global installation, copy a Telegram session, or ask an agent to handle a signing key/password/login code.

Start with only README and the owner-signed draft. GitHub private drafts need authorized access and are not visible to anonymous/read-only outsiders in the same way as a public release. The owner must arrange appropriate draft access (the commands download with `gh`) or hand over the public signed assets plus an independently trusted README. Record this limitation as an access prerequisite, not a successful anonymous test.

The owner has completed installation on both available Macs and can prepare a Windows test environment. A fresh Ubuntu x64 VM reached the failed test.3 trial below; Ubuntu arm64 and Arch live environments still need preparation. Source/container/archive checks remain separate from these live installation results.

## Trial

1. Let the tester choose the correct asset using only README. Record confusion around arm64/Intel, Linux architecture and draft access.
2. Run the two commands for the platform from README, or the same commands from the draft's release notes with the exact source pin; record which. No Node/npm, compiler, local signing or typed hashes may be required. Record any browser download and what it did to the archive.
3. Approve system changes manually. On Linux inspect/confirm only the displayed official-source prerequisite transaction with `INSTALL`.
4. Continue with Configure now (or test Configure later and the separate retry command), then complete automatic defaults, API application creation, phone/code/2FA and client selection. Secrets remain in the human terminal with agents/capture stopped.
5. Restart the selected client and observe a real `telegram_gateway` / `tg_status` call. SDK success without model tool loading is incomplete.
6. Repeat the same setup without a new login/token. Test cancellation/retry on the same candidate in a separate controlled run. Preserve state on failures.

## Evidence sheet

| Target | Installation result | Evidence | Remaining installation action |
| --- | --- | --- | --- |
| macOS ARM64 (Apple Silicon M1) | **Passed, owner-confirmed** | Reported 2026-10-29 and reconfirmed 2026-10-30; [ARM Mac result](mac-arm-private-test.md#owner-reported-installation-result) | None for the reported installation |
| macOS x64 (Intel/x86-64) | **Passed, owner-confirmed** | Source `7b6a5a692ff78983ff2b15b19902c4876059c629`; reported 2026-10-29 and reconfirmed 2026-10-30; [Intel Mac result](mac-intel-private-test.md#owner-reported-installation-result) | None for the reported installation |
| Ubuntu 24.04 x64 | **Failed, test.3 private-storage preparation** | Source `1ab31d9e12306af84e64d87e2174d3625f719b43`; [Ubuntu failure evidence](linux-private-test.md#ubuntu-x64-owner-trial-test3) | Qualify the corrected signed candidate in a fresh environment |
| Ubuntu 24.04 arm64 | Not run live | Source/container checks do not establish a live installation result | Prepare environment and run the Linux trial |
| Windows 11 x64 | Not run live | Owner can prepare a test environment; source/archive CI is separate | Prepare environment and run the Windows trial |
| Arch x64 | Not run live | Record the rolling snapshot and package versions during the trial | Prepare environment and run the Linux trial |

Record only safe metadata/error codes and where wording failed. Do not attach client-profile contents, tokens, sessions, secret-terminal recordings or screenshots. Mark a row passed only after execution, including an explicit owner report of successful execution. Publication is outside this checklist.

## Owner installation evidence

On 2026-10-29, the owner reported successful installation on both the M1 and Intel Macs. On 2026-10-30, the owner explicitly reconfirmed that both macOS installations completed successfully and that only Ubuntu, Windows and Arch remain for platform installation testing.

The Intel report identifies source `7b6a5a692ff78983ff2b15b19902c4876059c629` and successful browser setup. The M1 report does not identify a source SHA or exact OS build; those fields remain unspecified. Do not attach the Intel SHA or the current checkout SHA to the M1 result without evidence.

These are completed owner installation trials. Detailed per-step observations are recorded only when supplied; missing metadata does not reset a confirmed installation to Not run. Record any regression checks for a changed installer candidate separately against that candidate, while retaining these historical results.
