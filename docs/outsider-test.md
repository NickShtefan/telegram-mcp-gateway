# README-only installation acceptance

This is an execution checklist, not a claim of completed live qualification. Automated archive/signature/parser tests do not replace a new-user install.

## Environment and access

Use a fresh macOS arm64 VM or otherwise uninstalled test Mac and a fresh Windows 11 x64 VM/test computer. Create a new, empty OS user with administrator rights yourself (the installation needs system authorization; the wizard runs unelevated). Do not reuse or alter a global installation, copy a Telegram session, or ask an agent to handle a signing key/password/login code.

Start with only README and the owner-signed draft. GitHub private drafts need authorized access and are not visible to anonymous/read-only outsiders in the same way as a public release. The owner must arrange appropriate draft access (the commands download with `gh`) or hand over the public signed assets plus an independently trusted README. Record this limitation as an access prerequisite, not a successful anonymous test.

The owner has confirmed availability of macOS only. Windows source/archive CI is available, but the live new-user Windows row remains blocked until a test environment is provided.

## Trial

1. Let the tester choose the correct asset using only README. Record confusion around arm64/Intel, Linux architecture and draft access.
2. Run the three commands for the platform from README, or the same commands from the draft's release notes with the exact source pin; record which. No Node/npm, compiler, local signing or typed hashes may be required. Record any browser download and what it did to the archive.
3. Approve system changes manually. On Linux inspect/confirm only the displayed official-source prerequisite transaction with `INSTALL`.
4. Complete wizard defaults, API application creation, phone/code/2FA and client selection. Secrets remain in the human terminal with agents/capture stopped.
5. Restart the selected client and observe a real `telegram_gateway` / `tg_status` call. SDK success without model tool loading is incomplete.
6. Repeat the same setup without a new login/token. Test cancellation/retry on the same candidate in a separate controlled run. Preserve state on failures.

## Evidence sheet

| Target | OS/build and candidate SHA | Commands before wizard | Needed help or external lookup | SDK / model tool result | Result |
| --- | --- | --- | --- | --- | --- |
| New macOS arm64 user | Pending owner execution | Pending | Pending | Pending | Not run |
| New Windows 11 x64 user | Environment unavailable | Pending | Pending | Pending | Blocked: no live test environment |
| Intel macOS (not lab) | Pending | Pending | Pending | Pending | Not run |
| Ubuntu 24.04 x64/arm64 | Pending | Pending | Pending | Pending | Not run |
| Arch x64 | Pending; record snapshot/package versions | Pending | Pending | Pending | Not run |

Record only safe metadata/error codes and where wording failed. Do not attach client-profile contents, tokens, sessions, secret-terminal recordings or screenshots. Mark a row passed only after executing it. Publication is outside this checklist.
