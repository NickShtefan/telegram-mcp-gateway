# User installation

The current user entry is [README Installation](../README.md#installation). Use an administrator account and run the three commands for your platform: a terminal download of the bootstrap and signed archive of the release, authorized installation from a protected bootstrap copy checked against the SHA-256 pinned in README, and the unelevated wizard. The release notes repeat these commands with the release's exact source commit pinned. No Node/npm, compilation, user signature or typed hashes are required.

The bootstrap accepts a transport archive. It safely reads only nine fixed regular files in private staging, verifies the pinned DER certificate and RSA signature, takes the source SHA from the authenticated manifest (or requires it to equal the pinned source commit), validates each payload and only then executes bundled Node. A missing archive, for example after a browser expanded it, stops with `bootstrap_archive_missing`. Folder/source invocations remain for maintainer diagnostics, not the normal user route.

POSIX service identity/code/state are separate from the owner profile. Windows uses a virtual service account and administrator-owned ACLs; the short wizard command is `C:\ProgramData\TelegramMCPGateway\bin\tg-mcp-owner.cmd setup`. Initial installation creates an unstarted service, then the unelevated wizard performs protected login/client handoff and SDK verification. Default tools are core, with private chats and writes closed.

Keep the same candidate across cancellation/resume. Another source/certificate, foreign installation or corrupted state is not silently adopted. Do not delete/copy sessions or reinstall over an uncertain result. Provider sign-in and actual model tool loading remain separate from SDK connectivity.

Maintainer release signing is in [release-qualification.md](release-qualification.md). Human test checklists: [ARM Mac](mac-arm-private-test.md), [Intel Mac](mac-intel-private-test.md), [Windows](windows-private-test.md), [Linux](linux-private-test.md), [README-only acceptance](outsider-test.md).
