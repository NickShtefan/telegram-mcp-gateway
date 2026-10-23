# Private installation check: Ubuntu and Arch

Target: Ubuntu 24.04 x64/arm64 or fully updated Arch x64. Record distribution/architecture and Arch snapshot/package versions. Inspect the official-source prerequisite transaction and type INSTALL only if you approve it; cancel is a valid check.

## Steps and expected results

1. Obtain access to the owner-signed draft and a trusted README. Private draft access is a prerequisite (`gh auth login` with an authorized account); do not use unsigned CI files as a user installer.
2. Use an administrator account. Pick the README block for this platform, or the same block from the draft's release notes, which also pins the exact source commit. Command 1 downloads the bootstrap and archive into Downloads. Expected: no build, npm or local signing operation.
3. Run commands 1 and 2 exactly. Expected: checksum OK; signature/source/platform checks succeed; protected service provisioning ends with needs_api_credentials and the service is not yet started.
4. Run command 3, the installed owner wizard, unelevated as the same user. Explain/accept defaults or use stable local labels. Type OWNER READY only after agents/capture are stopped. Enter Telegram application credentials, phone/code/2FA directly into hidden prompts.
5. Select a client and approve only an explicitly shown conflicting-entry replacement. Expected: sdk_connectivity_verified true, tokens absent from output, command returns without hanging.
6. Restart the chosen client and request a real telegram_gateway tg_status call. Expected: the chosen account connected. Plain prose or SDK-only success is insufficient.
7. Repeat the same wizard/candidate with the same labels. Expected: no token rotation or new Telegram login. In a separate trial, cancel and resume while preserving state.
8. Record safe OS/client versions, source/public certificate/manifest hashes, step outcomes and error codes in [outsider-test.md](outsider-test.md). Current live result: **not run**. Never include secret values or recordings.

Each machine creates its own gateway session; never copy from another project/machine. Default private chats and writes remain closed. Real writes, migration, destructive uninstall and publication are separate owner actions.
