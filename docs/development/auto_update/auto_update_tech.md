# Auto-Update — Technical Details

## File Locations

### Shared
- `src/shared/updaterState.ts` — `UpdaterState` discriminated union (`idle` | `downloading` | `downloaded`) and the `UPDATER_BROADCAST_CHANNEL` constant; consumed by both main and renderer

### Main Process
- `src/main/host/desktop/updater.ts` — Wraps `electron-updater`. Holds `currentState`, `setState()` (cache + broadcast), `configureUpdater()` (idempotent listener attachment), `initAutoUpdater()` (production-only init + 6h interval), `checkForUpdatesManual()` (menu-triggered with dialog feedback), `showUpdaterDialog(options)` (the single way any updater dialog is shown — as a sheet on the main window), `promptInstall(version)` (internal restart dialog), `promptInstallCurrent()` (used by IPC), `getUpdaterState()` (snapshot accessor)
- `src/main/window/focus.ts` — `ensureMainWindow()` (the main window; if the user closed it, reopens it through the creator `index.ts` installs with `installWindowCreator(createWindow)` and waits up to 10 s for its `show`) and `focusMainWindow()` (restore, show, raise, bring the app forward). The updater imports both instead of touching `BrowserWindow` for its parent
- `src/main/ipc/updater.ipc.ts` — `registerUpdaterHandlers()` — exposes `updater:get-state` and `updater:prompt-install`
- `src/main/ipc/index.ts` — Calls `registerUpdaterHandlers()` at the end of `registerAllIpcHandlers()`
- `src/main/index.ts` — (a) Calls `initAutoUpdater()` after `createWindow()`. (b) Replaces `role: 'appMenu'` with an explicit submenu containing "Check for Updates…" wired to `checkForUpdatesManual()`

### Preload
- `src/preload/index.ts` — `window.api.updater.{getState, promptInstall, onState}`. `onState` returns an unsubscribe function (same pattern as `logger.onEntry`)

### Renderer
- `src/renderer/src/stores/updater.store.ts` — Zustand `useUpdaterStore`. State: `{ state, subscribed, unsubscribe }`. Actions: `subscribe()` (claim the flag, attach `onState`, then hydrate via `getState()` — see below), `promptInstall()` (wrapped in try/catch; failures logged via renderer `createLogger('updater')`)
- `src/renderer/src/components/updater/UpdateStatusButton.tsx` — The indicator. Returns `null` when `phase === 'idle'`. Three render modes corresponding to the three phases. Props: `readyOnly` (render nothing unless `downloaded`) and `className` (replaces the default button classes, so a host bar can match its own buttons)
- `src/renderer/src/components/layout/Sidebar.tsx` — Mounts `<UpdateStatusButton />` in the sidebar footer between `LocalDevStatusButton` and `InterfaceMenu`
- `src/renderer/src/components/layout/TopBar.tsx` — Mounts `<UpdateStatusButton readyOnly className={TOPBAR_BTN} />` in a right-aligned group (`ml-auto`) that is present on every view, **before** `JobOriginBanner`, so the badge appearing and disappearing never moves the job pill; only while `selectSidebarVisible` (from `ui.store`) is false — fixed docking collapsed, or hover docking not peeking

### Build Config
- `electron-builder.yml` — `mac.target` lists **both** `dmg` (user download) and `zip` (auto-update payload). Removing the zip target breaks `electron-updater` (`ZIP file not provided` error)
- `.github/workflows/release-linux.yml` — Builds AppImage + deb on tag push; AppImage participates in auto-update, deb does not

## Database Schema

None — auto-update state is in-memory only. `currentState` is reset on every process launch; `electron-updater` re-derives whether an update is pending from the GitHub manifest plus the local cache directory.

## IPC Channels

| Channel | Type | Purpose |
|---------|------|---------|
| `updater:get-state` | invoke | Returns the current `UpdaterState` snapshot for renderer hydration |
| `updater:prompt-install` | invoke | Opens the "Restart now / Later" sheet if `phase === 'downloaded'`; otherwise shows an info sheet. Returns `{ success: true }` once the dialog closes |
| `updater:state` | send (main → renderer) | Broadcast on every state transition. Payload is the full `UpdaterState` (not a diff) |

