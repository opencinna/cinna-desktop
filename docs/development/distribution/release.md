# Release & Distribution

End-to-end guide for cutting a Cinna Desktop release: macOS code signing + notarization, Linux packaging via GitHub Actions, GitHub Releases upload, and in-app auto-update via `electron-updater`.

App identity:
- **App ID:** `io.opencinna.desktop`
- **Product name:** `Cinna Desktop`
- **Release artifacts per version:**
  - **macOS:** `cinna-desktop-${version}-x64.dmg` + `cinna-desktop-${version}-arm64.dmg` (user downloads), `cinna-desktop-${version}-x64-mac.zip` + `cinna-desktop-${version}-arm64-mac.zip` (auto-update payload, mandatory — see below), `.blockmap` files for each, + `latest-mac.yml`
  - **Linux:** `cinna-desktop-${version}-x64.AppImage`, `cinna-desktop-${version}-x64.deb`, + `latest-linux.yml`
- **Channels:**
  - macOS: signed + notarized, auto-updates via `electron-updater`.
  - Linux AppImage: auto-updates via `electron-updater`.
  - Linux `.deb`: manual reinstall (apt-driven channel, no in-app update).

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

Auto-update is wired up via `electron-updater` (in `src/main/updater/updater.ts`) and `electron-builder`'s GitHub publish provider. Each release goes through the same 7-step runbook below.

At a glance:
1. **Pre-flight** — clean tree on `main`, typecheck/build/dev sanity-checks pass.
2. **Bump version** — `npm version patch|minor|major` commits + tags.
3. **Build, sign, notarize, upload** — `npm run release:mac` produces a GitHub **draft** release with both DMGs + manifest.
4. **Verify the draft** — `gh release view`, optional download-and-launch smoke test.
5. **(Optional) Test auto-update** before users see it.
6. **Write notes & publish** — `gh release edit ... --draft=false`.
7. **Push** the version-bump commit. Pushing the tag also triggers...
8. **Linux build (automated)** — GitHub Actions runs on `ubuntu-latest`, appends `.AppImage` + `.deb` to the same release.

### One-time setup: GitHub token

`electron-builder --publish always` needs a GitHub Personal Access Token to upload assets.

1. https://github.com/settings/tokens (classic) → **Generate new token** → scope: `repo` (full).
2. Add to your signing env file:
   ```bash
   # ~/.cinna-desktop-signing.env
   export GH_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxx"
   ```

The repo (`opencinna/cinna-desktop`) is configured in `electron-builder.yml`'s `publish:` block.

### Release runbook

