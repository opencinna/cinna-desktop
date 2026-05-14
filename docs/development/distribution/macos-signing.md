# macOS Code Signing & Notarization

End-to-end guide for producing a signed, notarized DMG that macOS users can download and install without Gatekeeper warnings.

App identity:
- **App ID:** `io.opencinna.desktop`
- **Product name:** `Cinna Desktop`
- **Artifacts:** `dist/cinna-desktop-${version}-x64.dmg`, `dist/cinna-desktop-${version}-arm64.dmg`

## What "signable + distributable" actually means

Three independent things have to happen, in order:

1. **Code signing** — every binary inside the `.app` is signed with your Apple **Developer ID Application** certificate. Proves the app came from you and hasn't been tampered with.
2. **Notarization** — Apple scans your signed app for malware and returns a "ticket." Without this, macOS 10.15+ shows the "cannot be opened" dialog on first launch.
3. **Stapling** — the notarization ticket is attached to the DMG so Gatekeeper can verify offline. `electron-builder` does this automatically after a successful notarization.

`electron-builder` handles all three when the right credentials are present in your environment.

## One-time setup

### 1. Enroll in the Apple Developer Program

- Go to https://developer.apple.com/programs/ → Enroll (~$99/yr).
- Use an Apple ID dedicated to this purpose if possible (the same Apple ID is later used for notarization).
- Enrollment takes 24–48h to be approved.

### 2. Create the Developer ID Application certificate

Two ways. Pick **one**.

**Option A — Xcode (easiest, recommended):**
1. Install Xcode from the App Store.
2. Open Xcode → Settings → Accounts → add your Apple ID.
3. Select the team → Manage Certificates → `+` → **Developer ID Application**.
4. The cert + private key are installed into your login Keychain atomically — no chance of the cert/key mismatch you can hit with Option B.

**Option B — developer.apple.com (no Xcode):**

