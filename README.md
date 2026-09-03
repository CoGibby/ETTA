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

Prerequisites:

- Node.js 18 or newer
- Windows Build Tools with the Visual Studio C++ workload for native modules and installer packaging

```powershell
npm install
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
npm run dev
```

The Electron window waits for the Next.js development server at `http://127.0.0.1:3000`.

## Tests

```powershell
npm test
```

The smoke suite starts an isolated Next.js server on port 3100 and uses a temporary SQLite database. It does not require live Jira or Outlook credentials.

## Builds

```powershell
npm run lint
npm run typecheck
npm run build
npm run package:win
```

Windows installer output is written to `artifacts/`.

For an internal PPMO test build, use `npm run package:win:internal`, then follow the [PPMO testing guide](docs/ppmo-testing.md) for checksum generation, clean-machine validation, and known limitations.

## Current status

The desktop shell, TypeScript Microsoft Graph connector, and Windows installer configuration are in place. The supported desktop path no longer requires Python. Remaining release work includes packaged redirect validation, signing, clean-machine installer testing, and update/rollback behavior.

See [docs/architecture.md](docs/architecture.md) for the target architecture and remaining work.
