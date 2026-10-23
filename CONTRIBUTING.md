# Contributing

Changes use pull requests with successful required checks and owner-approved merges. Do not push development directly to main. Use conventional English commit messages, keep documentation and user-facing text in English, and avoid the em dash character.

Run `npm ci --ignore-scripts`, `npm run build`, `npm run typecheck` and `npm test`. macOS contributors need free Xcode Command Line Tools for the universal lease helper; Windows contributors use the included .NET Framework compiler. Users receive compiled helpers. Test Telegram through the injected fake client and an in-memory database. Never include real credentials, sessions, phone numbers, private chat content or connection strings in tests, logs or reports.

Preserve one-process session ownership, the queue/deadline boundary, per-account entity caches, canonical chat IDs, immutable published migrations, stderr-only operational logging and untrusted-content labels. A stuck MTProto call requires process exit and supervisor restart. Write actions require preview and direct owner consent before confirmation. The gateway does not run models, watch chats or generate tasks for agents.

Submitting a pull request confirms that you have the right to contribute its contents under this project's MIT license. No CLA or mandatory DCO sign-off is required. Explain the concrete problem, resulting behavior and relevant validation. Include provenance and required notices for third-party material. Maintenance is voluntary; response or fix times are not guaranteed.