1. **Generate the CSR locally** (the `.certSigningRequest` file is generated on YOUR Mac — it's not a download):
   - Open **Keychain Access** (⌘+Space → "Keychain Access").
   - Top menu: **Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority…**
   - Fill in:
     - **User Email Address:** your Apple ID email
     - **Common Name:** your name (or product name like "Cinna Desktop")
     - **CA Email Address:** leave empty
     - **Request is:** select **Saved to disk** (NOT "Emailed to the CA")
   - Click **Continue** → save as `CertificateSigningRequest.certSigningRequest`.
   - **What happened:** Keychain generated an RSA key pair, kept the private key in your login Keychain, and wrote the public key + identity into the CSR file.

2. **Submit the CSR to Apple:**
   - https://developer.apple.com/account/resources/certificates → `+`
   - Pick **Developer ID Application** (NOT "Apple Development", "Mac Developer", or "Mac Installer" — those are different cert types and won't work for outside-the-App-Store distribution).
   - Upload the `.certSigningRequest` from step 1.
   - Download the resulting `.cer` file.

3. **Import the cert:**
   - Double-click the `.cer`. When asked which Keychain, pick **login**.

> ⚠️ **Critical:** the private key never leaves the Mac that generated the CSR. If you generated the CSR on Mac A and import the `.cer` on Mac B, the cert appears in Keychain but is useless — there's no matching key on Mac B. Either generate the CSR on the build machine, or export the resulting cert as a `.p12` (with password) from Mac A and import that `.p12` on Mac B.

### 3. Verify the signing identity works

```bash
security find-identity -v -p codesigning
# Expect a line like:
#   1) ABCD1234...  "Developer ID Application: Your Name (TEAMID123)"
#      1 valid identities found
```

Note the **Team ID** in parentheses — you'll need it for the env file.

**If you see `0 valid identities found`:**

This usually means *either* the private key is missing *or* the trust chain is broken. Diagnose:

```bash
# List identities including invalid ones
security find-identity -p codesigning
```

- **Identity not listed at all** → the cert isn't in your Keychain, or the private key is on a different Mac/user account. Re-import the `.cer` (into **login** Keychain) or regenerate the cert per Option B.
- **Identity is listed but as "invalid"** → trust chain problem. macOS can't link your cert up to a trusted Apple root because an intermediate cert is missing. See next section.

> Note: the "This certificate has not been verified by a third party" or red badge that Keychain Access shows on Developer ID certs is a known UI quirk and is usually **cosmetic** — what matters is whether `security find-identity -v -p codesigning` returns the identity as valid. Do NOT manually right-click → "Always Trust"; that actually breaks code signing.

### 3a. Install Apple's intermediate certs (if trust chain fails)

A fresh macOS install often doesn't have the **Developer ID Certification Authority (G2)** intermediate that signs current Developer ID certs. You need to install it (and the matching root) by hand.

1. Go to https://www.apple.com/certificateauthority/
2. Download:
   - **Developer ID - G2** (currently labeled e.g. "Expiring 09/17/2031") — the direct issuer of your cert.
   - **Apple Root CA - G2** (SHA-2) — the root.
3. Double-click each downloaded `.cer` → install into **login** Keychain.
4. Re-run `security find-identity -v -p codesigning` — should now show `1 valid identities found`.

**Real-world test case (Cinna Desktop, May 2026):** even with cert + private key paired correctly in Keychain Access, `find-identity -v` returned 0 identities until `Developer ID - G2 (Expiring 09/17/2031)` was installed. Installing just that one was enough.

### 4. Create an app-specific password for notarization

Notarization needs to authenticate as your Apple ID. Use an app-specific password (not your real password, not 2FA).

1. https://account.apple.com → Sign-In and Security → App-Specific Passwords → `+`.
2. Label it `cinna-desktop-notarize`.
3. Copy the password (`xxxx-xxxx-xxxx-xxxx`). You'll only see it once.

### 5. Store credentials locally

Create `~/.cinna-desktop-signing.env` (outside the repo, never commit):
```bash
export APPLE_ID="your-apple-id@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="TEAMID123"
# Optional: pin to a specific cert if you have multiple in Keychain
# export CSC_NAME="Developer ID Application: Your Name (TEAMID123)"
```

Lock it down:
```bash
chmod 600 ~/.cinna-desktop-signing.env
```

Source it before each build:
```bash
source ~/.cinna-desktop-signing.env
```

(If you'd rather not type that every time, add the `source` line to your `~/.zshrc` — but be aware those env vars then leak into every shell.)

## Building a signed + notarized DMG

```bash
source ~/.cinna-desktop-signing.env
npm run build:mac
```

This script (defined in `package.json`) runs `electron-vite build && electron-builder --mac` and, with the env vars present, will:
1. Compile main/preload/renderer.
2. Package the app for both `x64` and `arm64` (config in `electron-builder.yml`).
3. Sign every binary with your Developer ID cert.
4. Upload to Apple's notary service and wait (typically 2–10 min per arch).
5. Staple the notarization ticket onto the DMG.
6. Write artifacts to `dist/`.

First build will be the slowest because Apple notary needs the full upload; subsequent ones are quicker.

### Also notarize the DMG containers (post-build step)

`electron-builder` with `notarize: true` only notarizes the `.app` *inside* the DMG, not the outer DMG container. The app will work fine when dragged to /Applications (the inner `.app` has its stapled ticket), but for a clean download experience — and so `xcrun stapler validate <dmg>` passes — submit each DMG for notarization separately after the build:

```bash
source ~/.cinna-desktop-signing.env
npm run notarize:dmgs
```

The `notarize:dmgs` script (in `package.json`) loops over every `dist/cinna-desktop-*.dmg`, submits it to Apple notary with `--wait`, and staples the returned ticket. Each DMG submission takes ~2–5 min. Expect `status: Accepted` from notarytool, then `The staple and validate action worked!` from stapler.

> If you want a single command that does build + DMG-notarize in one go, run: `npm run build:mac && npm run notarize:dmgs`.

## Verifying the result

After the build, sanity-check before publishing:

```bash
# Signature is valid and chains to Apple root
codesign --verify --deep --strict --verbose=2 "dist/mac-arm64/Cinna Desktop.app"

# Gatekeeper would accept it
spctl -a -t exec -vvv "dist/mac-arm64/Cinna Desktop.app"
# Expect: source=Notarized Developer ID

# Ticket is stapled to the DMG
stapler validate dist/cinna-desktop-0.1.0-arm64.dmg
# Expect: The validate action worked!
```

End-to-end smoke test:
```bash
# Simulate downloading from the internet (sets the quarantine bit)
xattr -w com.apple.quarantine "0181;00000000;Safari;|com.apple.Safari" \
  dist/cinna-desktop-0.1.0-arm64.dmg

# Mount and open the app — should launch without any warning
open dist/cinna-desktop-0.1.0-arm64.dmg
```

If you see "cannot be opened because the developer cannot be verified," notarization didn't succeed — check the build log for the notary submission ID and run `xcrun notarytool log <submission-id> --apple-id ... --team-id ... --password ...`.

## Unsigned builds (development / personal use)

For local testing without certs:
```bash
npm run build:mac:unsigned
```

Users opening an unsigned DMG must right-click the app → Open → confirm, or run `xattr -d com.apple.quarantine /Applications/Cinna\ Desktop.app`.

## Distributing the DMG

Once you have signed+notarized DMGs in `dist/`:

- **GitHub Releases (recommended, configured)** — see "Releasing & auto-update" below. Free, automated, integrates with auto-update.
- **Object storage + download page** — host on S3/GCS/R2 and link from a landing page. Add a small JS sniff to auto-suggest the right arch. To use this path, switch `publish:` in `electron-builder.yml` to `provider: generic` with your URL.

## Releasing & auto-update

Auto-update is wired up via `electron-updater` (in `src/main/updater/updater.ts`) and `electron-builder`'s GitHub publish provider. The flow:

1. Bump the version in `package.json`.
2. Build + sign + notarize + upload to a GitHub Release in one shot.
3. Notarize the DMG containers.
4. Publish the GitHub Release (it's created as a draft).
5. Installed clients detect the new version and auto-update.

### One-time setup: GitHub token

`electron-builder --publish always` needs a GitHub Personal Access Token to upload assets.

1. https://github.com/settings/tokens (classic) → **Generate new token** → scope: `repo` (full).
2. Add to your signing env file:
   ```bash
   # ~/.cinna-desktop-signing.env
   export GH_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxx"
   ```

The repo (`opencinna/cinna-desktop`) is configured in `electron-builder.yml`'s `publish:` block.

### Release flow

```bash
source ~/.cinna-desktop-signing.env

# 1. Bump version (creates a commit + tag; npm refuses if tree is dirty)
npm version patch       # 0.1.0 -> 0.1.1; or `minor` / `major`

# 2. Build + sign + notarize .app + upload to GitHub draft release
npm run release:mac

# 3. Review the draft at https://github.com/opencinna/cinna-desktop/releases — edit the
#    title/body, add release notes, then publish:
gh release edit "v$(node -p "require('./package.json').version")" --draft=false

# 4. Push the version commit (the tag was already pushed by electron-builder when it
#    created the draft release):
git push
```

That's it. Once the draft is published, installed clients running an earlier version will detect the update within 6 hours (or on next launch) and prompt the user to restart.

> ⚠️ **Do NOT run `notarize:dmgs` between `release:mac` and publishing the draft.** electron-builder generates `latest-mac.yml` with the SHA512 of the unstapled DMG. Stapling changes the DMG bytes, breaking the hash. `electron-updater` would then reject the update with a hash-mismatch error. The `.app` *inside* the DMG IS stapled by `release:mac` — that's what Gatekeeper checks when the user launches the app, so this is enough.
>
> The `notarize:dmgs` script remains useful for non-auto-update channels (e.g., when you distribute the DMG via a download page and never publish a manifest).

### What gets published

For each release, GitHub Releases will hold:

- `cinna-desktop-${version}-x64.dmg` + `.blockmap`
- `cinna-desktop-${version}-arm64.dmg` + `.blockmap`
- `latest-mac.yml` — the manifest that `electron-updater` reads

The `.blockmap` files enable **differential downloads** — a user updating from 0.1.0 to 0.1.1 typically transfers ~5–20 MB instead of the full ~130 MB.

### How the in-app update works

`src/main/updater/updater.ts` runs `autoUpdater.checkForUpdates()`:
- On every app launch (after the main window is created).
- Every 6 hours while the app is running.

When an update is available, it auto-downloads in the background. When the download is complete, a native dialog asks the user "Restart now / Later". Choosing Later → the update installs silently when the app next quits (`autoInstallOnAppQuit: true`).

Auto-update only runs in production builds (`is.dev` guard) — `npm run dev` will never trigger it.

### Verifying auto-update works

After publishing release `0.1.1` while running `0.1.0`:

1. Launch the installed `0.1.0` app.
2. Open the in-app logs overlay (`Cmd+\``) and watch the `updater` scope:
   - `checking for update` → `update available: 0.1.1` → `download X.X%` → `update downloaded: 0.1.1 — prompting user`
3. The "Update ready" dialog appears.
4. Choose Restart → the app relaunches as `0.1.1`.

### Trust model

`electron-updater` verifies that each downloaded DMG is signed by the **same Developer ID** as the currently-running app. An attacker who compromises the GitHub Release cannot push a malicious update without your Developer ID private key. This is why auto-update requires code signing AND notarization (both of which we have).

## Troubleshooting

### Signing identity problems

| Symptom | Likely cause |
|---|---|
| `0 valid identities found` but cert IS visible in Keychain Access | Missing Apple intermediate cert. Install **Developer ID - G2** from https://www.apple.com/certificateauthority/. See section 3a. |
| `0 valid identities found` AND cert not listed by `find-identity -p codesigning` | Private key missing on this machine. Either the CSR was generated on another Mac, or the cert was imported without a paired key. Regenerate the CSR on THIS Mac. |
| Keychain Access shows "This certificate has not been verified by a third party" red badge | Cosmetic only. Trust the output of `security find-identity -v -p codesigning`. Do NOT manually set trust to "Always Trust" — that breaks signing. |
| `Error: No identity found` during build | `security find-identity -v -p codesigning` shows nothing → cert not installed, wrong Keychain, or chain incomplete. |

### Notarization problems

| Symptom | Likely cause |
|---|---|
| Build hangs at "notarizing" for >30 min | Notary service backlog. Check status at https://developer.apple.com/system-status/. |
| Notary returns `Invalid` | Run `xcrun notarytool log <submission-id> --apple-id ... --team-id ... --password ...` — usually a missing entitlement or an unsigned helper binary in `node_modules`. |
| App launches but crashes immediately when downloaded | Hardened runtime is on but an entitlement is missing. Edit `build/entitlements.mac.plist`. |
| `spctl` says "source=Unnotarized Developer ID" | Signing worked, notarization didn't — check env vars (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) are present in the build shell. |
| `xcrun stapler validate <dmg>` says "does not have a ticket stapled to it" but the `.app` inside is fine | electron-builder didn't submit the DMG for notarization (only the `.app`). Run the DMG-notarization loop in "Also notarize the DMG containers" above. |
| `xcrun stapler staple <dmg>` fails with "CloudKit query ... Record not found" | The DMG itself has never been submitted to Apple notary. You can't staple a ticket that doesn't exist — submit via `xcrun notarytool submit` first. |

### electron-builder packaging problems

| Symptom | Likely cause |
|---|---|
| `ENOENT: no such file or directory, rename '...Electron.app/Contents/MacOS/Electron' -> '...Cinna Desktop'` | Stale/corrupt Electron download in the electron-builder cache. Fix: see "Recovering from a failed build" below. |
| `npm error code ELSPROBLEMS / missing: @emnapi/...` warnings during packaging | **Cosmetic** — Tailwind v4's `@tailwindcss/oxide-wasm32-wasi` package declares optional sub-deps that npm doesn't install on macOS. Same for `lightningcss-*` platform binaries. These are non-fatal noise from electron-builder's `npm ls` scan. Ignore unless the build actually fails. |
| `duplicate dependency references` warnings | Cosmetic. Just npm tree quirks. |

### Recovering from a failed build

When in doubt, nuke the caches and try again. Order of escalation:

```bash
# 1. Wipe local build artifacts (cheap, always do this between attempts)
rm -rf dist out

# 2. Wipe electron-builder caches (fixes ENOENT rename / corrupt Electron binary)
rm -rf ~/Library/Caches/electron ~/Library/Caches/electron-builder

# 3. Repair node_modules (fixes ELSPROBLEMS / missing transitive optionals)
npm install

# 4. Retry
source ~/.cinna-desktop-signing.env
npm run build:mac
```

A clean re-run will redownload Electron (~120 MB per arch from GitHub Releases) — slow but reliable. Subsequent builds reuse the freshly-cached binaries.

## What changed in this repo

- `electron-builder.yml`:
  - `appId: io.opencinna.desktop`, `productName: Cinna Desktop`
  - `mac.hardenedRuntime: true`, `mac.notarize: true`
  - `mac.target: dmg [x64, arm64]` — dual-arch builds
  - `dmg.artifactName` includes `${arch}` so x64/arm64 artifacts don't collide
- `package.json`:
  - `author`, `homepage` populated (electron-builder uses these for app metadata / copyright)
  - `build:mac` script: `electron-vite build && electron-builder --mac`
  - `build:mac:unsigned` script: same but with `-c.mac.identity=null -c.mac.notarize=false` for local testing without certs
  - `notarize:dmgs` script: loops over `dist/cinna-desktop-*.dmg` and runs `notarytool submit --wait` + `stapler staple` on each. Needs `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` env vars sourced first. **Do not use this in the auto-update release flow** — see warning in "Release flow".
  - `release:mac` script: build + sign + notarize + upload to GitHub Releases (draft). Needs `GH_TOKEN` in addition to the Apple env vars.
  - Added runtime dep `electron-updater`.
- `src/main/updater/updater.ts`: auto-update wire-up. Checks on launch + every 6h, prompts user on `update-downloaded`, installs on quit.
- `src/main/index.ts`: calls `initAutoUpdater()` after `createWindow()`.
- `build/entitlements.mac.plist`: unchanged — current entitlements (JIT, unsigned exec memory, dyld env vars) are correct for Electron + hardened runtime.
