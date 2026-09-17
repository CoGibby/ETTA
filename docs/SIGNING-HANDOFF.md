# ETTA macOS Signing Handoff

Signed `v1.0.0` (developer/signing cut: tag `macos-signing-v1.0.0` on the UCSD Bitbucket repo).
This is a checklist for the person who holds the UCSD Apple Developer **Developer ID** certificate
and will sign + notarize the ETTA macOS build on a Mac. Only the macOS signing steps live here,
because they are machine-dependent (a Mac is required) and the certificate must stay out of CI and
out of any public or personal GitHub.

## 1. What you need
- A **macOS** machine (Intel or Apple Silicon is fine — we produce both arm64 and x64).
- The **Apple Developer ID Application** certificate for UC San Diego in **Keychain**
  (or a `.p12` + its password to import once). This is what signs the app.
- Notarization credentials, either:
  - an **App Store Connect API Key** (`.p8`), its **Key ID**, and **Issuer ID**, plus the **Team ID**, or
  - an Apple ID + an **app-specific password** and the same **Team ID**.
- `git`, **Node.js 22**, and `npm`.

## 2. Get the code (signing cut)
```bash
git clone https://sourcecode.ucsd.edu/scm/ai/time-tracker.git
cd time-tracker
git fetch --tags
git checkout macos-signing-v1.0.0
npm ci
```

The signing config is already in the repo (`electron-builder.json` sets hardened runtime and
notarization on for the `mac` target; `package.json` version is `1.0.0`).

## 3. Set credentials for this one run (env vars)
Import/confirm the certificate in Keychain (no file needs to leave the machine). For notarization,
set these env vars for the build shell only — do not write them into files:

```bash
# Certificate: only if signing from a .p12 (skip if it is already in Keychain)
export CSC_LINK="/path/to/ucsd-developer-id.p12"
export CSC_KEY_PASSWORD="..."

# Notarization — App Store Connect API key (recommended) OR Apple ID + app-specific password
export APPLE_API_KEY="$(base64 < /path/to/AuthKey_XXXXXX.p8 | tr -d '\n')"
export APPLE_API_KEY_ID="XXXXXX"
export APPLE_API_ISSUER="00000000-0000-0000-0000-000000000000"
export APPLE_TEAM_ID="...UC San Diego team id..."

# alternate (Apple ID):
# export APPLE_ID="someone@ucsd.edu"
# export APPLE_APP_SPECIFIC_PASSWORD="..."
```

Do **not** commit these values, and do **not** place them on a public channel or a personal GitHub.

## 4. Build, sign, and notarize
```bash
npm run package:mac
```
electron-builder signs the arm64 + x64 apps with the Developer ID identity (picked from Keychain
or `CSC_LINK`, enables hardened runtime, and notarizes using the API key), then produces:

- `artifacts/ETTA-Time-Tracker-1.0.0-arm64.dmg` and `...-x64.dmg`
- `artifacts/ETTA-Time-Tracker-1.0.0-arm64.zip` and `...-x64.zip` (the auto-update payload)
- `artifacts/latest-mac.yml` (the update feed manifest)

## 5. Verify before handing back
```bash
codesign --verify --deep --strict "ETTA Time Tracker.app"
spctl -a -vv -t execute "ETTA Time Tracker.app"
```
Expected: the app is signed by a Developer ID and `spctl` reports **accepted** / **source=Developer Id**
/ **notarized**. Also confirm both archs (`lipo -archs ...` inside each `.app`).

## 6. What to send back
- `ETTA-Time-Tracker-1.0.0-{arm64,x64}.dmg`
- `ETTA-Time-Tracker-1.0.0-{arm64,x64}.zip`
- `latest-mac.yml`
- The `codesign`/`spctl` output snippet for the record.

Return these over a **secure/UCSD-approved channel** (encrypted archive + checksums is fine).

## Notes / guardrails
- The `.app` on disk and the `.zip` are separate; the `.dmg` is for first install, the `.zip` powers
  future in-place updates.
- If notarization shows `Could not contact notary services`, re-run after confirming the API key
  and network.
- Never store the `.p12`, `CSC_LINK`, or notarization credentials in the repo.