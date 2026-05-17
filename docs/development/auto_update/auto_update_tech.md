# Auto-Update — Technical Details

## File Locations

### Shared
- `src/shared/updaterState.ts` — `UpdaterState` discriminated union (`idle` | `downloading` | `downloaded`) and the `UPDATER_BROADCAST_CHANNEL` constant; consumed by both main and renderer

### Main Process
- `src/main/updater/updater.ts` — Wraps `electron-updater`. Holds `currentState`, `setState()` (cache + broadcast), `configureUpdater()` (idempotent listener attachment), `initAutoUpdater()` (production-only init + 6h interval), `checkForUpdatesManual()` (menu-triggered with dialog feedback), `promptInstall(version)` (internal restart dialog), `promptInstallCurrent()` (used by IPC), `getUpdaterState()` (snapshot accessor)
- `src/main/ipc/updater.ipc.ts` — `registerUpdaterHandlers()` — exposes `updater:get-state` and `updater:prompt-install`
- `src/main/ipc/index.ts` — Calls `registerUpdaterHandlers()` at the end of `registerAllIpcHandlers()`
- `src/main/index.ts` — (a) Calls `initAutoUpdater()` after `createWindow()`. (b) Replaces `role: 'appMenu'` with an explicit submenu containing "Check for Updates…" wired to `checkForUpdatesManual()`

### Preload
- `src/preload/index.ts` — `window.api.updater.{getState, promptInstall, onState}`. `onState` returns an unsubscribe function (same pattern as `logger.onEntry`)

### Renderer
- `src/renderer/src/stores/updater.store.ts` — Zustand `useUpdaterStore`. State: `{ state, subscribed, unsubscribe }`. Actions: `subscribe()` (hydrate via `getState()` then attach `onState` listener), `promptInstall()` (wrapped in try/catch; failures logged via renderer `createLogger('updater')`)
- `src/renderer/src/components/updater/UpdateStatusButton.tsx` — Footer indicator. Returns `null` when `phase === 'idle'`. Three render modes corresponding to the three phases
- `src/renderer/src/components/layout/Sidebar.tsx` — Mounts `<UpdateStatusButton />` in the sidebar footer between `AgentStatusButton` and `InterfaceMenu`

### Build Config
- `electron-builder.yml` — `mac.target` lists **both** `dmg` (user download) and `zip` (auto-update payload). Removing the zip target breaks `electron-updater` (`ZIP file not provided` error)
- `.github/workflows/release-linux.yml` — Builds AppImage + deb on tag push; AppImage participates in auto-update, deb does not

## Database Schema

None — auto-update state is in-memory only. `currentState` is reset on every process launch; `electron-updater` re-derives whether an update is pending from the GitHub manifest plus the local cache directory.

## IPC Channels

| Channel | Type | Purpose |
|---------|------|---------|
| `updater:get-state` | invoke | Returns the current `UpdaterState` snapshot for renderer hydration |
| `updater:prompt-install` | invoke | Re-opens the native "Restart now / Later" dialog if `phase === 'downloaded'`; otherwise shows an info dialog. Returns `{ success: true }` once the dialog closes |
| `updater:state` | send (main → renderer) | Broadcast on every state transition. Payload is the full `UpdaterState` (not a diff) |

## State Machine

| Event | Current phase | New phase | Notes |
|-------|---------------|-----------|-------|
| `update-available(version)` | `idle` / `downloading` | `downloading(version, 0)` | Bootstraps the progress ring |
| `update-available(version)` | `downloaded(sameVersion)` | unchanged | Stale-state guard; prevents the periodic 6h poll from resetting the ring |
| `download-progress(percent)` | `downloading` | `downloading(version, percent)` | Version inherited from the previous downloading state |
| `download-progress(percent)` | `downloaded` | unchanged | Defensive — should not happen |
| `update-downloaded(version)` | any | `downloaded(version)` | Auto-prompt fires once here |
| `update-not-available` | any | unchanged | A queued download is preserved across subsequent "no update" responses |
| `error` | any | unchanged | Footer indicator is not used for surfacing errors |

## Services & Key Methods

