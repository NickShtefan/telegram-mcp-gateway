# Installation flow improvements

Tracked in [issue #4](https://github.com/NickShtefan/telegram-mcp-gateway/issues/4). These implementation checks do not qualify a newly signed installer or a real Telegram/client environment.

## Accepted changes

- [x] 1. One interactive install/setup flow, with Configure now/later. The generated POSIX command returns from sudo before the owner wizard runs. Windows elevates only a fixed, encoded installation payload and waits before the original ordinary PowerShell runs the wizard. Redirected input/error output skips human secret entry. The separate installed setup command remains available.
- [x] 2. One concise warning replaces the typed readiness phrase. It explains that hidden input does not prevent same-user capture; agents/capture must remain stopped during owner input.
- [x] 3. Normal setup uses personal/owner labels without questions. The --advanced path accepts custom labels. Implicit defaults refuse existing custom or ambiguous state before opening Telegram, preserving sessions, grants and tokens.
- [x] 4. SSH and headless Linux recommend console; a local desktop recommends browser. Either choice can be overridden. Console creates no browser listener.
- [x] 5. Arrow/Enter interface menus and Space/Enter client checklists, with numbered/text fallback for limited terminals and cancellation/raw-mode cleanup.
- [x] 6. C in the waiting browser terminal continues in console inside the same wizard. The old protected coordinator must confirm exit and cleanup before retry. A failure to confirm termination stops setup. Completed durable state remains; submitted API values live only in owner-process memory during retries.
- [x] 7. QR starts automatically after API entry, with loading, refresh and an active phone alternative. Changing methods cancels the previous attempt and restarts only after protected cleanup; duplicate transition requests are rejected. Unverified API pairs are never durably cached.
- [x] 8. Browser success and terminal NEXT instructions prominently name the selected tools and describe desktop/CLI versus server-process restarts. A real telegram_gateway/tg_status call after restart remains the check for model tool loading.

## Validation and review

Build and typecheck pass. The local synthetic suite has 999 passed tests and 10 skipped tests across 56 passed files and one skipped file. Coverage includes real decoded keyboard bytes, fallback/cancellation, no implicit account duplication, cancellation during elevation, teardown-before-retry, failure to confirm worker termination, authenticated method switching, in-memory API reuse, closed console listeners, generated command/source/hash agreement, and a disposable command-continuation fixture with no privileged operations. The Windows README CI fixture parses both the ordinary outer command and its isolated elevated payload, then verifies the existing signed fixture without installation or UAC.

Coordinator browser and real PTY QA are recorded with the implementation review. One independent read-only review of implementation commit bba292c found two P2 issues. Both were corrected before coordinator validation; no second review round was started. No merge, signing, live service/profile mutation, Telegram operation or release publication is part of these local checks.

Updated bootstrap bytes require new source-matched signed artifacts and owner qualification. Existing signed candidates and installed gateways remain unchanged.

## Review corrections

1. Browser retry previously rearmed its raw terminal reader before renewed administrator approval. Controls now arm only when a protected-worker prompt or QR callback begins after the current approval/profile handshake, including remembered API answers. A regression pauses the second approval and proves that stdin remains free throughout that wait, then observes controls rearm only after the protected worker resumes.
2. A submitted phone number could remain queued across phone/code, QR and phone switching. Direct phone submission now consumes that pending value. Every method switch clears phone/code/password fields and pending phone state; an authentication epoch prevents stale status or request completion from restoring cancelled input. Execution-level regressions run the actual generated page script through both method changes, require fresh explicit phone entry, and reject stale status after switching/cancellation.