## State Machine

| Event | Current phase | New phase | Notes |
|-------|---------------|-----------|-------|
| `update-available(version)` | `idle` / `downloading` | `downloading(version, 0)` | Bootstraps the progress ring |
| `update-available(version)` | `downloaded(sameVersion)` | unchanged | Stale-state guard; prevents the periodic 6h poll from resetting the ring |
| `download-progress(percent)` | `downloading` | `downloading(version, percent)` | Version inherited from the previous downloading state |
| `download-progress(percent)` | `downloaded` | unchanged | Defensive — should not happen |
| `update-downloaded(version)` | any | `downloaded(version)` | State and broadcast only — **no dialog** (see business rules in [auto_update.md](auto_update.md)) |
| `update-not-available` | any | unchanged | A queued download is preserved across subsequent "no update" responses |
| `error` | any | unchanged | Footer indicator is not used for surfacing errors |

## Services & Key Methods

- `src/main/host/desktop/updater.ts:setState(next)` — Mutates `currentState` and broadcasts on `UPDATER_BROADCAST_CHANNEL` via `BrowserWindow.getAllWindows()` (skipping destroyed windows)
- `src/main/host/desktop/updater.ts:configureUpdater()` — Idempotent. Sets `autoDownload`/`autoInstallOnAppQuit`, plugs the logger adapter, attaches all event listeners. Safe to call from both `initAutoUpdater()` and `checkForUpdatesManual()`
- `src/main/host/desktop/updater.ts:initAutoUpdater()` — Production-build entry: skips in dev, calls `configureUpdater()`, fires initial check, schedules a 6-hour periodic check (`SIX_HOURS_MS`)
- `src/main/host/desktop/updater.ts:checkForUpdatesManual()` — Menu-triggered. In dev shows an info dialog. In prod calls `configureUpdater()` then `autoUpdater.checkForUpdates()`; the resolved `UpdateCheckResult.downloadPromise` is the truthiness signal for "update available". If `currentState.phase === 'downloaded'` the manual path re-opens the install prompt directly
- `src/main/host/desktop/updater.ts:showUpdaterDialog(options)` — Awaits `ensureMainWindow()`, which reopens a closed window; only if that still yields none does it fall back to a parentless `dialog.showMessageBox(options)`. Otherwise, if the window is hidden or minimized, calls `focusMainWindow()` first (Electron uses `runModal` for a hidden parent, which is the failure the sheet exists to avoid), then `dialog.showMessageBox(win, options)`. Every `showMessageBox` in the file goes through it — a new updater dialog must too
- `src/main/host/desktop/updater.ts:promptInstall(version)` — Message box (via `showUpdaterDialog`) with `Restart now` (id 0) / `Later` (id 1). Response 0 → `autoUpdater.quitAndInstall()`
- `src/main/host/desktop/updater.ts:promptInstallCurrent()` — Used by the renderer-triggered IPC. Guards against `phase !== 'downloaded'` (shows "No update is ready to install yet.")
- `src/main/host/desktop/updater.ts:getUpdaterState()` — Snapshot accessor for the `updater:get-state` IPC handler
- `src/renderer/src/stores/updater.store.ts:subscribe()` — Subscribe-then-hydrate. Two buttons can mount together (sidebar footer and top bar), so `subscribed` is set **before** the first `await`; checking it and setting it after `getState()` let both callers through and attached two listeners. The `onState` listener is attached before the snapshot is fetched, and the snapshot is applied only if the state is still `idle`, because a broadcast that lands during the await is newer than the snapshot

## Renderer Components