- `src/main/updater/updater.ts:setState(next)` — Mutates `currentState` and broadcasts on `UPDATER_BROADCAST_CHANNEL` via `BrowserWindow.getAllWindows()` (skipping destroyed windows)
- `src/main/updater/updater.ts:configureUpdater()` — Idempotent. Sets `autoDownload`/`autoInstallOnAppQuit`, plugs the logger adapter, attaches all event listeners. Safe to call from both `initAutoUpdater()` and `checkForUpdatesManual()`
- `src/main/updater/updater.ts:initAutoUpdater()` — Production-build entry: skips in dev, calls `configureUpdater()`, fires initial check, schedules a 6-hour periodic check (`SIX_HOURS_MS`)
- `src/main/updater/updater.ts:checkForUpdatesManual()` — Menu-triggered. In dev shows an info dialog. In prod calls `configureUpdater()` then `autoUpdater.checkForUpdates()`; the resolved `UpdateCheckResult.downloadPromise` is the truthiness signal for "update available". If `currentState.phase === 'downloaded'` the manual path re-opens the install prompt directly
- `src/main/updater/updater.ts:promptInstall(version)` — Native message box with `Restart now` (id 0) / `Later` (id 1). Response 0 → `autoUpdater.quitAndInstall()`
- `src/main/updater/updater.ts:promptInstallCurrent()` — Used by the renderer-triggered IPC. Guards against `phase !== 'downloaded'` (shows "No update is ready to install yet.")
- `src/main/updater/updater.ts:getUpdaterState()` — Snapshot accessor for the `updater:get-state` IPC handler
- `src/renderer/src/stores/updater.store.ts:subscribe()` — Hydrate-then-subscribe pattern. Guards against double-subscription via the `subscribed` flag

## Renderer Components

- `UpdateStatusButton` — Self-subscribes via `useEffect(() => { void subscribe() }, [subscribe])`. Three branches:
  - `phase === 'idle'` → `return null`
  - `phase === 'downloading'` → `<div>` (non-button — no click target) with a `Download` lucide icon and an absolutely-positioned SVG ring. The ring uses `strokeDasharray={circumference}` and `strokeDashoffset = circumference * (1 - percent / 100)`, rotated -90° via Tailwind `-rotate-90` so progress starts at 12 o'clock. Background ring at 40% opacity for the unfilled portion
  - `phase === 'downloaded'` → `<button>` that calls `promptInstall()` on click. Same `Download` icon plus a pulsing `bg-emerald-500` corner dot using Tailwind `animate-pulse`
- Tooltips: downloading → `Downloading update ${version} — ${percent}%`; downloaded → `Update ${version} ready — click to restart and install`

## Configuration

- `autoDownload: true` (set in `configureUpdater()`)
- `autoInstallOnAppQuit: true` (set in `configureUpdater()`)
- `SIX_HOURS_MS = 6 * 60 * 60 * 1000` — periodic check interval
- `UPDATER_BROADCAST_CHANNEL = 'updater:state'` (defined in `src/shared/updaterState.ts`)
- Ring geometry constants in `UpdateStatusButton.tsx`: `RING_SIZE = 22`, `RING_STROKE = 2`, derived `RING_RADIUS` and `RING_CIRCUMFERENCE`
- GitHub publish config in `electron-builder.yml` (`publish.provider: github`, `owner: opencinna`, `repo: cinna-desktop`) drives where `electron-updater` looks for `latest-mac.yml` / `latest-linux.yml`

## Security

- The renderer can trigger `autoUpdater.quitAndInstall()` indirectly via `updater:prompt-install`. The IPC handler always goes through `promptInstallCurrent()`, which only triggers the install if a download is actually `downloaded` — the user cannot use the IPC to force-quit the app
- `electron-updater` verifies the macOS update against the running app's Developer ID before applying. The compromise surface is the GitHub Release + the Apple Developer ID private key; see [Release & Distribution](../distribution/release.md) "Trust model"
- AppImage updates are verified by SHA-512 from `latest-linux.yml`. There is no OS-level code signature on Linux
- No credentials or PII flow through the updater IPC — the broadcast payload is just `{ phase, version, percent }`. Versions and progress are not sensitive
- Error messages from `electron-updater` are surfaced verbatim in the manual-check error dialog. They may contain GitHub URLs but no secrets
