# Bundles Catalog — Technical Reference

## File Locations

### Shared
- `src/shared/catalog.ts` — DTOs (`CatalogEntryDto`, `CatalogCredentialSpec`, `CatalogInstallResultDto`, `InstallContextDto`, `InstallContextSpecDto`, `InstallContextPublisherSummaryDto`, `SetupStatusDto`, `SetupMissingItemDto`, `SetupCredentialSummaryDto`) consumed by the main service, preload bridge, and renderer

### Main Process
- `src/main/services/catalogService.ts` — `catalogService` object; proxies catalog + setup endpoints, projects server snake_case → desktop camelCase, hides secrets
- `src/main/ipc/catalog.ipc.ts` — `registerCatalogHandlers()`; thin `ipcHandle(...)` wrappers, no business logic
- `src/main/ipc/index.ts` — wires `registerCatalogHandlers` into `registerAllIpcHandlers()`

### Preload
- `src/preload/index.ts` — `window.api.catalog.{list,quickInstall,installContext,uninstall,setupStatus,setupCredentials,serverUrl}` typed bindings

### Renderer
- `src/renderer/src/hooks/useCatalog.ts` — `useCatalog`, `useRefreshCatalogState`, `useQuickInstallBundle`, `useUninstallBundle`, `useInstallContext`, `useSetupStatus`, `useSetupCredentials`, `useCatalogServerUrl` React Query hooks
- `src/renderer/src/components/settings/CatalogSettingsSection.tsx` — Settings → Profile → Catalog page entry point
- `src/renderer/src/components/settings/CatalogCard.tsx` — One expandable card per bundle; renders header + the expanded body wrapper. Composes `CatalogCardCredentials` for the install-context sections and `CatalogCardFooter` for installed-bundle actions
- `src/renderer/src/components/settings/CatalogCardCredentials.tsx` — Self-contained subcomponent that owns the install-context React Query subscription, the required-credentials list with per-spec match icons, the AI credentials sibling section, and the error chip + retry. Inline helpers: `ProvidedByBadge`, `TypeBadge`, `CredentialIcon`, `AICredentialsSection`, `AIPublisherRow`
- `src/renderer/src/components/settings/CatalogCardFooter.tsx` — Self-contained footer rendered only for installed bundles; owns `useCatalogServerUrl`, `useUninstallBundle`, and the `CatalogUninstallModal` state. Returns `null` when `entry.userInstallId` is missing
- `src/renderer/src/components/settings/CatalogSetupModal.tsx` — Post-install dialog with credential status cards and 3s polling
- `src/renderer/src/components/settings/CatalogUninstallModal.tsx` — Destructive-action confirmation dialog rendered from `CatalogCardFooter`; mirrors cinna-server's `UninstallAgent` wording
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
| `catalog:install-context` | `bundleId: string` | `InstallContextDto` |
| `catalog:uninstall` | `installId: string` | `{ success: true }` |
| `catalog:setup-status` | `installId: string` | `SetupStatusDto` |
| `catalog:setup-credentials` | `installId: string` | `SetupCredentialSummaryDto[]` |
| `catalog:server-url` | — | `string` (configured `cinnaServerUrl`) |

All channels run through `ipcHandle()` so `CinnaApiError.code` survives Electron's structured-clone serialization. Every handler calls `userActivation.requireActivated()` and `getProfileScopeUserId()` before delegating to `catalogService`.

## Services & Key Methods

### `catalogService` (`src/main/services/catalogService.ts`)