- `UpdateStatusButton` — Self-subscribes via `useEffect(() => { void subscribe() }, [subscribe])` (safe from every mount; the store subscribes once). Branches:
  - `phase === 'idle'` → `return null`
  - `readyOnly` and `phase !== 'downloaded'` → `return null` (the top bar never shows the progress ring)
  - `phase === 'downloading'` → `<div>` (non-button — no click target) with a `Download` lucide icon and an absolutely-positioned SVG ring. The ring uses `strokeDasharray={circumference}` and `strokeDashoffset = circumference * (1 - percent / 100)`, rotated -90° via Tailwind `-rotate-90` so progress starts at 12 o'clock. Background ring at 40% opacity for the unfilled portion
  - `phase === 'downloaded'` → `<button>` that calls `promptInstall()` on click. Same `Download` icon plus a pulsing `bg-emerald-500` corner dot using Tailwind `animate-pulse`. Classes are `relative` plus `className` when given, else the footer's own `p-1.5 rounded-md …` string
- Tooltips: downloading → `Downloading update ${version} — ${percent}%`; downloaded → `Update ${version} ready — restart to install…` (the ellipsis because a click opens the confirm, it does not restart). No `aria-label`; the title is the accessible name

## Configuration

- `autoDownload: true` (set in `configureUpdater()`)
- `autoInstallOnAppQuit: true` (set in `configureUpdater()`)
- `SIX_HOURS_MS = 6 * 60 * 60 * 1000` — periodic check interval
- `UPDATER_BROADCAST_CHANNEL = 'updater:state'` (defined in `src/shared/updaterState.ts`)
- Ring geometry constants in `UpdateStatusButton.tsx`: `RING_SIZE = 22`, `RING_STROKE = 2`, derived `RING_RADIUS` and `RING_CIRCUMFERENCE`
- GitHub publish config in `electron-builder.yml` (`publish.provider: github`, `owner: opencinna`, `repo: cinna-desktop`) drives where `electron-updater` looks for `latest-mac.yml` / `latest-linux.yml`

## Security

- Raising a hidden window before a sheet uses `focusMainWindow()`, which steals focus (`app.focus({ steal: true })` on macOS). That is acceptable because every path into `showUpdaterDialog` now starts from a user action — a badge click or the menu item; a dialog raised from a background event would yank the user out of another app
- The renderer can trigger `autoUpdater.quitAndInstall()` indirectly via `updater:prompt-install`. The IPC handler always goes through `promptInstallCurrent()`, which only triggers the install if a download is actually `downloaded` — the user cannot use the IPC to force-quit the app
- `electron-updater` verifies the macOS update against the running app's Developer ID before applying. The compromise surface is the GitHub Release + the Apple Developer ID private key; see [Release & Distribution](../distribution/release.md) "Trust model"
- AppImage updates are verified by SHA-512 from `latest-linux.yml`. There is no OS-level code signature on Linux
- No credentials or PII flow through the updater IPC — the broadcast payload is just `{ phase, version, percent }`. Versions and progress are not sensitive
- Error messages from `electron-updater` are surfaced verbatim in the manual-check error dialog. They may contain GitHub URLs but no secrets

## Tests

- `src/main/window/focus.test.ts` — `ensureMainWindow` returns an existing window without creating one, reopens a closed one and resolves only once it is shown, returns `null` if the new window closes first, and stops waiting after the timeout
- `src/main/host/desktop/updater.test.ts` — Electron, `electron-updater` and `window/focus` mocked. A finished download records `downloaded` and broadcasts it without calling `showMessageBox`; the install prompt is attached to a visible window without focusing it and `Restart now` calls `quitAndInstall`; a hidden and a minimized window are each focused before the sheet attaches; with no window obtainable the box is parentless; each test sets up its own `downloaded` state, so any one runs alone; the manual check's dialog is attached to the window too
- `src/renderer/src/components/layout/TopBar.updateBadge.test.tsx` — the real button and store behind a stubbed `window.api.updater`: the ready badge shows in the top bar with the sidebar collapsed and installs on click, appears when a broadcast arrives after mount, stays out while downloading and disappears once the sidebar opens; `subscribe()` called twice concurrently attaches one listener; a broadcast that lands before the snapshot is kept
- `TopBar.agentStatusButton.test.tsx` and `TopBar.sidebarDocking.test.tsx` stub `UpdateStatusButton`, since they do not provide the updater bridge
- Not covered: that Electron actually draws a sheet (rather than `runModal`) for a visible parent, and the behaviour behind another app after wake — neither is observable outside a real macOS session
