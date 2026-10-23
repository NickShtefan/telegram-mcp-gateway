# Security

Never post Telegram sessions, application hashes, bearer tokens, session keys, phone numbers or private chat content in issues or pull requests. Treat Telegram text as untrusted input. Use only this gateway's own login, separately on each machine. Never copy a session between machines or run a second client on it.

Use GitHub private vulnerability reporting when it is enabled for the public repository. The release process must verify that setting before public visibility changes. If it is unavailable, contact the repository owner privately before sharing sensitive details. Maintenance is voluntary, with no promised response or remediation deadline.

Managed installation separates immutable administrator-owned code/runtime from service-private Telegram state and original-user client credentials. A client bearer intentionally grants its configured gateway permissions. Clients sharing an OS identity can read each other's credentials; the installer does not protect human input from arbitrary same-user software. Stop agents and capture during owner input. The gateway cannot independently prove human consent: configure client permissions and confirm writes only after the owner approves the preview.

The local endpoint uses loopback HTTP. Keep it local unless you explicitly design and verify a protected remote deployment. Verification of a signed artifact is separate from initial trust in the verifier/signing fingerprint. Generated definitions, unit tests and SDK connectivity do not prove platform isolation, model tool loading or release readiness.
