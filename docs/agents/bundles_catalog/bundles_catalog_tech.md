# Bundles Catalog — Technical Reference

## File Locations

### Shared
- `src/shared/catalog.ts` — DTOs (`CatalogEntryDto`, `CatalogCredentialSpec`, `CatalogInstallResultDto`, `SetupStatusDto`, `SetupMissingItemDto`, `SetupCredentialSummaryDto`) consumed by the main service, preload bridge, and renderer

### Main Process
- `src/main/services/catalogService.ts` — `catalogService` object; proxies catalog + setup endpoints, projects server snake_case → desktop camelCase, hides secrets
- `src/main/ipc/catalog.ipc.ts` — `registerCatalogHandlers()`; thin `ipcHandle(...)` wrappers, no business logic
- `src/main/ipc/index.ts` — wires `registerCatalogHandlers` into `registerAllIpcHandlers()`

### Preload
- `src/preload/index.ts` — `window.api.catalog.{list,quickInstall,setupStatus,setupCredentials,serverUrl}` typed bindings

### Renderer
- `src/renderer/src/hooks/useCatalog.ts` — `useCatalog`, `useQuickInstallBundle`, `useSetupStatus`, `useSetupCredentials`, `useCatalogServerUrl` React Query hooks
- `src/renderer/src/components/settings/CatalogSettingsSection.tsx` — Settings → Profile → Catalog page entry point
- `src/renderer/src/components/settings/CatalogCard.tsx` — One expandable card per bundle; renders Install button or Active pill
- `src/renderer/src/components/settings/CatalogSetupModal.tsx` — Post-install dialog with credential status cards and 3s polling
- `src/renderer/src/components/settings/SettingsPage.tsx` — Routes the `profile-catalog` tab to `CatalogSettingsSection`
- `src/renderer/src/components/layout/Sidebar.tsx` — Adds `{ id: 'profile-catalog', label: 'Catalog', icon: Package }` to `profileMenuItems`
- `src/renderer/src/stores/ui.store.ts` — Adds `'profile-catalog'` to `SettingsMenu` and `PROFILE_SCOPE_TABS`

## Database Schema

None. The desktop is a stateless proxy — all bundle, install, and credential rows live on cinna-server. React Query caches the responses in-memory; nothing is persisted to SQLite.

## IPC Channels

| Channel | Args | Returns |
|---------|------|---------|
| `catalog:list` | — | `CatalogEntryDto[]` |
| `catalog:quick-install` | `bundleId: string` | `CatalogInstallResultDto` |
| `catalog:setup-status` | `installId: string` | `SetupStatusDto` |
| `catalog:setup-credentials` | `installId: string` | `SetupCredentialSummaryDto[]` |
| `catalog:server-url` | — | `string` (configured `cinnaServerUrl`) |

All channels run through `ipcHandle()` so `CinnaApiError.code` survives Electron's structured-clone serialization. Every handler calls `userActivation.requireActivated()` and `getProfileScopeUserId()` before delegating to `catalogService`.

## Services & Key Methods

### `catalogService` (`src/main/services/catalogService.ts`)

| Method | Notes |
|--------|-------|
| `list(userId)` | `GET /api/v1/catalog/` → `ServerCatalogEntry[]` → `projectEntry` → `CatalogEntryDto[]` |
| `quickInstall(userId, bundleId)` | `POST /api/v1/catalog/{bundle_id}/install` with `{}`; throws `CinnaApiError('invalid_response')` when the response lacks `id` |
| `getSetupStatus(userId, installId)` | `GET /api/v1/agents/{id}/setup-status` → `SetupStatusDto` |
| `getSetupCredentials(userId, installId)` | `GET /api/v1/agents/{id}/setup-credentials` → `SetupCredentialSummaryDto[]` (used to resolve `placeholder_empty` rows to credential UUIDs) |
| `getServerUrl(userId)` | Resolves the active profile's `cinnaServerUrl` so the renderer can build `/credential/{id}` and `/agent/{id}#credentials` deep links |

Internal helpers mirror `cinnaApiService`:
- `resolveBaseUrl(userId)` — raises `CinnaApiError('not_cinna_user' | 'missing_server_url')`
- `resolveAuthHeader(userId)` — wraps `getCinnaAccessToken()`; translates `CinnaReauthRequired` to `CinnaApiError('reauth_required')`
- `cinnaFetch<T>(userId, path, opts)` — single fetch helper. Maps 401/403 to `reauth_required`, other non-2xx to `request_failed` with a 200-char body excerpt, network errors to `request_failed`, JSON parse errors to `invalid_response`
- `projectEntry`, `projectSpec`, `projectMissing` — pure mapping helpers; no I/O

