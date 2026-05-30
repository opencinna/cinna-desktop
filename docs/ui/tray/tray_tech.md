# Menu-Bar Tray — Technical Details

## File Locations

### Main process
- `src/main/services/trayService.ts` — `trayService` owns the `Tray` and the popup `BrowserWindow`. Public: `create({ getMainWindow })` (idempotent — placeholder image, tooltip, `click`/`right-click` → `toggle()`, eager `buildPopup()`), `setImage(dataUrl, tooltip)`, `startChat(agentId)`, `openStatus(agentId)`, `hidePopup()`, `destroy()` (idempotent). Internal: `buildPopup()` (frameless / `transparent` / `alwaysOnTop` / `skipTaskbar`; macOS adds `vibrancy: 'popover'` + `visualEffectState: 'active'` + `hasShadow`; loads `trayPanel.html`; `blur` → `fadeOutPopup`), `positionPopup()` (centers under `tray.getBounds()`, clamped to the display work area; cursor-position fallback for empty bounds), `raiseMain()`, `toggle()` (with `REOPEN_GUARD_MS` blur/click guard), and fade helpers `showPopup` / `fadeOutPopup` / `animateOpacity` (native `BrowserWindow.setOpacity` tween, `stopFade()` cancels in-flight). Uses `appIconService.iconForCurrentTheme()` for the initial placeholder and `createLogger('tray')`.
- `src/main/services/traySync.ts` — `syncTrayFromSettings()` reads `appSettingsRepo.get('enableTrayIcon')` and either calls `trayService.create({ getMainWindow })` + sends `tray:request-icon` to the main window, or calls `trayService.destroy()`. Single chokepoint for the lifecycle rule (startup + settings-write). Uses `createLogger('tray-sync')`.
- `src/main/ipc/tray.ipc.ts` — `registerTrayHandlers()` — `tray:set-image`, `tray:start-chat` (+ `userActivation.requireActivated()`), `tray:open-status` (+ `userActivation.requireActivated()`), `tray:close-popup`.
- `src/main/ipc/settings.ipc.ts` — `settings:set` calls `syncTrayFromSettings()` after a successful write when `key === 'enableTrayIcon'` so a renderer toggle takes effect live without restart.
- `src/main/ipc/index.ts` — `registerTrayHandlers()` wired into `registerAllIpcHandlers()`.
- `src/main/index.ts` — `syncTrayFromSettings()` at the end of `createWindow()` (replaces the unconditional `trayService.create`); `mainWindow.on('closed', …)` calls `trayService.destroy()` and nulls the ref so `activate` rebuilds both.
- `src/main/db/appSettings.ts` — `DEFAULTS.enableTrayIcon: true` so existing installs keep the tray on after upgrade.
- `src/main/services/appIconService.ts` — reused for the placeholder tray image.

### Preload
- `src/preload/index.ts` — `window.api.tray`: `setImage(dataUrl, tooltip)`, `startChat(agentId)`, `openStatusDetail(agentId)`, `closePopup()`, `onFocusChat(handler)` (listens `tray:focus-chat`), `onFocusStatus(handler)` (listens `tray:focus-status`), `onRequestIcon(handler)` (listens `tray:request-icon`).

### Renderer — main window
- `src/renderer/src/hooks/useTrayIcon.ts` — mounted once in `Shell` (`src/renderer/src/App.tsx`). Renders the menu-bar PNG to a 2× canvas (lucide `Activity` glyph path + severity dot colored via `SEVERITY_HEX` — no halo ring; glyph color chosen from `prefers-color-scheme`) and pushes it via `window.api.tray.setImage` on worst-severity / system-appearance change. A `pushRef` keeps the latest push closure so the `onRequestIcon` subscription (mounted once with no deps) always re-pushes with the current `worst`/`tooltip`. Subscribes `onFocusChat` (closes the logs + status overlays, clears `agentStatusDetailId`, `setActiveView('chat')` + `setPendingAgentId`), `onFocusStatus` (`setAgentStatusDetailId` + `setAgentStatusOpen(true)`), and `onRequestIcon` (re-pushes the canvas image after main creates the tray at runtime).
- `src/renderer/src/components/settings/FeaturesSettingsSection.tsx` — Features tab. Two groups: **AI Functions** (`autoChatTitles`) and **Interface** (`enableTrayIcon`). A local presentational `ToggleRow` renders each row; toggles go through `useSetAppSetting`.
- `src/renderer/src/components/agents/AgentStatusOverlay.tsx` — detail selection is backed by the ui-store `agentStatusDetailId` (so the tray can open it at a specific agent); compact "Agents [count]" header with no separator.
- `src/renderer/src/stores/ui.store.ts` — `agentStatusDetailId: string | null` + `setAgentStatusDetailId`.
- `src/renderer/src/constants/agentSeverity.ts` — `SEVERITY_HEX` (raw hex per severity for canvas painting).
- `src/renderer/src/hooks/useAgentStatus.ts` — `refetch()` resolves `Promise<boolean>` (success flag driving the popup refresh flash).

