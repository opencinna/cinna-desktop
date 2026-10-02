# Auto-Update

## Purpose

In-app auto-update for shipped builds: detects new releases from GitHub, downloads them in the background, surfaces a passive status indicator in the sidebar footer (and, once the update is ready, in the top bar whenever the sidebar is out of view), and installs either when the user clicks it or on the next quit — without leaving the app and without interrupting them. Wraps `electron-updater` and exposes a stateful UI affordance so users always know whether an update is pending, in flight, or ready.

## Core Concepts

- **Updater Phase** — A three-state machine that the main process publishes and every renderer mirrors: `idle` (nothing to show), `downloading` (an update is being fetched, progress is broadcast), `downloaded` (an update sits on disk waiting for the next launch). The phase is process-global, not per-user.
- **Auto-Download** — `electron-updater` is configured with `autoDownload: true`, so detection and download are a single continuous flow. The renderer never sees a separate "available" state — it goes straight to `downloading` with `percent: 0`.
- **Auto-Install-On-Quit** — `autoInstallOnAppQuit: true`. A downloaded update that the user never acts on — never clicks the badge, or answers **Later** — installs silently the next time they quit Cinna Desktop. This is what makes it safe for a finished download to ask nothing.
- **Manual Check** — User-initiated update check via the macOS app menu ("Check for Updates…"). Always shows a dialog with the outcome (downloading / up to date / error), unlike the periodic background check which is silent.
- **Restart Prompt** — A native dialog ("Restart now / Later") shown only when the user asks for it: by clicking the ready badge, or by a manual check that finds the update already downloaded. It never opens on its own when a download finishes.
- **Ready Badge** — The `downloaded` form of the indicator: the download icon with a pulsing green dot. It lives in the sidebar footer, and a second copy appears in the top bar whenever the sidebar is out of view (collapsed in Fixed docking, not peeking in On Hover docking). The download-progress ring is footer-only.
- **Updater Sheet** — Every updater dialog is attached to the main window as a sheet rather than shown parentless. See the business rule below for why this is not cosmetic.

## User Stories / Flows

### Background update flow (the default)
1. App launches in production build → updater configured → `checkForUpdates()` fires immediately and again every 6 hours
2. A newer GitHub release is detected → state transitions to `downloading` → the `Download` icon appears in the sidebar footer with a circular progress ring
3. As bytes arrive, the ring fills 0–100% (clockwise from 12 o'clock); the tooltip shows the version and percent
4. Download completes → state transitions to `downloaded`; the ring is replaced by a pulsing green dot. **Nothing else happens** — no dialog, no notification
5. If the sidebar is collapsed (or hidden in On Hover docking), the same ready badge also appears at the right edge of the top bar (before a chat's "From job" pill, when there is one), so a finished download is never invisible
6. Whenever the user chooses, they click either badge → the "Update ready — Restart now / Later" dialog opens as a sheet on the main window
7. **Restart now** → `autoUpdater.quitAndInstall()` → app relaunches as the new version. **Later** → the badge stays; the update installs the next time they quit the app, whether or not they ever click it again

### Manual check via the macOS menu
1. User opens **Cinna Desktop → Check for Updates…**
2. Main process triggers `autoUpdater.checkForUpdates()` and awaits the result
3. Three possible outcomes, each shown as its own dialog, attached to the main window as a sheet (a hidden or minimized window is brought up first):
   - **Update available** — "Cinna Desktop X.Y.Z is downloading." (The background download proceeds; the footer indicator turns on, and the ready badge replaces it when the download finishes — no prompt follows on its own. The dialog's detail line points the user at that badge.)
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
- **A finished download opens nothing.** The user did not ask for a dialog, and a background download usually finishes while they are doing something else — often right after the laptop wakes. The badge carries the news and `autoInstallOnAppQuit` guarantees the install, so a prompt adds interruption and no capability. Up to 0.5.3 the download handler opened the restart prompt itself, parentless; in 0.5.2 it appeared behind other apps' windows after a wake and froze the app (next rule). Do not reintroduce an automatic prompt
- **Every updater dialog is a sheet on the main window, never parentless.** On macOS, Electron shows a parentless message box with `runModal` — an app-modal panel that blocks every Cinna window and even Quit. Raised while Cinna is in the background, it orders *beneath* the active app's windows, so Cinna ignores every click with nothing on screen to explain why; this is the 0.5.2 freeze. A sheet is drawn on the window itself and cannot end up behind it. Electron also falls back to `runModal` when the parent is hidden, so a hidden or minimized main window is shown and raised before the sheet attaches. This covers the restart prompt and all four manual-check outcomes (dev notice, downloading, up to date, error) as well as the "No update is ready to install yet" notice. On macOS closing the window leaves the app running with none, and Check for Updates… can still be picked from the menu; the window is then reopened and the sheet attaches once it shows. A parentless box remains only if no window can be opened
- **No system notification for a ready update, by design.** A notification would cost a macOS permission prompt for a feature that does not need one, and the bare-Mac acceptance run fails on any system dialog the app raises (see [Bare-Mac Tests](../bare_mac/bare_mac.md)). The badge is the whole announcement
- **The ready badge is never invisible.** The sidebar footer carries it while the sidebar shows; when the sidebar is out of view a copy appears in the top bar. In 0.5.2 a collapsed sidebar hid the only badge, so the user had no way to know an update was waiting. Only the `downloaded` phase moves up: the progress ring is passive information and stays in the footer, because the top bar holds controls, not a progress readout
- The restart prompt is the same code path from either badge and from the manual check, so behaviour is consistent whether the user reacts immediately or returns later
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
  -> first mount of any button claims the subscription (once, even with two mounted)
  -> window.api.updater.onState((state) => set({ state })), then getState() to hydrate
  -> store powers <UpdateStatusButton /> in the sidebar footer
     and <UpdateStatusButton readyOnly /> in the TopBar while the sidebar is out of view

User clicks indicator (downloaded phase)
  -> updater.store.promptInstall()
  -> ipc 'updater:prompt-install'
  -> main promptInstallCurrent() -> sheet on main window -> autoUpdater.quitAndInstall()

macOS menu "Check for Updates…"
  -> checkForUpdatesManual() in main
  -> autoUpdater.checkForUpdates() + appropriate dialog (sheet on main window)
```

## Integration Points

- **Release & Distribution** — Ships the artifacts the updater consumes. The `electron-builder.yml` `mac.target` must include **both** `dmg` and `zip` — `electron-updater` requires the ZIP payload; without it `MacUpdater` throws `ZIP file not provided` on every check. See [Release & Distribution](../distribution/release.md)
- **App Shell** — `UpdateStatusButton` mounts in the sidebar footer (right of `LocalDevStatusButton`, left of `InterfaceMenu`), and its ready-only variant in the top bar's right-aligned group, before the job-origin pill, while the sidebar is out of view (`selectSidebarVisible`). See [App Shell](../../ui/app_shell/app_shell.md)
- **Window focus** — Updater dialogs get their parent from `ensureMainWindow()`, which reopens a closed window, and raise a hidden or minimized window with `focusMainWindow()`, both in `src/main/window/focus.ts`, rather than reaching for `BrowserWindow` directly
- **Logger** — All updater events are logged under the `updater` scope: check lifecycle, download progress (debug), errors, manual-check requests. Surfaced via the in-app logs overlay. See [Logger](../logger/logger.md)
- **Menu accelerator** — The "Check for Updates…" item lives in the explicit `appMenu` template in `src/main/index.ts`, replacing the default `role: 'appMenu'` so the item can be inserted right after "About"