Step-by-step for cutting a new release. The whole flow takes ~20–30 min on a clean machine (most of it Apple's notary service).

#### 1. Pre-flight checks

```bash
# On main, clean tree, up to date with origin
git checkout main
git pull
git status               # should show: clean
git diff origin/main     # should be empty

# Build + typecheck succeed (release:mac runs this, but fail fast here)
npm install
npm run typecheck
npx electron-vite build

# Sanity-run the dev build to make sure the app still launches
npm run dev              # Ctrl+C once the window opens cleanly
```

If anything fails, fix it on `main` before continuing — every release tag is a permanent reference point.

#### 2. Pick the version bump

```bash
# Bug fixes only:
npm version patch        # 0.1.1 -> 0.1.2

# New features, backwards-compatible:
npm version minor        # 0.1.1 -> 0.2.0

# Breaking changes (rare):
npm version major        # 0.1.1 -> 1.0.0
```

`npm version` updates `package.json`, creates a commit, and tags it (`vX.Y.Z`). It **refuses if the tree is dirty** — see Recovery below if you hit this.

#### 3. Build, sign, notarize, upload

```bash
source ~/.cinna-desktop-signing.env
npm run release:mac
```

This single command:
- Compiles main/preload/renderer.
- Packages `.app` bundles for `x64` and `arm64`.
- Signs everything with the Developer ID cert.
- Submits each `.app` to Apple notary and **waits** for `Accepted` (2–10 min per arch).
- Staples the notarization ticket onto the `.app`.
- Builds DMGs containing the stapled `.app`s.
- Generates blockmaps (for differential auto-update).
- Generates `latest-mac.yml` (the auto-update manifest).
- Uploads everything to a **draft GitHub Release** at `v${version}` (created automatically; the tag is pushed by electron-builder at this point).

Watch the log for `notarization successful` (twice — once per arch) and final `uploading ... provider=github` lines for each artifact.

**As soon as the tag lands on GitHub (during step 3), `.github/workflows/release-linux.yml` triggers and starts building Linux artifacts on `ubuntu-latest` in parallel.** Check it at https://github.com/opencinna/cinna-desktop/actions. Wait for it to finish (5–8 min) before publishing the draft in step 6, so the released version includes Linux too. See step 8 for details.

#### 4. Verify the draft on GitHub

```bash
VERSION="v$(node -p "require('./package.json').version")"

# Confirm the draft exists with all expected assets
gh release view "$VERSION" --repo opencinna/cinna-desktop

# Expected assets (macOS):
#   cinna-desktop-${V}-arm64.dmg            (+ .blockmap)
#   cinna-desktop-${V}-x64.dmg              (+ .blockmap)
#   cinna-desktop-${V}-arm64-mac.zip        (+ .blockmap)  ← mandatory for auto-update
#   cinna-desktop-${V}-x64-mac.zip          (+ .blockmap)  ← mandatory for auto-update
#   latest-mac.yml                          (must list the .zip URLs in `files:`)
#
# Expected assets (Linux, added by CI ~5-8 min after tag push):
#   cinna-desktop-${V}-x64.AppImage
#   cinna-desktop-${V}-x64.deb
#   latest-linux.yml

# Sanity-check latest-mac.yml lists ZIPs (electron-updater will throw
# "ZIP file not provided" on the client side if it only sees DMGs):
gh release download "$VERSION" --repo opencinna/cinna-desktop --pattern "latest-mac.yml" --clobber
grep -q '\.zip$' latest-mac.yml || echo "WARNING: latest-mac.yml has no zip entries — auto-update will fail"
```

> If `gh release view` shows `draft: false`, electron-builder published immediately. Check `electron-builder.yml`'s `publish.releaseType` — it should be `draft`.

Optional sanity-check the downloaded artifact end-to-end:
```bash
mkdir -p /tmp/release-test && cd /tmp/release-test
gh release download "$VERSION" --repo opencinna/cinna-desktop --pattern "*arm64.dmg"
# Simulate a download from the internet (sets the quarantine bit)
xattr -w com.apple.quarantine "0181;00000000;Safari;|com.apple.Safari" \
  cinna-desktop-*-arm64.dmg
open cinna-desktop-*-arm64.dmg
# Drag the .app to /Applications, launch it — should open with no Gatekeeper warning.
cd -
```

#### 5. Test auto-update BEFORE publishing the draft (recommended)

The draft is invisible to `electron-updater`, so existing installs won't try to pull it until you publish. To preview the upgrade path safely:

1. Temporarily flip the draft to a public release: `gh release edit "$VERSION" --draft=false --repo opencinna/cinna-desktop`
2. Launch a previous-version install of Cinna Desktop.
3. Open the in-app logs overlay (`Cmd+\``) → filter for scope `updater`.
4. Watch for: `checking for update` → `update available: ${version}` → `download X%` → `update downloaded`.
5. Confirm the "Update ready" dialog and the relaunch.

If something's wrong, immediately flip back to draft (`--draft=true`) — installed clients that already saw the public release will continue, but new ones won't.

For a typical patch release where you're confident, you can skip this step.

#### 6. Write release notes and publish

```bash
# Pull commits since the previous tag, format them, and use gh to set the body:
PREV_TAG=$(gh release list --repo opencinna/cinna-desktop --limit 2 --json tagName --jq '.[1].tagName')
NOTES=$(git log --pretty="- %s" "$PREV_TAG..HEAD" -- . ':!docs/' ':!**/CLAUDE.md')

gh release edit "$VERSION" --repo opencinna/cinna-desktop \
  --notes "$NOTES" \
  --draft=false
```

Or edit notes in the GitHub web UI: https://github.com/opencinna/cinna-desktop/releases → click the draft → write notes → Publish release.

#### 7. Push the version commit

The tag was pushed by electron-builder in step 3, but the version-bump commit on `main` is still local:

```bash
git push
```

Done. Installed clients on a previous version will pick up the new release on next launch or within 6 hours of running.

#### 8. Linux artifacts (automated via GitHub Actions)

When you push the `v*` tag in step 3, the workflow `.github/workflows/release-linux.yml` triggers automatically on `ubuntu-latest` and:

- Runs `npm ci` (which installs `linux-x64` native binaries for `better-sqlite3` and friends).
- Runs `npm run release:linux` — builds `.AppImage` and `.deb`, plus `latest-linux.yml` for auto-update.
- Uploads them to the **same draft release** the macOS build created.

Watch progress at https://github.com/opencinna/cinna-desktop/actions. Typical runtime: 5–8 min.

If you need to re-run the Linux build for an existing tag (e.g. CI flaked, or the tag predates the workflow), trigger it manually. The `ref` input is optional — defaults to `main`:

```bash
# Build from the latest main
gh workflow run release-linux.yml --repo opencinna/cinna-desktop

# Or build from a specific tag (must contain the release:linux script — v0.1.3+)
gh workflow run release-linux.yml --repo opencinna/cinna-desktop -f ref=v0.1.3
```

After Linux finishes uploading, the draft will contain both macOS and Linux assets — that's the right moment to write release notes and publish (step 6).

> **Linux auto-update caveats**
> - **AppImage**: `electron-updater` works fully. The downloaded AppImage replaces the running one in-place via the `APPIMAGE` env var. Users must run from the AppImage (not extract it).
> - **deb**: NO auto-update — `electron-updater` doesn't drive `apt`. `.deb` users have to install new versions manually. Document this on the download page if you ship `.deb`.

---

> ⚠️ **Do NOT run `notarize:dmgs` between `release:mac` and publishing the draft.** electron-builder generates `latest-mac.yml` with the SHA512 of the un-DMG-stapled DMG. Stapling the DMG container changes its bytes, breaking the hash. `electron-updater` would then reject the update with a hash-mismatch error. The `.app` *inside* the DMG IS stapled by `release:mac` — that's what Gatekeeper checks when the user launches the app.
>
> The `notarize:dmgs` script remains useful for non-auto-update channels (e.g., when you distribute the DMG via a separate download page and never publish a manifest).

### Recovery: things that can go wrong

**`npm version` refuses with "working directory not clean"**

```bash
# Stash whatever's lying around
git stash
npm version <bump>
git stash pop   # bring it back after
```

Or: commit the work-in-progress, *then* run `npm version`.

**`release:mac` failed partway through, leaving a half-uploaded GitHub release**

```bash
VERSION="v$(node -p "require('./package.json').version")"
# Delete the draft and the tag, fix the issue, rerun release:mac
gh release delete "$VERSION" --repo opencinna/cinna-desktop --yes --cleanup-tag
git tag -d "$VERSION"
# Optional: rollback the version-bump commit if you also want to retry with a fresh bump
git reset --hard HEAD~1
```

After fixing the cause, restart from step 2.

**Released a broken version that's auto-updating users**

Don't unpublish — `electron-updater` clients that already saw the manifest may already be downloading it, and a missing release URL produces error logs rather than a rollback.

Instead, **ship a hotfix immediately**:
1. Fix the bug on `main`.
2. `npm version patch` (e.g. `0.2.0` → `0.2.1`).
3. Run the full release flow.
4. Clients on the broken `0.2.0` will pick up `0.2.1` on their next check.

For a truly catastrophic release (won't launch at all → can't run auto-update from inside the broken app), you'd need to publish a download-page message asking users to manually reinstall. Worth keeping a small static landing page that links to the latest release as a fallback.

**Lost `~/.cinna-desktop-signing.env` (machine reformat / new dev machine)**

You need:
- The Developer ID Application cert + private key. If you exported a `.p12` backup, restore it via Keychain Access. If not, revoke the old cert and follow section 2 to issue a new one.
- The Apple ID, app-specific password (regenerate at https://account.apple.com), and Team ID.
- A GitHub PAT with `repo` scope.

Recreate the env file from section 5.

**Linux GitHub Actions build failed**

The macOS draft is already on GitHub but Linux assets are missing. Inspect the run:

```bash
gh run list --repo opencinna/cinna-desktop --workflow=release-linux.yml --limit 5
gh run view <run-id> --repo opencinna/cinna-desktop --log-failed
```

Common causes:
- **`npm error Missing script: release:linux`** — the tag predates the script being added. Either dispatch the workflow with `-f ref=main` (uses current main) or skip Linux for that release.
- **`startup_failure` with no steps**: usually a transient GitHub Actions issue. Re-dispatch the workflow.
- **`electron-builder` upload fails with 422 Validation Failed**: the asset already exists in the release. Delete it from the GH Releases page or `gh release delete-asset` first, then re-dispatch.
- **`better-sqlite3` build error** during `npm ci`: a native dep changed and no linux prebuild exists yet. Pin to the previous version of the offending dep or wait for an upstream prebuild.

Re-trigger after fixing:
```bash
gh workflow run release-linux.yml --repo opencinna/cinna-desktop -f ref=v0.1.X
```

### What gets published

For each release, GitHub Releases will hold:

**macOS** (uploaded by local `npm run release:mac`):
- `cinna-desktop-${version}-x64.dmg` + `.blockmap`
- `cinna-desktop-${version}-arm64.dmg` + `.blockmap`
- `latest-mac.yml` — auto-update manifest for `electron-updater`

**Linux** (uploaded by the `release-linux.yml` GitHub Actions workflow):
- `cinna-desktop-${version}-x64.AppImage`
- `cinna-desktop-${version}-x64.deb`
- `latest-linux.yml` — auto-update manifest (only AppImage uses it)

The `.blockmap` files (macOS only currently) enable **differential downloads** — a user updating from 0.1.0 to 0.1.1 typically transfers ~5–20 MB instead of the full ~130 MB. Linux AppImage updates download the full new AppImage.

### How the in-app update works

`src/main/updater/updater.ts` runs `autoUpdater.checkForUpdates()`:
- On every app launch (after the main window is created).
- Every 6 hours while the app is running.

When an update is available, it auto-downloads in the background. When the download is complete, a native dialog asks the user "Restart now / Later". Choosing Later → the update installs silently when the app next quits (`autoInstallOnAppQuit: true`).

Auto-update only runs in production builds (`is.dev` guard) — `npm run dev` will never trigger it.

**Platform behavior:**
- **macOS:** `electron-updater` reads `latest-mac.yml`, downloads the matching `.dmg` (with blockmap-driven differential download), verifies code signature against the running app's Developer ID, and applies on quit.
- **Linux AppImage:** `electron-updater` reads `latest-linux.yml`, downloads the new AppImage, verifies sha512, and replaces the running AppImage in-place using the `APPIMAGE` env var that AppImage sets at launch. Requires the user to actually run the `.AppImage` (not extracted).
- **Linux deb:** no auto-update. The `.deb` is a one-time install via `apt`; users get new versions by manually re-downloading.

### Verifying auto-update works

After publishing release `0.1.1` while running `0.1.0`:

1. Launch the installed `0.1.0` app.
2. Open the in-app logs overlay (`Cmd+\``) and watch the `updater` scope:
   - `checking for update` → `update available: 0.1.1` → `download X.X%` → `update downloaded: 0.1.1 — prompting user`
3. The "Update ready" dialog appears.
4. Choose Restart → the app relaunches as `0.1.1`.

### Trust model

- **macOS:** `electron-updater` verifies each downloaded DMG is signed by the **same Developer ID** as the currently-running app. An attacker who compromises the GitHub Release cannot push a malicious update without your Developer ID private key. This is why macOS auto-update requires code signing AND notarization (both of which we have).
- **Linux AppImage:** verified via SHA-512 hash in `latest-linux.yml`. No OS-level code signing — the trust anchor is HTTPS + the integrity of GitHub Releases. An attacker who gained write access to the release could push a malicious AppImage; the user's only defense is checksum-on-publish.
- **GitHub Actions builds (Linux):** the workflow uses `${{ secrets.GITHUB_TOKEN }}`, which is scoped to the repo and rotated per run. Compromise surface is the repo's collaborator set + Actions secrets.

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
  - `mac.target: [dmg, zip] x [x64, arm64]` — DMG for user downloads, ZIP for `electron-updater`. **The ZIP is mandatory:** without it `MacUpdater` throws `ZIP file not provided` on every check and auto-update breaks for all existing installs. `latest-mac.yml` must list the `.zip` URLs.
  - `dmg.artifactName` includes `${arch}` so x64/arm64 artifacts don't collide
  - `linux.target: [AppImage, deb] x64` — Linux packaging (x64 only for now)
  - `appImage.artifactName` / `deb.artifactName` include `${arch}` and `${ext}`
  - `publish: github (owner: opencinna, repo: cinna-desktop, releaseType: draft)` — uploads go to a draft release for review
- `package.json`:
  - `author`, `homepage`, `description` populated (electron-builder uses these for app metadata / copyright / linux package metadata)
  - `build:mac`, `build:mac:unsigned` — local macOS builds (no upload)
  - `notarize:dmgs` — standalone DMG notarization (NOT for auto-update release flow)
  - `release:mac` — local macOS build + sign + notarize + upload draft. Needs Apple env vars + `GH_TOKEN`.
  - `release:linux` — Linux AppImage + deb build + upload draft. Designed for CI; can also run locally on Linux/Docker.
  - `release:all` — both platforms in one invocation (only useful from a Linux box with Apple secrets).
  - Added runtime dep `electron-updater`.
- `src/main/updater/updater.ts`: auto-update wire-up. Checks on launch + every 6h, prompts user on `update-downloaded`, installs on quit. Dev-mode guard via `is.dev`.
- `src/main/index.ts`: calls `initAutoUpdater()` after `createWindow()`. Loads dock icon from `resources/cinna-desktop-icon.png`.
- `.github/workflows/release-linux.yml`: triggers on `v*` tag push or manual dispatch. Runs on `ubuntu-latest`, calls `npm run release:linux` with the auto-provided `GITHUB_TOKEN`. Appends Linux assets to the same draft release the macOS build created.
- `build/entitlements.mac.plist`: unchanged — current entitlements (JIT, unsigned exec memory, dyld env vars) are correct for Electron + hardened runtime.