### Renderer — popup window
- `src/renderer/trayPanel.html` — second renderer HTML entry (transparent body, same strict CSP as `index.html`).
- `src/renderer/src/trayPanel.tsx` — popup React root. Applies theme from `localStorage('cinna-theme')` + a `storage` listener; bootstraps `auth.store.currentUser` via `window.api.auth.getCurrent()` on mount and on every window `focus` (own store instance, created hidden before activation); mounts `<QueryClientProvider><TrayPanel/></QueryClientProvider>`.
- `src/renderer/src/components/tray/TrayPanel.tsx` — popup list. `useAgentStatus` + `useTrayActions`; "Agents [count]" + refresh-all (`MIN_SPIN_MS = 500` minimum spin + success/error color flash held `FLASH_HOLD_MS = 500`; timers tracked in refs, cleared on unmount). Loading / empty / error states; a `reauth_required` error shows an "open the app to re-authenticate" hint.
- `src/renderer/src/components/tray/TrayStatusCard.tsx` — compact two-line card: severity dot + inline `Bot` icon + name, one-line summary, relative time + Start-Chat button (no per-card refresh).
- `src/renderer/src/hooks/useTrayActions.ts` — `useTrayActions()` returns `startChat` / `openStatusDetail` / `closePopup`, wrapping `window.api.tray.*` so the popup component does not touch the bridge directly.

### Shared (main window + popup)
- `src/renderer/src/components/agents/statusViews.tsx` — `StatusCard`, `DetailView`, `SeverityIcon`, `formatRelative`, `sortByUrgency`, extracted from the overlay. The overlay imports all; the popup imports `sortByUrgency` (and reuses `DetailView` indirectly via the main-window overlay).

### Build
- `electron.vite.config.ts` — `renderer.build.rollupOptions.input = { index, trayPanel }` adds the second HTML entry; the preload is shared.

## Database Schema

The lifecycle toggle is stored in the installation-global `app_settings` KV store as `enableTrayIcon: boolean` (default `true`). Schema: `src/shared/appSettings.ts`; defaults: `src/main/db/appSettings.ts`. The popup reuses the agent-status data path (`agent-status:list` / `agent-status:get`) — see [Agent Status](../../agents/agent_status/agent_status.md).

## IPC Channels

Renderer → Main (`invoke`):
- `tray:set-image` `{ dataUrl, tooltip }` — decode the PNG data URL → `nativeImage.createFromBuffer(buf, { scaleFactor: 2 })` → `Tray.setImage` + `setToolTip` (empty/invalid → placeholder).
- `tray:start-chat` `{ agentId }` — `requireActivated()`, hide popup, raise main window, broadcast `tray:focus-chat`.
- `tray:open-status` `{ agentId }` — `requireActivated()`, hide popup, raise main window, broadcast `tray:focus-status`.
- `tray:close-popup` — fade out / hide the popup.
- `settings:set` `('enableTrayIcon', boolean)` — generic settings channel; the handler calls `syncTrayFromSettings()` when the key matches (see [Settings](../settings/settings.md)).

Main → main window (`webContents.send`):
- `tray:focus-chat` `{ agentId }` — consumed by `useTrayIcon` (`onFocusChat`).
- `tray:focus-status` `{ agentId }` — consumed by `useTrayIcon` (`onFocusStatus`).
- `tray:request-icon` (no payload) — sent by `syncTrayFromSettings()` after `trayService.create()` so the renderer re-pushes the canvas-rendered icon onto the fresh `Tray` instead of leaving the placeholder.

## Services & Key Methods

- `src/main/services/trayService.ts` — `create` / `setImage` / `startChat` / `openStatus` / `hidePopup` / `destroy`; internal `buildPopup` / `positionPopup` / `raiseMain` / `toggle` / `showPopup` / `fadeOutPopup` / `animateOpacity` / `stopFade`.
- `src/main/services/traySync.ts` — `syncTrayFromSettings()` only. Reads `appSettingsRepo.get('enableTrayIcon')`, branches on the boolean, and pings the renderer with `tray:request-icon` after a create so the canvas icon replaces the placeholder.
- Data services are unchanged — the popup calls the existing `agentStatusService` via `agent-status:*` (see [Agent Status](../../agents/agent_status/agent_status.md)).

## Renderer Components

- Main window: `useTrayIcon` (icon push + focus/request-icon listeners), `AgentStatusOverlay` (store-backed detail target), `FeaturesSettingsSection` (hosts the **Interface** group + **Enable Tray Icon** switch).
- Popup window: `trayPanel.tsx` (root) → `TrayPanel` (list + refresh) → `TrayStatusCard` (rows); `useTrayActions` for imperative commands.

## Configuration

- `trayService.ts` constants: `POPUP_WIDTH` / `POPUP_HEIGHT`, `REOPEN_GUARD_MS`, `FADE_MS` / `FADE_TICK_MS`.
- `TrayPanel.tsx` constants: `MIN_SPIN_MS`, `FLASH_HOLD_MS`.
- macOS-only window options: `vibrancy: 'popover'`, `visualEffectState: 'active'`, `hasShadow`.
- App setting: `enableTrayIcon: boolean` (Settings → Features → Interface), default `true`.

## Security

- Popup `webPreferences`: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`; same strict CSP as the main window.
- `tray:start-chat` and `tray:open-status` gate on `userActivation.requireActivated()`.
- No credentials cross the bridge — the popup only receives agent-status DTOs through the existing gated handlers; `tray:set-image` accepts image bytes only (invalid input degrades to the placeholder image).
