# User installation

Prefer the [copyable agent prompt](../README.md#install-with-your-agent) if you want an agent to perform discovery, download and verification. System authorization and Telegram input still happen in your private terminal. Without a selected signed release, neither installation route proceeds.

The user installation entry for v0.3.0 is [README Installation](../README.md#installation). Public download commands require the signed assets from [v0.3.0](https://github.com/NickShtefan/telegram-mcp-gateway/releases/tag/v0.3.0) after publication. Use an administrator account and run the two commands for your platform: a terminal download of the bootstrap and signed archive of the release, authorized installation from a protected bootstrap copy checked against the SHA-256 pinned in README, then the unelevated wizard automatically continues with Configure now/later. Start both commands in an ordinary terminal; only the install payload requests elevation. The release notes supply commands for the selected tag and exact source commit. For a draft, verify the bootstrap using that version's candidate pin in the trusted README. No Node/npm, compilation, user signature or typed hashes are required.

The installer announces signature checks, application-file extraction counts and protected service preparation in an interactive terminal. Counts represent files actually written; they are not an overall installation percentage. Slow asynchronous installation steps report that they are still working. Redirected stdout retains JSON results and progress does not enter private protocol channels.

The bootstrap accepts a transport archive. It safely reads only nine fixed regular files in private staging, verifies the pinned DER certificate and RSA signature, takes the source SHA from the authenticated manifest (or requires it to equal the pinned source commit), validates each payload and only then executes bundled Node. A missing archive, for example after a browser expanded it, stops with `bootstrap_archive_missing`. Folder/source invocations remain for maintainer diagnostics, not the normal user route.

POSIX service identity/code/state are separate from the owner profile. Windows uses a virtual service account and administrator-owned ACLs; the short wizard command is `C:\ProgramData\TelegramMCPGateway\bin\tg-mcp-owner.cmd setup`. Initial installation creates an unstarted service, then the unelevated wizard performs protected login/client handoff and SDK verification. Default tools are core, with private chats and writes closed.

Keep the same candidate across cancellation/resume. Another source/certificate, foreign installation or corrupted state is not silently adopted. Do not delete/copy sessions or reinstall over an uncertain result. Provider sign-in and actual model tool loading remain separate from SDK connectivity.

Maintainer release signing is in [release-qualification.md](release-qualification.md). Human test checklists: [ARM Mac](mac-arm-private-test.md), [Intel Mac](mac-intel-private-test.md), [Windows](windows-private-test.md), [Linux](linux-private-test.md), [README-only acceptance](outsider-test.md).

## Verify a source-pinned command

Independently authenticate the selected release's full source commit and obtain its README. Use the platform block under **Installation** as the reference for the entire second command, including its protected staging, bootstrap hash, system authorization and setup steps. Compare all lines of the command from the release notes. The only changes for a source-pinned installation are:

- Use the selected tag's exact asset filenames. For an authorized test draft, the version portion of the filenames includes the draft suffix.
- Pass the independently verified full source SHA after the archive path on POSIX, or as `-SourceSha '<full SHA>'` immediately before `-Install` in the Windows payload.

For a managed Mac update, use the same macOS reference with the two changes above. Also change the bootstrap operation from `install` to `update` in `/bin/sh "$d/bootstrap.sh" "$@" install`, and omit the entire trailing `&& if [ -t 0 ] ... fi` setup continuation. All other parts of the privileged command must match. Stop if any other difference remains, even if the bootstrap hash matches.

The unprivileged download line selects the same repository, tag and two exact asset names. Use the native HTTPS command for a published release or the `gh release download` line for an explicitly authorized draft.
