# Auto-Update

## Purpose

In-app auto-update for shipped builds: detects new releases from GitHub, downloads them in the background, surfaces a passive status indicator in the sidebar footer, and prompts the user to restart and install — without leaving the app. Wraps `electron-updater` and exposes a stateful UI affordance so users always know whether an update is pending, in flight, or ready.

## Core Concepts

- **Updater Phase** — A three-state machine that the main process publishes and every renderer mirrors: `idle` (nothing to show), `downloading` (an update is being fetched, progress is broadcast), `downloaded` (an update sits on disk waiting for the next launch). The phase is process-global, not per-user.
- **Auto-Download** — `electron-updater` is configured with `autoDownload: true`, so detection and download are a single continuous flow. The renderer never sees a separate "available" state — it goes straight to `downloading` with `percent: 0`.
- **Auto-Install-On-Quit** — `autoInstallOnAppQuit: true`. If the user dismisses the restart prompt, the queued update installs silently the next time they quit Cinna Desktop.
- **Manual Check** — User-initiated update check via the macOS app menu ("Check for Updates…"). Always shows a dialog with the outcome (downloading / up to date / error), unlike the periodic background check which is silent.
- **Restart Prompt** — A native dialog ("Restart now / Later") shown once when a download completes, and re-shown on demand when the user clicks the footer indicator.

## User Stories / Flows

### Background update flow (the default)
1. App launches in production build → updater configured → `checkForUpdates()` fires immediately and again every 6 hours
2. A newer GitHub release is detected → state transitions to `downloading` → the `Download` icon appears in the sidebar footer with a circular progress ring
3. As bytes arrive, the ring fills 0–100% (clockwise from 12 o'clock); the tooltip shows the version and percent
4. Download completes → state transitions to `downloaded`; the ring is replaced by a pulsing green dot
5. The native "Update ready — Restart now / Later" dialog opens automatically once
6. User clicks **Restart now** → `autoUpdater.quitAndInstall()` → app relaunches as the new version
7. If the user clicked **Later**, the green-dot icon stays in the footer. They can click it any time to re-open the same dialog. Otherwise the update installs the next time they quit the app

### Manual check via the macOS menu
1. User opens **Cinna Desktop → Check for Updates…**
2. Main process triggers `autoUpdater.checkForUpdates()` and awaits the result
3. Three possible outcomes, each shown as its own dialog:
   - **Update available** — "Cinna Desktop X.Y.Z is downloading. You'll be prompted to restart once the download completes." (The background download proceeds; the footer indicator turns on.)
   - **Already downloaded** — Re-opens the "Restart now / Later" prompt directly (no redundant "you're up to date")
   - **Up to date** — "Cinna Desktop X.Y.Z is the latest version."
4. On failure (network, signature, no release found): an error dialog with the underlying message

### Dev-mode behavior
1. Running `npm run dev` → `is.dev` is true → auto-updater is **not** configured, no periodic checks, no broadcasts
2. The manual menu item still works but shows a single dialog: "Auto-update is disabled in development builds."
3. The footer indicator stays hidden (phase remains `idle`)

## Business Rules

- The footer indicator renders nothing when `phase === 'idle'` — it is invisible to users who don't have a pending update
- State transitions are one-way during a download: once `downloaded`, a subsequent `update-available` event for the same version is ignored so the progress ring doesn't reset to 0% on the next 6-hour poll
- `update-not-available` does **not** revert `downloaded` → `idle`. A queued update stays queued regardless of subsequent checks
- The auto-prompt dialog fires **once** when a download completes. Clicking the footer indicator afterwards re-opens the *same* dialog (same code path), so behavior is consistent whether the user reacts immediately or returns later
- Errors are logged to the `updater` scope but **not** surfaced in the footer — a failed check doesn't change the visible phase. The user only sees an error if they explicitly triggered a manual check
- The macOS menu item is always enabled in production builds (no debounce). `electron-updater` handles concurrent `checkForUpdates()` calls internally
- Auto-update only runs in **production builds**. The `is.dev` guard short-circuits before any updater event listeners are attached
- Updates are **only** delivered through GitHub Releases for macOS (signed DMG + ZIP) and AppImage. The `.deb` channel has no auto-update — those users get new versions by re-installing manually (see [Release & Distribution](../distribution/release.md))

## Architecture Overview

```
electron-updater (main)
  -> 'update-available' / 'download-progress' / 'update-downloaded' events
  -> setState(UpdaterState) -> cache + broadcast 'updater:state' to all BrowserWindows

Renderer (Zustand updater.store)
  -> on mount: window.api.updater.getState() to hydrate
  -> window.api.updater.onState((state) => set({ state })) to subscribe
  -> store powers <UpdateStatusButton /> in sidebar footer

User clicks indicator (downloaded phase)
  -> updater.store.promptInstall()
  -> ipc 'updater:prompt-install'
  -> main promptInstallCurrent() -> native dialog -> autoUpdater.quitAndInstall()

macOS menu "Check for Updates…"
  -> checkForUpdatesManual() in main
  -> autoUpdater.checkForUpdates() + appropriate dialog
```

## Integration Points

- **Release & Distribution** — Ships the artifacts the updater consumes. The `electron-builder.yml` `mac.target` must include **both** `dmg` and `zip` — `electron-updater` requires the ZIP payload; without it `MacUpdater` throws `ZIP file not provided` on every check. See [Release & Distribution](../distribution/release.md)
- **App Shell** — `UpdateStatusButton` mounts in the sidebar footer (right of `AgentStatusButton`, left of `InterfaceMenu`). See [App Shell](../../ui/app_shell/app_shell.md)
- **Logger** — All updater events are logged under the `updater` scope: check lifecycle, download progress (debug), errors, manual-check requests. Surfaced via the in-app logs overlay. See [Logger](../logger/logger.md)
- **Menu accelerator** — The "Check for Updates…" item lives in the explicit `appMenu` template in `src/main/index.ts`, replacing the default `role: 'appMenu'` so the item can be inserted right after "About"
