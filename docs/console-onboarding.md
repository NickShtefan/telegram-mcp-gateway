# Console onboarding improvements

Tracked in [issue #7](https://github.com/NickShtefan/telegram-mcp-gateway/issues/7). This stage changes owner interaction, not Telegram connection recovery or platform qualification.

## Scope

- [x] Linux prerequisite consent uses a conventional `[y/N]` question after the complete isolated official-source transaction preview. Case-insensitive y/yes approves; Enter/no/EOF/cancellation declines before gateway provisioning. Malformed input is bounded to three attempts. Native apt/pacman confirmations, source isolation and the package allowlist remain unchanged.
- [x] API instructions form a distinct YOUR ACTION REQUIRED block with the official website, three numbered steps and the api_id/api_hash field names. Suitable interactive terminals emphasize the heading; plain/NO_COLOR output remains readable ASCII. Progress stays paused during human input and between the consecutive API fields.
- [x] API ID and phone use visible human-terminal input. API hash starts hidden and Ctrl+T toggles one-line inspection/editing. Submission, Ctrl+C/Ctrl+D, EOF and abort clear the revealed line and restore terminal input state; ANSI resize handling clears reflowed rows. Narrow/unknown-width terminals explain that the hash remains hidden. OTP and 2FA stay hidden. Human prompt display is separate from logger/progress/JSON/argv/history output.
- [x] Console login offers QR or phone through arrows/Enter or numeric/text input, with no browser/listener. The pinned QR encoder produces refreshable half-cell glyphs with four-module quiet zones and explicit black/white contrast. A code must fit the terminal's known dimensions; otherwise the protected attempt fully stops before a phone fallback. QR expires/clears and is removed before further prompts, success or cancellation. The separate console_qr plan capability does not enable browser-only deferred app selection.

The ordinary installed launcher is the supported full console path on POSIX and Windows. Internal direct administrator/Windows non-broker compatibility routes retain safe phone-only operation. Browser setup and browser-to-console transitions retain protected teardown-before-retry and use the same console adapter. Unverified API pairs remain in owner-process memory only during retries; successful authorization retains the existing durable persistence rules.

## Validation

Local build and typecheck pass. The full synthetic suite has 1020 passed tests and 11 skipped tests across 59 passed files and one skipped file. Tests cover yes/no/default/EOF/malformed prerequisite decisions with fake package managers, unchanged official-source isolation, generated bootstrap hash agreement, action formatting, visible versus hidden prompts, Ctrl+T editing, input cleanup, terminal QR matrix/quiet-zone orientation, refresh/expiry/size refusal, no listener, private frame handling, preserved browser selection and the shared worker QR gates. The Windows read-only contract fixture checks broker capability booleans and legacy fallback; native Windows execution remains a CI check when PowerShell is unavailable locally.

Coordinator real-PTY checks pass the visible/hidden/reveal input paths, QR refresh/2FA/cancel, phone login, numbered fallback and narrow-terminal retry with synthetic data. A separate macOS Vision decoder confirms that a glyph-derived image decodes to the exact synthetic QR payload. These checks do not involve real credentials, installed client profiles, package managers, services or Telegram accounts.

Delivery follows one implementation stage, one independent read-only review, correction of confirmed Medium-or-higher findings, then coordinator validation of the exact final source and PR/CI. Merge, signed artifacts and live owner qualification require their own approval. Linux qualification remains incomplete; this UX change does not mark the ongoing trial passed.
