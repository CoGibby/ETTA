# PPMO testing guide

This guide covers the internal Windows test build used before public distribution.

## Build the internal installer

```powershell
npm run package:win:internal
```

The internal command disables executable signing/resource editing so the installer can be produced without local Windows developer-mode privileges. It is for PPMO testing only; the public release path remains:

```powershell
npm run package:win
```

The installer is written to:

```text
artifacts/ETTA-Time-Tracker-Setup-<version>-x64.exe
```

Generate a checksum before sharing the artifact:

```powershell
Get-FileHash artifacts/ETTA-Time-Tracker-Setup-<version>-x64.exe -Algorithm SHA256
```

## Automated Windows Sandbox test

If Windows Sandbox is installed, run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-windows-sandbox-test.ps1
```

The test maps the repository read-only, installs the internal build, verifies both health endpoints, confirms per-user files, uninstalls the app, and writes the result to `artifacts/sandbox-results/result.log`.

## Clean-machine test checklist

Perform these tests on a clean Windows user profile, Windows Sandbox, or a clean Windows VM. Do not use a developer machine as the only test environment.

1. Install the NSIS installer with the default per-user settings.
2. Confirm the machine does not need Node.js, npm, Python, or a local repository checkout.
3. Launch **ETTA Time Tracker**.
4. Confirm the app remains open and no crash dialog appears.
5. Connect Jira with a valid PPMO test PAT.
6. Connect Outlook with a PPMO test account.
7. Sync at least two weeks of calendar history.
8. Review a previous day and the current day.
9. Add and remove a project.
10. Allocate time with the sliders and lock controls.
11. Push one entry, then use push-all.
12. Delete a worklog in Jira and confirm ETTA reflects the change after refresh.
13. Restart the app and confirm connections, projects, allocations, and history remain.
14. Disconnect and reconnect Jira.
15. Disconnect and reconnect Outlook.
16. Uninstall the app and confirm user data is intentionally retained or provide an explicit cleanup step.

## Expected runtime files

The packaged app must store runtime data under the current user's directory, not the installation directory:

```text
%APPDATA%/etta-time-tracker/data/timekeeper.db
%APPDATA%/etta-time-tracker/logs/server.log
```

Outlook token and sign-in state files should also remain beneath the same user-data directory.

## Known internal-build limitations

- The installer is unsigned and may trigger a Windows publisher warning.
- The internal build may use the default Electron icon.
- The build does not include an auto-update mechanism.
- Packaged Outlook redirect behavior must match the registered Azure redirect URI.
- Do not distribute the internal build outside the approved PPMO test group.

## Support data

If the app fails to start or sync, collect:

```text
%APPDATA%/etta-time-tracker/logs/server.log
```

Do not ask users to share Jira PATs, Microsoft tokens, or the SQLite database unless a manager explicitly approves that data collection.
