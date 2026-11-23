# Owner draft preparation and qualification

The owner uses this procedure to prepare the v0.3.0 signed draft in a private terminal. Public downloads become available from [release v0.3.0](https://github.com/NickShtefan/telegram-mcp-gateway/releases/tag/v0.3.0) after separate publication approval.

The [installation evidence sheet](outsider-test.md#evidence-sheet) records the maintainer’s development tests, results for identified packages and the pending Windows 11 x64 trial.

## One owner command

Freeze a reviewed commit and its successful Platform foundations CI run. Check out that exact commit in a clean development checkout with dependencies installed. The owner command builds its local helper, downloads all five candidates, verifies artifact digests and manifest hashes from the corresponding CI job logs, and prompts for the encrypted signing key passphrase once:

```sh
npm run release:draft -- --sha FROZEN_FULL_COMMIT_SHA --run CI_RUN_ID --key /path/to/owner-signing-key.pem --certificate /path/to/owner-signing-certificate.pem
```

`CI_RUN_ID` is the run ID from the run's address, `https://github.com/OWNER/REPOSITORY/actions/runs/CI_RUN_ID` (for example `38175635260`), not the short run number shown as `#25`; anything shorter than eight digits is rejected as `ci_run_id_required`. These identifiers are maintainer inputs, never user installation inputs. The default repository is `NickShtefan/telegram-mcp-gateway`, tag `v0.3.0`.

The key and certificate paths have no default. Pass `--key` and `--certificate`, or set `TG_MCP_SIGNING_KEY` and `TG_MCP_SIGNING_CERTIFICATE` to the two paths in your own shell. Only paths go there: never put the passphrase in argv/environment, chat, CI or logs, and an agent must not inspect those files. No key/certificate onboarding or rotation is performed. The existing encrypted PKCS#8 RSA-3072 key must be owner-only; the certificate must match the embedded DER fingerprint `f6d3d70c8909d302f24c6853dfb82dad1ab7a2a2006221699002117b6a22c682`.

Add `--dry-run` to check a run first. It needs no key, terminal prompt or signature and creates no release: it performs every CI, tag and release check, downloads and inspects all five candidates, writes the release notes and prints the planned asset names as `draft_release_dry_run`.

## Test drafts and asset names

Every asset name carries the release name taken from the tag: `telegram-mcp-gateway-0.3.0-macos-arm64.tar.gz` for `v0.3.0`. To prepare a private test draft, pass `--tag v0.3.0-test.1`; its assets are then named `telegram-mcp-gateway-0.3.0-test.1-...`, so the README commands for `v0.3.0` never download them and a tester cannot mistake them for the final release. The command lists every release, drafts included, and rejects a tag name that already exists (`release_already_exists`); an existing Git tag must point at the frozen commit. It never replaces or publishes a release.

## Expected result

Before the password prompt all five candidate identities, manifests and payloads have passed verification. After the prompt every candidate is checked again before any signature is written. The output directory contains:

- Five signed archives: macos-arm64, macos-x64, linux-x64, linux-arm64 (`.tar.gz`), windows-x64 (`.zip`).
- The two bootstraps and `SHA256SUMS`, with the same release-name prefix.
- `RELEASE-NOTES.md` and diagnostic/download work files; only the eight public assets above are uploaded.

The release notes include a copyable agent prompt at the exact source SHA and source-pinned installation and Mac update commands. Stable-tag notes show native HTTPS downloads first and supply an authenticated draft download line for each platform. Test-tag notes use authenticated downloads. Verify the entire second command, including the bootstrap checksum, using the independently trusted source. Freeze a commit containing `INSTALL.md`; do not point an agent at a later branch revision. The final result says `draft_release_created` and `published: false`. GitHub Release is created with `--draft` against the frozen SHA. No repository, visibility change, npm package or published release is created. [Verify a source-pinned command](install-owner.md#verify-a-source-pinned-command)

On failure the command prints only a safe record: `error_code` (its own code, or `draft_release_failed` with a system `cause` such as `ENOENT`), `stage` and, once created, the `output` directory. Inspect or delete that directory yourself before retrying; nothing is overwritten. Missing/expired seven-day CI artifacts require a new successful run of the same chosen source, not a silent source substitution.

## Trust and access

The release target and CI candidates have one source SHA. Manifests bind the exact source/runtime/platform and are signed by the owner. README pins the v0.3.0 bootstrap SHA-256 values in the installation commands and the candidate table. Check against the matching version in the trusted exact source checkout. Command 2 checks a protected copy against those pins. Release notes add the exact source pin but are not an independent trust root; adjacent release assets and unsigned SHA256SUMS alone cannot establish trust. See README limitations.

Because the README pins the bootstrap bytes of its own commit, change a bootstrap only together with a new release: README commands must check the bootstrap for the release they name.

Private drafts require authorized GitHub access; testers download with `gh release download`, which works for drafts. The owner can hand the public signed files to a tester without handing over a private key. No anonymous availability is claimed before separate publication/visibility approval. See [outsider-test.md](outsider-test.md).

## Repository and public downloads

Links, `--repo` defaults, CI candidates and download commands use `NickShtefan/telegram-mcp-gateway` (`REPOSITORY` in `scripts/release/plan.mjs`). A source import does not import earlier tags, draft releases or CI artifacts. Prepare every release from a reviewed commit in this repository:

1. Wait for successful Platform foundations CI for the exact commit. Its unsigned candidates are verification inputs, not signed end-user packages.
2. Prepare and qualify a signed draft from that same commit. Keep the README status accurate while no qualified release is available.
3. After separately approved publication, verify anonymous downloads from the README and the release notes, including both Mac update commands. The notes for the stable tag already include the HTTPS commands.
4. Run `npm test`: README commands, links and generator must agree. GitHub Release, version tag and npm package must use the same approved source identity.

Draft releases always need `gh`, even in a public repository.

For macOS, release notes also contain separate source-pinned update commands for an existing managed installation. For owner qualification, record the source and architecture, a successful update, and a `tg_status` call through an already-configured client. Keep Telegram data and credentials out of the evidence. Hosted CI rebuilds the exact published v0.2.0 source and the candidate with disposable signing keys on a fresh Mac runner. It checks the server version through the same MCP endpoint, compares the encrypted synthetic session, credentials and account/profile grants, then reapplies the update to verify idempotence.

## Required live qualification

Use a fresh environment with a new administrator account for each manual installation trial. Run the wizard unelevated. A new user on a machine with a global gateway installation is not a clean-install test. Do not delete another user's gateway to make a test pass. Existing legacy installations are excluded from clean-install proof.

Follow only README plus the signed draft and record each place that required external help. Use the checklist for the platform under test. Each machine gets its own fresh Telegram session through gateway login. Never copy sessions. Default checks are read-only; any write needs its own preview and owner consent on the controlled account/channel. Record targeted regression checks for a changed macOS installer candidate separately from the completed owner installation trials.

The final qualification review is one independent round before merge/publication; correct medium-or-higher findings and reverify. Merge, publish, repository visibility and npm remain exact owner decisions. A changed final release SHA requires its own artifacts/verification.
