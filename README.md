# ETTA Time Tracker

ETTA turns Outlook sent mail and calendar activity into reviewed Jira worklogs. This repository contains both the existing Next.js application and its Electron desktop shell.

## Repository structure

```text
electron/             Electron main process, preload bridge, and desktop TypeScript config
src/                  Next.js UI, API routes, and application logic
scripts/              Outlook helpers and build staging scripts
public/               Application images and static assets
tests/                Python Outlook regression tests
electron-builder.json Desktop installer configuration
```

The production desktop application starts the Next.js standalone server on a private loopback port and displays it in a sandboxed Electron window. Application data is stored under Electron's per-user `userData` directory, not beside the installed application.

## Development

Prerequisites for the current migration stage:

- Node.js 18 or newer
- Python 3.9 or newer for the legacy Outlook helper

```powershell
npm install
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
npm run dev
```

The Electron window waits for the Next.js development server at `http://127.0.0.1:3000`.

## Builds

```powershell
npm run lint
npm run typecheck
npm run build
npm run package:win        # Windows NSIS installer
npm run package:mac        # macOS .dmg + .zip for arm64 and x64
```

Windows installer output is written to `artifacts/`.

## Releases & in-place updates

Releases are built by GitHub Actions on version tags, so installers are no longer shipped by
hand.

1. Bump `version` in `package.json` (single source of truth).
2. Commit and push, then tag the release, e.g. `git tag v1.0.1 && git push github v1.0.1`.
3. The `release` workflow builds and publishes both the Windows (NSIS) installer and the
   macOS `arm64` + `x64` packages (dmg + zip) to the ETTA GitHub Releases feed
   (`publish: { provider: github }` in `electron-builder.json`).

`electron-updater` (wired in `electron/main.ts`) polls that same GitHub Releases feed and
delivers in-place updates - testers install once, and later versions update automatically
(`autoDownload` and `autoInstallOnAppQuit` are on). Version tags must increase, because
`electron-updater` compares the feed version against the installed `app.getVersion()`.

`release.yml` publishes **Windows first**. The macOS job is gated on a repository variable
`RELEASE_MACOS` (set it to `true` once the UCSD Developer ID signing handoff + secrets are
ready); until then, only Windows artifacts are published to the feed, and macOS is signed separately.

Manual handoff builds are still available:
- `npm run package:win` / `npm run package:mac` - build locally with `--publish never`.
- `.github/workflows/build-mac.yml` - manual macOS build (`--publish never`), uploads the
  `etta-mac` GitHub Actions artifact for offline handoff.

### macOS builds and code signing

ETTA has no Apple Developer signing identity, so macOS artifacts are currently **unsigned**. They must be built on macOS (an Apple machine or the `build-mac` GitHub Actions workflow) - electron-builder cannot produce a `.dmg` on Windows. Gatekeeper will prompt testers to **Open Anyway** on first launch until signing/notarization is added later.

## Migration status

The desktop shell and installer structure are in place. Microsoft Graph still runs through the existing Python helper and will be migrated to Node.js/TypeScript. Until that port is complete, packaged Outlook import requires a bundled Python helper; development can use `.venv`.

See [docs/architecture.md](docs/architecture.md) for the target architecture and remaining work.