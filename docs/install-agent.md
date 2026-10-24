# Agent-assisted installation

The copyable prompt is in [README Installation](../README.md#installation). The complete, versioned agent entry is [INSTALL.md](../INSTALL.md). Release notes generate a prompt pinned to the exact source commit, release tag and repository, so the agent does not silently install a different build or follow a later branch revision.

The agent executes the unprivileged discovery, release selection, download and verification steps. It prepares the exact owner terminal handoff and resumes client verification afterwards. The owner supplies system authorization and Telegram values in the installed private wizard, with agents/capture stopped. The gateway itself runs no model, watcher or task scheduler.

The owner may choose the optional local browser guide for API credentials and QR/phone/2FA, or enter everything manually in the console without an HTTP listener. Agents, capture and UI automation remain stopped during human secret entry.

No signed release currently exists in this repository. That outcome is `release_unavailable`, not permission to install an unsigned Actions candidate, borrow an old repository's assets or fall back to a source build. A draft/test candidate needs an explicit owner selection. A missing provider or client restart is reported separately from gateway readiness.

Use the same signed installer and owner protections as [independent installation](install-owner.md). The progress/resume CLI and gateway-only activation remain incomplete as documented in [setup.md](setup.md); the guide does not add those commands or claim they exist. Repeat setup must preserve valid sessions/grants/tokens.