| Method | Notes |
|--------|-------|
| `list(userId)` | `GET /api/v1/catalog/` → `ServerCatalogEntry[]` → `projectEntry` → `CatalogEntryDto[]` |
| `quickInstall(userId, bundleId)` | Two-step: `fetchServerInstallContext()` to pull the server's per-spec `suggested_credential_id`, then `POST /api/v1/catalog/{bundle_id}/install` with a constructed body — `buildDefaultCredentialsPayload` maps each spec to `publisher_provides` (PBP), `use_existing` with the matched UUID (PBU/PBT with a suggestion), or `skip`; `buildDefaultAISelections` forwards `use_publisher_ai: true` when the bundle offers it. Mirrors `frontend/src/components/Install/useQuickInstall.ts` in cinna-core. Emits `quick install start` (count-only summary: specCount / useExistingCount / publisherProvidesCount / skipCount / usePublisherAi) and `quick install done` info logs; failures are caught and re-thrown after a scoped `quick install failed` error log carrying `bundleId`, the `CinnaApiError.code`, and the message so the Logger UI shows the exact payload shape AND the failure outcome. Throws `CinnaApiError('invalid_response')` when the install response lacks `id` |
| `getInstallContext(userId, bundleId)` | `fetchServerInstallContext()` → `projectInstallContextSpec` per spec + `projectPublisherSummary` for each AI role → `InstallContextDto`. The projection deliberately drops `suggested_credential_id` / `suggested_credential_name` so credential UUIDs never reach the renderer; the catalog card only needs `hasSuggestedMatch: boolean` to pick its per-spec icon. AI publisher summaries (name + type only — no secret values) are forwarded so the card can name the publisher-provided Conversation / Building credentials |
| `uninstall(userId, installId)` | `POST /api/v1/agents/{install_id}/uninstall` with `{}`. Emits `uninstall start` and (on success) `uninstall done` info logs; failures are caught and re-thrown after a scoped `uninstall failed` error log carrying `installId`, the `CinnaApiError.code`, and the message. Server contract (`workflow-runner-core/backend/app/api/routes/installs.py`): returns `{ status: 'uninstalled' }` on success, 400-rejects publisher installs with a clear message that `cinnaFetch` propagates as `CinnaApiError('request_failed', ...)`. App-data volumes are preserved server-side and re-attach automatically on the next install of the same bundle |
| `getSetupStatus(userId, installId)` | `GET /api/v1/agents/{id}/setup-status` → `SetupStatusDto` |
| `getSetupCredentials(userId, installId)` | `GET /api/v1/agents/{id}/setup-credentials` → `SetupCredentialSummaryDto[]` (used to resolve `placeholder_empty` rows to credential UUIDs) |
| `getServerUrl(userId)` | Resolves the active profile's `cinnaServerUrl` so the renderer can build `/credential/{id}` and `/agent/{id}#credentials` deep links |

