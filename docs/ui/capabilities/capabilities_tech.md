# Capabilities — Technical Details

## File Locations

### Shared
- `src/shared/capabilities.ts` — `CapabilityState` (`unset | on | off`), `isCapabilityState`, `CAPABILITY_SETTING_KEYS` (`notes` -> `notesCapability`, `dashboards` -> `dashboardsCapability`).
- `src/shared/appSettings.ts` — the two keys in `AppSettingsSchema`; `APP_SETTINGS_CHANGED_CHANNEL` (`settings:changed`) and `AppSettingsChangedPayload { key }`.

### Main process
- `src/main/db/appSettings.ts` — `DEFAULTS` holds both keys as `'unset'`.
- `src/main/db/capabilityCounts.ts` — `capabilityCountsRepo.notes()` (rows with `deleted_at` null) and `.dashboards()`; deliberately not scoped to a user.
- `src/main/services/capabilityService.ts` — `createCapabilityService(deps)`; `resolveUnset()` and `isOn(capability)`; the singleton `capabilityService`.
- `src/main/services/appSettingsService.ts` — `VALUE_CHECKS` accept only `on`/`off` for both keys; `set` publishes `settings:changed` after a real change.
- `src/main/hub/core.ts` — calls `capabilityService.resolveUnset()` after the database and session are up, before the first window reads settings.
- `src/main/ipc/settings.ipc.ts` — `settings:get-all` calls `resolveUnset()` again before answering.
- `src/main/services/dashboards/dashboardRefreshService.ts` — `enabled` dep (`capabilityService.isOn('dashboards')` in production).

### Preload
- `window.api.settings.onChanged(handler)` — subscribes to `settings:changed`; returns the unsubscribe.

### Renderer
- `src/renderer/src/hooks/useCapabilities.ts` — `{ notesEnabled, dashboardsEnabled, loaded }` from `useAppSettings`; only `'on'` is true.
- `src/renderer/src/hooks/useAppSettings.ts` — `useAppSettingsWatch()`, mounted once in `App.tsx`'s `Shell`, invalidates the app-settings query on `settings:changed`.
- `src/renderer/src/stores/ui.store.ts` — `CAPABILITY_VIEWS` (notes -> `note-detail`, dashboards -> `dashboard`), `isSidebarTabEnabled`, `disabledCapabilityOnScreen`.
- `src/renderer/src/components/layout/SidebarTabs.tsx` — filters the rail; the effect that leaves a switched-off capability.
- `src/renderer/src/components/settings/FeaturesSettingsSection.tsx` — the Capabilities section (two `SettingsToggleRow`s, ids `feature-notes`, `feature-dashboards`).
- Gated consumers: `MessageContextMenu.tsx` (`messageMenuItems(..., saveToNotes)`), `ChatInput.tsx` (`hasPickableNotes`), `useHintContext.ts`, `DashboardOriginPill.tsx` (pill and `DashboardOriginRowMark`), `ComponentCard.tsx`, `AgentDashboardsTab.tsx`, `componentParts.tsx`.

## Services & Key Methods

- `resolveUnset()` — for each capability still `unset`, counts and writes `on` (count > 0) or `off`. Never throws; a count that throws leaves the key `unset` and logs a warning. Writes through `appSettingsRepo`, not `appSettingsService.set`, which refuses `unset` and is the user's path (and would publish a change nobody made).
- `isOn(capability)` — decides first if `unset`, then answers; any failure answers false.
- `dashboardRefreshService` asks `enabled()` in `warmUp`, `scheduleRan` and `syncTimer`. A running interval timer checks it at each tick and stops itself, so turning Dashboards off stops timers even while the lease is live. Leases, `refreshTile` and previews do not ask.
- `disabledCapabilityOnScreen(state)` names the capability whose tab or center is showing while off. `SidebarTabs` reacts only once `loaded` is true — an unloaded read is off but is not a choice, and must not throw a user out of a tab on launch. It sets the tab to Chats, and, when the center is that capability's view, reopens the last chat (`dashboardChatsStash` first, then the active chat, then the first).

## IPC Channels

- `settings:set` (`notesCapability` | `dashboardsCapability`, `'on'|'off'`) — as every app setting.
- `settings:changed` (main -> renderer, payload `{ key }`) — published through `host/events.publishEvent` on any real change, whoever wrote it.

## Configuration

E2E: the `capabilities` fixture option in `e2e/fixtures/app.ts` (default both) writes `on` through `window.api.settings.set` after `skipOnboarding()` and waits for the tabs; a fresh-user spec sets `test.use({ capabilities: [] })`.

## Validation

- `capabilityService.test.ts` — decision from counts, never re-deciding, failed count stays unset.
- `useCapabilities.test.ts`, `SidebarTabs.capabilities.test.tsx`, `ChatInput.notePicker.test.tsx`, `useHintContext.test.ts`, `FeaturesSettingsSection.test.tsx`, `MessageContextMenu*.test.tsx`, `DashboardOriginPill.test.tsx`, `ComponentCard.test.tsx`, `AgentDashboardsTab.test.tsx` — each gated surface.
- `dashboardRefreshService.test.ts` — "Dashboards turned off": no warm-up, timers armed/stopped, no schedule-fed run.