### Renderer Hooks (`src/renderer/src/hooks/useCatalog.ts`)

| Hook | Notes |
|------|-------|
| `useCatalog()` | Query key `['catalog']`; gated on `currentUser?.type === 'cinna_user'`; 60s staleTime |
| `useQuickInstallBundle()` | Mutation; on success invalidates `['catalog']` and `['agents']` so the card flips to Active and the remote-agent sync picks up the new install |
| `useSetupStatus({ installId, poll })` | Query key `['catalog', 'setup-status', installId]`; `refetchInterval` stops at `status === 'ready'`; mounts a `window.addEventListener('focus', refetch)` listener when `poll=true` |
| `useSetupCredentials(installId)` | Query key `['catalog', 'setup-credentials', installId]`; 30s staleTime |
| `useCatalogServerUrl()` | Query key `['catalog', 'server-url']`; 5min staleTime; used to build credential deep links |

## Renderer Components

### `CatalogSettingsSection`
Owns:
- `pendingBundleId` (one Install in flight at a time)
- `activeSetup` (drives the modal)
- `toast` (auto-dismiss after 4s)
- Reauth banner state via `useCinnaReauth`

Flow inside `handleInstall(bundleId, displayName)`:
1. Sets `pendingBundleId`
2. `quickInstall.mutateAsync(bundleId)`
3. `queryClient.fetchQuery(['catalog', 'setup-status', installId], () => window.api.catalog.setupStatus(installId))` — populates the cache so the modal's `useSetupStatus` reads from cache on first render
4. Branches on `status`: `ready` → success toast; otherwise → `setActiveSetup({...})`
5. Errors translate `err.code === 'reauth_required'` to a re-auth-prompted toast

### `CatalogCard`
Pure presentational component. Renders the version label (`v<version>` or `rev <n>`), publisher info, bundle ID (monospace), and the required-credential summary. Install button is replaced with an "Installed" indicator when `entry.isInstalled`. Disables itself when another card is mid-install.

### `CatalogSetupModal`
- Mounts `useSetupStatus({ installId, poll: true })` and `useSetupCredentials(installId)`
- Joins server-side missing items (by `specName`) with desktop-side placeholder credentials (by `name`) to resolve per-credential UUIDs
- Renders one `CredentialStatusCard` per missing item: amber dot + open-in-browser icon for user placeholders, red dot + disabled for `publisher_credential_*`
- Footer shows a permanent "Auto-refreshing every 3 seconds" line and an "Open on server" button derived from `status.setupUrl` (with a `cinnaServerUrl` + `/agent/{id}#credentials` fallback)
- `useEffect` on `status.data?.status === 'ready'` triggers the `onReady` callback (parent invalidates queries, fires the success toast, and closes)

## Configuration

| Setting | Source | Notes |
|---------|--------|-------|
| Cinna server URL | `users.cinna_server_url` (set during Cinna OAuth) | Used for both API base and frontend deep links (`/credential/{id}`, `/agent/{id}#credentials`) |
| Cinna access token | `users.cinna_access_token_encrypted` + `cinna-tokens.ts` rotation | Decrypted in main process only; injected as Bearer JWT on every request |

No catalog-specific env vars or settings; the feature inherits its surface area entirely from the active Cinna profile.

## Security

- Catalog calls run **only** in the main process; the renderer never sees the Bearer token. The `system.openExternal` boundary still validates `http(s)` before handing URLs to `shell.openExternal`
- IPC handlers gate on `userActivation.requireActivated()` and the active profile's user id (`getProfileScopeUserId()`) — a deactivated session can't proxy catalog calls
- `setup-status` returns *names and types only*; no credential secrets cross the IPC boundary
- `CinnaApiError` codes survive serialization via `_wrap.ts` so the renderer can branch on `err.code === 'reauth_required'` instead of regex-matching error strings
- The server-supplied `setup_url` is treated as the authoritative frontend host; the desktop never substitutes its own host (matches the trust model used by existing cinna-server deep links in `JobRunRow.tsx` / `CinnaTaskRunView.tsx`)