Internal helpers mirror `cinnaApiService`:
- `resolveBaseUrl(userId)` — raises `CinnaApiError('not_cinna_user' | 'missing_server_url')`
- `resolveAuthHeader(userId)` — wraps `getCinnaAccessToken()`; translates `CinnaReauthRequired` to `CinnaApiError('reauth_required')`
- `cinnaFetch<T>(userId, path, opts)` — single fetch helper. Maps 401/403 to `reauth_required`, other non-2xx to `request_failed` with a human-readable detail string (parsed via `extractErrorDetail`: prefers FastAPI's `body.detail`, then `body.message`, falls back to a 200-char raw slice — so the user sees `"Cinna API 400: Cannot uninstall the publisher install…"` instead of the raw JSON envelope). Network errors map to `request_failed`, JSON parse errors to `invalid_response`
- `projectEntry`, `projectSpec`, `projectMissing`, `projectInstallContextSpec`, `projectPublisherSummary` — pure mapping helpers; no I/O
- `extractErrorDetail(text)` — pure helper that turns a non-2xx response body into a human-readable message. Tries `JSON.parse` when the body looks JSON-shaped, prefers `body.detail` (FastAPI convention) over `body.message`, falls back to the raw 200-char slice. Used by `cinnaFetch` so the `CinnaApiError.message` the renderer sees is "Cannot uninstall the publisher install…" instead of the literal JSON envelope
- `fetchServerInstallContext(userId, bundleId)` — single private wrapper around `GET /api/v1/catalog/{bundle_id}/install-context`. Shared by `quickInstall` (which needs the raw `suggested_credential_id` UUIDs to build the install body) and `getInstallContext` (which re-projects the shape into `InstallContextDto` for the renderer)
- `buildDefaultCredentialsPayload(context, bundleId)`, `buildDefaultAISelections(context)` — pure functions that translate the `ServerInstallContext` response into the `InstallCredentialSelection` + `AICredentialSelections` shapes accepted by `POST /catalog/{bundle_id}/install`. Kept in sync with cinna-core's `useQuickInstall.ts`. `buildDefaultCredentialsPayload` takes `bundleId` only to scope the defensive `warn` log it emits when the server's `install-context` response violates the unique-spec-name invariant

### Renderer Hooks (`src/renderer/src/hooks/useCatalog.ts`)

| Hook | Notes |
|------|-------|
| `useCatalog()` | Query key `['catalog']`; gated on `currentUser?.type === 'cinna_user'`; 60s staleTime |
| `useRefreshCatalogState()` | Memoized callback: invalidates `['catalog']` AND fires `window.api.agents.syncRemote()`. The single source of truth for "catalog state changed on the server" — consumed by `useQuickInstallBundle.onSuccess`, `CatalogSettingsSection.handleModalReady`, and the Refresh button. Does NOT invalidate `['agents']` directly — the sync's `agents:remote-sync-complete` broadcast handles that downstream (see `useAgents`), avoiding a stale-read race during the sync window |
| `useQuickInstallBundle()` | Mutation; on success runs `useRefreshCatalogState()` so the card flips to Active and the freshly-installed agent appears in the `@` picker without waiting for the 5-min periodic sync |
| `useUninstallBundle()` | Mutation; on success runs `useRefreshCatalogState()` so the card flips back to uninstalled and the remote-agent sync drops the row. Errors are deliberately *not* surfaced as a global toast — `CatalogCard` keeps the confirmation modal open and renders the error inline so the user sees it in context |
| `useInstallContext(bundleId, enabled)` | Query key `['catalog', 'install-context', bundleId]`; `enabled` gate keeps the hook lazy — the catalog card only opts in when expanded AND the bundle is not yet installed. 60s staleTime so collapse/expand on the same card hits the cache instead of the server |
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

Consumes `useRefreshCatalogState()` once at the top of the component; the returned callback drives both `handleModalReady` and the Refresh button onClick (replacing what used to be a bare `catalog.refetch()`).

Flow inside `handleInstall(bundleId, displayName)`:
1. Sets `pendingBundleId`
2. `quickInstall.mutateAsync(bundleId)` — the mutation's `onSuccess` runs `useRefreshCatalogState()` internally
3. `queryClient.fetchQuery(['catalog', 'setup-status', installId], () => window.api.catalog.setupStatus(installId))` — populates the cache so the modal's `useSetupStatus` reads from cache on first render
4. Branches on `status`: `ready` → success toast; otherwise → `setActiveSetup({...})`
5. Errors translate `err.code === 'reauth_required'` to a re-auth-prompted toast

### `CatalogCard`
Thin orchestrator. Owns only the local `expanded` UI state and renders the card header (status dot, name, version, install/installed indicator, expand chevron) plus the expanded body wrapper (description, publisher line, bundle-id pill). Delegates the rest:

- `<CatalogCardCredentials entry={entry} enabled={expanded && !entry.isInstalled} />` for the install-context-driven sections
- `<CatalogCardFooter entry={entry} />` for installed-bundle actions, rendered inside the `AnimatedCollapse` after the body block

The Install button is replaced with an "Installed" indicator when `entry.isInstalled`; both states gate on `installing`/`disabled` from the parent so only one quick install runs at a time across the whole catalog.

### `CatalogCardCredentials`
Owns its own `useInstallContext(entry.bundleId, enabled)` subscription so the lazy fetch only happens when the parent passes `enabled=true` (uninstalled bundle, card expanded). `ctxBySpec` is memoised on `installContext.data` so the rebuild only runs when the query result actually changes. While fetching (initial load OR background refetch) and verdict data hasn't arrived yet, a small spinner sits next to the "Required credentials" header and each row's icon is a `Loader2` placeholder. Once data arrives, `CredentialIcon` picks per spec:

- `CheckCircle2` (success) — publisher row, or `hasSuggestedMatch === true` (the installer's existing credential will be linked at install time)
- `FileText` (accent) — template spec with no match (cinna-server will materialise a template-derived placeholder; installer fills `templatePrivateFields` after install)
- `KeyRound` (warning) — user spec with no match (installer will need to create a brand new credential)

`AICredentialsSection` is rendered as a sibling section below the required credentials whenever `installContext.data` is present:

- `aiProvidedByPublisher === true` — one row per non-null AI publisher summary (Conversation via `MessageCircle`, Building via `Wrench`), each with a green check, a "Shared by publisher" badge, and the publisher's credential name + type. When both summaries are absent the row collapses to a single "AI credentials" line with the publisher badge (matches cinna-core's fallback when summaries can't be resolved)
- `aiProvidedByPublisher === false` — single "AI credentials — your account defaults" row with a `KeyRound` warning icon and a "You provide" badge, signalling the install will fall back to whatever AI credentials the installer has configured on the cinna server (or land in `needs_setup` if none)

Install-context fetch errors render an `AlertTriangle` warning chip ("Couldn't check matching credentials — icons may be approximate") with a one-click `RotateCw` Retry button that calls `installContext.refetch()`; the credential rows fall back to the same `providedBy`-only heuristic used by installed cards, and the AI section hides itself because there's no publisher data to display.

For installed bundles the parent passes `enabled={false}`, the query stays disabled, and `CredentialIcon` falls back to a `providedBy`-only classification (publisher/template → success, user → muted key) because the match data wouldn't be actionable post-install. The AI section is also omitted in that case. When the bundle has no required credential specs AND no install-context data, the component returns `null` so the parent's `space-y-2.5` doesn't introduce a phantom row.

Inline helpers `ProvidedByBadge`, `TypeBadge`, `CredentialIcon`, `AICredentialsSection`, `AIPublisherRow` live in this file because nothing else consumes them.

### `CatalogCardFooter`
Self-contained installed-bundle footer. Owns its own `useCatalogServerUrl` query, `useUninstallBundle` mutation, and uninstall-modal UI state. Returns `null` when `entry.userInstallId` is missing so we never render a broken-link button.

Two actions:

- **Uninstall** (left-aligned, destructive styling) — opens `CatalogUninstallModal`. The modal owns its own pending/error UI; the footer passes `entry.displayName`, the mutation's `isPending`, the captured `errorMessage`, and the confirm/close callbacks. On confirm, `uninstallMutation.mutate(entry.userInstallId, { onSuccess, onError })` runs — success closes the modal (and `useRefreshCatalogState()` flips the card via the standard catalog-refresh path), error sticks the server-supplied message into `uninstallError` so it renders inline above the action buttons. Closing the modal while pending is blocked (no double-clicks, no race against the in-flight POST)
- **Open Agent** (right-aligned, outlined styling) — href built from `serverUrl.data` + `entry.userInstallId` as `{serverUrl}/agent/{userInstallId}` and opened via the shared `system.openExternal` IPC. Hidden until `serverUrl.data` resolves, so we never produce a broken link

### `CatalogUninstallModal`
Pure presentational. Receives `agentName`, `pending`, `errorMessage`, `onConfirm`, `onClose` from `CatalogCardFooter`. Wording mirrors `frontend/src/components/Agents/UninstallAgent.tsx` in cinna-core so the desktop and web confirmations read identically. Backdrop click + close button are no-ops while `pending` is true so an in-flight uninstall can't be abandoned mid-request.

### `CatalogSetupModal`
- Mounts `useSetupStatus({ installId, poll: true })` and `useSetupCredentials(installId)`
- Joins server-side missing items (by `specName`) with desktop-side placeholder credentials (by `name`) to resolve per-credential UUIDs
- Renders one `CredentialStatusCard` per missing item: amber dot + open-in-browser icon for user placeholders, red dot + disabled for `publisher_credential_*`
- Footer shows a permanent "Auto-refreshing every 3 seconds" line and an "Open on server" button derived from `status.setupUrl` (with a `cinnaServerUrl` + `/agent/{id}#credentials` fallback)
- `useEffect` on `status.data?.status === 'ready'` triggers the `onReady` callback (parent fires the success toast, closes the modal, and runs `useRefreshCatalogState()` to reconcile both catalog and agents)

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
- `install-context` proxy is bisected at the projection layer: `quickInstall` consumes the raw shape (which carries `suggested_credential_id` UUIDs needed to build the install body) entirely inside the main process, while `getInstallContext` re-projects the response into `InstallContextDto` and *drops* the UUIDs so the renderer-facing surface only carries a `hasSuggestedMatch: boolean` per spec
- `CinnaApiError` codes survive serialization via `_wrap.ts` so the renderer can branch on `err.code === 'reauth_required'` instead of regex-matching error strings
- The server-supplied `setup_url` is treated as the authoritative frontend host; the desktop never substitutes its own host (matches the trust model used by existing cinna-server deep links in `JobRunRow.tsx` / `CinnaTaskRunView.tsx`)
