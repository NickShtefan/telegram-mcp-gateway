# Owner draft preparation and qualification

This public repository starts with a source development snapshot. Signed releases and installer qualification remain pending. End users follow README Installation when the maintainer supplies a matching signed candidate; source development is documented separately. End users never build or sign a managed installation package. Only the owner prepares a signed draft, in an ordinary private terminal with agents and capture stopped.

## One owner command

Freeze a reviewed commit and its successful Platform foundations CI run. Check out that exact commit in a clean development checkout with dependencies installed. The owner command builds its local helper, downloads all five candidates, verifies artifact digests and manifest hashes from the corresponding CI job logs, and prompts for the encrypted signing key passphrase once:

```sh
npm run release:draft -- --sha FROZEN_FULL_COMMIT_SHA --run CI_RUN_ID --key /path/to/owner-signing-key.pem --certificate /path/to/owner-signing-certificate.pem
```

`CI_RUN_ID` is the run ID from the run's address, `https://github.com/OWNER/REPOSITORY/actions/runs/CI_RUN_ID` (for example `38175635260`), not the short run number shown as `#25`; anything shorter than eight digits is rejected as `ci_run_id_required`. These identifiers are maintainer inputs, never user installation inputs. The default repository is `NickShtefan/telegram-mcp-gateway`, tag `v0.2.0`.

The key and certificate paths have no default. Pass `--key` and `--certificate`, or set `TG_MCP_SIGNING_KEY` and `TG_MCP_SIGNING_CERTIFICATE` to the two paths in your own shell. Only paths go there: never put the passphrase in argv/environment, chat, CI or logs, and an agent must not inspect those files. No key/certificate onboarding or rotation is performed. The existing encrypted PKCS#8 RSA-3072 key must be owner-only; the certificate must match the embedded DER fingerprint `f6d3d70c8909d302f24c6853dfb82dad1ab7a2a2006221699002117b6a22c682`.

Add `--dry-run` to check a run first. It needs no key, terminal prompt or signature and creates no release: it performs every CI, tag and release check, downloads and inspects all five candidates, writes the release notes and prints the planned asset names as `draft_release_dry_run`.

## Test drafts and asset names

Every asset name carries the release name taken from the tag: `telegram-mcp-gateway-0.2.0-macos-arm64.tar.gz` for `v0.2.0`. To prepare a private test draft, pass `--tag v0.2.0-test.1`; its assets are then named `telegram-mcp-gateway-0.2.0-test.1-...`, so the README commands for `v0.2.0` never download them and a tester cannot mistake them for the final release. The command lists every release, drafts included, and rejects a tag name that already exists (`release_already_exists`); an existing Git tag must point at the frozen commit. It never replaces or publishes a release.

## Expected result

Before the password prompt all five candidate identities, manifests and payloads have passed verification. After the prompt every candidate is checked again before any signature is written. The output directory contains:

- Five signed archives: macos-arm64, macos-x64, linux-x64, linux-arm64 (`.tar.gz`), windows-x64 (`.zip`).
- The two bootstraps and `SHA256SUMS`, with the same release-name prefix.
- `RELEASE-NOTES.md` and diagnostic/download work files; only the eight public assets above are uploaded.

The release notes include a copyable agent prompt pointing to `INSTALL.md` at the release's exact source SHA, with the same repository/tag/SHA selection. They also hold the README Installation commands for every platform with that source pinned (the last argument of command 2, `-SourceSha` on Windows), so a tester following them installs only that build. Freeze a commit containing `INSTALL.md`; do not point an agent at a later branch revision. The final result says `draft_release_created` and `published: false`. GitHub Release is created with `--draft` against the frozen SHA. No repository, visibility change, npm package or published release is created.

On failure the command prints only a safe record: `error_code` (its own code, or `draft_release_failed` with a system `cause` such as `ENOENT`), `stage` and, once created, the `output` directory. Inspect or delete that directory yourself before retrying; nothing is overwritten. Missing/expired seven-day CI artifacts require a new successful run of the same chosen source, not a silent source substitution.

## Trust and access

The release target and CI candidates have one source SHA. Manifests bind the exact source/runtime/platform and are signed by the owner. The README pins the bootstrap SHA-256 values of the current bootstrap bytes (a test enforces this), and command 2 checks a protected copy against them. Release notes add the exact source pin but are not an independent trust root; adjacent release assets and unsigned SHA256SUMS alone cannot establish trust. See README limitations.

Because the README pins the bootstrap bytes of its own commit, change a bootstrap only together with a new release: README commands on the default branch must check the bootstrap that the current release ships.

Private drafts require authorized GitHub access; testers download with `gh release download`, which works for drafts. The owner can hand the public signed files to a tester without handing over a private key. No anonymous availability is claimed before separate publication/visibility approval. See [outsider-test.md](outsider-test.md).

## Repository and public downloads

Links, `--repo` defaults, CI candidates and download commands use `NickShtefan/telegram-mcp-gateway` (`REPOSITORY` in `scripts/release/plan.mjs`). A source import does not import earlier tags, draft releases or CI artifacts. Prepare every release from a reviewed commit in this repository:

1. Wait for successful Platform foundations CI for the exact commit. Its unsigned candidates are verification inputs, not signed end-user packages.
2. Prepare and qualify a signed draft from that same commit. Keep the README status accurate while no qualified release is available.
3. On separately approved publication, regenerate the README Installation blocks with `installCommands()` and `download: 'public'` (`curl`/`Invoke-WebRequest`, no GitHub account), then verify anonymous acquisition.
4. Run `npm test`: README commands, links and generator must agree. GitHub Release, version tag and npm package must use the same approved source identity.

Draft releases always need `gh`, even in a public repository.

## Required live qualification

Use fresh, otherwise uninstalled macOS and Windows environments with a new, empty administrator account (the wizard itself runs unelevated). A new user on a machine with a global gateway installation is not a clean-install test. Do not delete another user's gateway to make a test pass. Existing legacy installations are excluded from clean-install proof.

Follow only README plus the signed draft and record each place that required external help. Also qualify available Intel macOS, Ubuntu 24.04 x64/arm64 and Arch x64 using their checklists. Each machine gets its own fresh Telegram session through gateway login. Never copy sessions. Default checks are read-only; any write needs its own preview and owner consent on the controlled account/channel.

The final qualification review is one independent round before merge/publication; correct medium-or-higher findings and reverify. Merge, publish, repository visibility and npm remain exact owner decisions. A changed final release SHA requires its own artifacts/verification.
