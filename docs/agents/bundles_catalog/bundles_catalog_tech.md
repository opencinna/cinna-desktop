# Bundles Catalog — Technical Reference

## File Locations

### Shared
- `src/shared/catalog.ts` — DTOs (`CatalogEntryDto` incl. `pendingUpdate`, `CatalogCredentialSpec`, `CatalogInstallResultDto`, `InstallContextDto`, `InstallContextSpecDto`, `InstallContextPublisherSummaryDto`, `SetupStatusDto`, `SetupMissingItemDto`, `SetupCredentialSummaryDto`) consumed by the main service, preload bridge, and renderer; plus `CatalogOutcome<T>` and `unwrapCatalogOutcome`, the returned-failure shape of `catalog:list` / `catalog:quick-install` (see Security)
- `src/main/services/cinna-http.ts` — shared Cinna HTTP client (`cinnaFetch`, `resolveBaseUrl`); consumed by both `catalogService` and `agentService`

### Main Process
- `src/main/services/catalogService.ts` — `catalogService` object; proxies catalog + setup endpoints, projects server snake_case → desktop camelCase, hides secrets
- `src/main/ipc/catalog.ipc.ts` — `registerCatalogHandlers()`; thin `ipcHandle(...)` wrappers, no business logic. The module-private `outcome()` wraps `list` and `quick-install`: a `CinnaReauthRequired` (as `reauth_required`) or any `DomainError` is returned as `{success:false, code, message}` with a `warn` log; an uncoded error still throws so `_wrap` logs it as unexpected
- `src/main/ipc/catalog.ipc.test.ts` — pins that shape: success wrapped, a normalised and a raw expired session both returned as `reauth_required`, an uncoded failure still thrown, and the round trip through `unwrapCatalogOutcome` keeping the code
- `src/main/ipc/index.ts` — wires `registerCatalogHandlers` into `registerAllIpcHandlers()`

### Preload
- `src/preload/index.ts` — `window.api.catalog.{list,quickInstall,installContext,uninstall,setupStatus,setupCredentials,serverUrl}` typed bindings

### Renderer
- `src/renderer/src/hooks/useCatalog.ts` — `useCatalog`, `useRefreshCatalogState`, `useQuickInstallBundle`, `useUninstallBundle`, `useInstallContext`, `useSetupStatus`, `useSetupCredentials`, `useCatalogServerUrl` React Query hooks
- `src/renderer/src/components/settings/CatalogSettingsSection.tsx` — Settings → Profile → Catalog page entry point
- `src/renderer/src/components/settings/CatalogCard.tsx` — One expandable card per bundle; renders header + the expanded body wrapper. Composes `CatalogCardCredentials` for the install-context sections and `CatalogCardFooter` for installed-bundle actions
- `src/renderer/src/stores/catalogInstall.store.ts` — `useCatalogInstallStore` (`installingBundleId`, `error: CatalogInstallError | null` keyed by `bundleId`, `pendingSetup: PendingCatalogSetup | null`, `install`, `clearError`, `setPendingSetup`) and `landCatalogInstall(queryClient, agentId, result)`. Scoped logger `catalog-install`
- `src/renderer/src/hooks/useCatalogInstall.ts` — `useCatalogInstall({ onInstalled, onInstalledDetached })`, the component view over the store
- `src/renderer/src/hooks/useCatalogPicker.ts` — the chat picker's wrapper; see [Inline Catalog Install](./inline_install.md)
- `src/renderer/src/components/agents/CatalogBrowserModal.tsx` — the sidebar's Agent catalog dialog. Module-private `CatalogTile`, `EntryAction`, `InstalledPill`, `EmptyState`
- `src/renderer/src/components/agents/CatalogSetupHost.tsx` — renders `CatalogSetupModal` for `pendingSetup`; mounted once in `src/renderer/src/App.tsx` inside `AuthGate`
- `src/renderer/src/components/agents/local/LocalAgentsList.tsx`, `NewLocalAgentModal.tsx` — the entry point (`onCatalog`); see [Agents Tab — Technical Details](../local_agents/agents_tab_tech.md)
- `src/renderer/src/components/settings/CatalogCardCredentials.tsx` — Self-contained subcomponent that owns the install-context React Query subscription, the required-credentials list with per-spec match icons, the AI credentials sibling section, and the error chip + retry. Inline helpers: `ProvidedByBadge`, `TypeBadge`, `CredentialIcon`, `AICredentialsSection`, `AIPublisherRow`
- `src/renderer/src/components/settings/CatalogCardFooter.tsx` — Self-contained footer rendered only for installed bundles; owns `useCatalogServerUrl`, `useUninstallBundle`, and the `CatalogUninstallModal` state. Returns `null` when `entry.userInstallId` is missing
- `src/renderer/src/components/settings/CatalogSetupModal.tsx` — Post-install dialog with credential status cards and 3s polling
- `src/renderer/src/components/settings/CatalogUninstallModal.tsx` — Destructive-action confirmation dialog rendered from `CatalogCardFooter` and nowhere else; mirrors cinna-server's `UninstallAgent` wording. **Settings → Profile → Catalog is therefore the only place a bundle can be uninstalled** — the agent page's ⋯ menu no longer offers it, so a user who reaches an installed agent through the sidebar has no uninstall there
- `src/renderer/src/components/settings/SettingsPage.tsx` — Routes the `profile-catalog` tab to `CatalogSettingsSection`
- `src/renderer/src/components/layout/Sidebar.tsx` — Adds `{ id: 'profile-catalog', label: 'Catalog', icon: Package }` to `profileMenuItems`
- `src/renderer/src/stores/ui.store.ts` — Adds `'profile-catalog'` to `SettingsMenu` and `PROFILE_SCOPE_TABS`

## Database Schema

None. The desktop is a stateless proxy — all bundle, install, and credential rows live on cinna-server. React Query caches the responses in-memory; nothing is persisted to SQLite.

## IPC Channels

| Channel | Args | Returns |
|---------|------|---------|
| `catalog:list` | — | `CatalogOutcome<CatalogEntryDto[]>` |
| `catalog:quick-install` | `bundleId: string` | `CatalogOutcome<CatalogInstallResultDto>` |
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

The Cinna HTTP plumbing lives in the shared `src/main/services/cinna-http.ts` (extracted from this service so `agentService` reuses the same auth + error mapping — see [Bundle Updates tech](./bundle_updates_tech.md)):
- `resolveBaseUrl(userId)` — raises `CinnaApiError('not_cinna_user' | 'missing_server_url')`. Re-exported through `cinnaFetch`'s module and consumed directly by `catalogService.getServerUrl`
- `resolveAuthHeader(userId)` (module-private) — wraps `getCinnaAccessToken()`; translates `CinnaReauthRequired` to `CinnaApiError('reauth_required')`
- `cinnaFetch<T>(userId, path, opts)` — single fetch helper. Maps 401/403 to `reauth_required`, other non-2xx to `request_failed` with a human-readable detail string (parsed via the module-private `extractErrorDetail`: prefers FastAPI's `body.detail`, then `body.message`, falls back to a 200-char raw slice — so the user sees `"Cinna API 400: Cannot uninstall the publisher install…"` instead of the raw JSON envelope). Network errors map to `request_failed`, JSON parse errors to `invalid_response`. Logs request failures + network errors with `durationMs` under the `cinna-http` scope

`catalogService`'s own pure helpers (no I/O):
- `projectEntry`, `projectSpec`, `projectMissing`, `projectInstallContextSpec`, `projectPublisherSummary` — mapping helpers. `projectEntry` also maps `user_install_pending_update` → `CatalogEntryDto.pendingUpdate` (the update-available fallback boolean; see [Bundle Updates tech](./bundle_updates_tech.md))
- `fetchServerInstallContext(userId, bundleId)` — single private wrapper around `GET /api/v1/catalog/{bundle_id}/install-context`. Shared by `quickInstall` (which needs the raw `suggested_credential_id` UUIDs to build the install body) and `getInstallContext` (which re-projects the shape into `InstallContextDto` for the renderer)
- `buildDefaultCredentialsPayload(context, bundleId)`, `buildDefaultAISelections(context)` — pure functions that translate the `ServerInstallContext` response into the `InstallCredentialSelection` + `AICredentialSelections` shapes accepted by `POST /catalog/{bundle_id}/install`. Kept in sync with cinna-core's `useQuickInstall.ts`. `buildDefaultCredentialsPayload` takes `bundleId` only to scope the defensive `warn` log it emits when the server's `install-context` response violates the unique-spec-name invariant

### Renderer Hooks (`src/renderer/src/hooks/useCatalog.ts`)

| Hook | Notes |
|------|-------|
| `useCatalog()` | Query key `['catalog']`; gated on `currentUser?.type === 'cinna_user'`; 60s staleTime; retries up to 3 times, except a `reauth_required` failure, which is never retried so **Re-authenticate** shows at once |
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
5. Errors on both the **install** and the **update** path translate `err.code === 'reauth_required'` to a re-auth-prompted toast. The code is there because both channels return it as data — `catalog:quick-install` as a `CatalogOutcome` that `useQuickInstallBundle` unwraps, `agent:apply-bundle-update` as `{success:false, code, error}` — and any other install failure shows `Install failed: <message>`, the main-process sentence without the IPC prefix — a coded failure arrives clean in the outcome, and an uncoded one (which `outcome()` still throws) is stripped by `unwrapIpcError`

### `CatalogCard`
Thin orchestrator. Owns only the local `expanded` UI state and renders the card header (status dot, name, version, install/installed indicator, expand chevron) plus the expanded body wrapper (description, publisher line, bundle-id pill). Delegates the rest:

- `<CatalogCardCredentials entry={entry} enabled={expanded && !entry.isInstalled} />` for the install-context-driven sections
- `<CatalogCardFooter entry={entry} />` for installed-bundle actions, rendered inside the `AnimatedCollapse` after the body block

The header action has three states: **Install** button (uninstalled), an amber **"Update to v\<latest>"** button (installed + behind latest), or an "Installed" indicator (installed + up to date). The update state is driven by the `bundleVersion` prop (joined from the synced agent) with `entry.pendingUpdate` as fallback — see [Bundle Updates tech](./bundle_updates_tech.md). All states gate on `installing` / `updating` / `disabled` from the parent so only one install or update runs at a time across the whole catalog.

### Sidebar agent catalog

**`useCatalogInstallStore.install({ bundleId, queryClient, onInstalled })`** — returns immediately; the work is an unawaited async block.
1. A module-level `inFlight` flag returns early on a second call. It is not store state because two clicks in one tick both read the pre-`set` state, and the dialog and the picker are separate callers
2. Records `useAuthStore.getState().currentUser?.id`; clears `error`; sets `installingBundleId`
3. `unwrapCatalogOutcome(await window.api.catalog.quickInstall(bundleId))`, then `await window.api.agents.syncRemote()`, then invalidates `['catalog']`
4. Sync `success: false` → `error` = the "Installed, but…" message (its `reauth_required` wording keyed off the **returned** `sync.code`, which does survive IPC); return
5. Invalidates `['agents']` and `fetchQuery(['agents'])` — not `setQueryData`, which would race the `agents:remote-sync-complete` broadcast's own invalidation; finds `remoteTargetId === result.installId` → `onInstalled(agentId, result)`, else `error` = "it will appear after the next sync"
6. `catch` → `error` = the `reauth_required` wording ("Cinna session expired …", keyed off the code the unwrapped outcome carries) or `unwrapIpcError(err, 'Install failed.')` cut to 160 characters
7. Before every `set` after an await, and before `onInstalled`, the profile is re-read; a change logs and returns. `finally` clears `inFlight` and `installingBundleId`

**`useCatalogInstall`** reads the three state fields from the store and returns `install(bundleId)`, which captures both callbacks **at click time** (the chat picker's is bound to the chat on screen, and `ChatInput` switches chats without remounting). `onInstalledDetached` always runs; `onInstalled` runs only while the caller is mounted (a `mounted` ref). The detached callback must touch only stores and the query client.

**`landCatalogInstall`** — returns if there is no profile; sets `agentPageMode: 'chat'`, `activeExternalAgentId`, `activeView: 'external-agent'` on `useUIStore`; then `fetchQuery(['catalog', 'setup-status', installId])`. A status other than `ready`, or a rejected fetch, sets `pendingSetup: { installId, agentName, profileId }` — unless the profile changed during the fetch.

**`CatalogSetupHost`** — returns `null` unless `pendingSetup.profileId` equals the current profile id. The entry is hidden, not cleared, under another profile, so it reappears on switching back. `onClose` clears it; `onReady` clears it and runs `useRefreshCatalogState()`.

**`CatalogBrowserModal`** (props: `onClose`, `installingBundleId`, `installError`, `onInstall`, `onOpen`) — portalled, `role="dialog"` `aria-label="Agent catalog"`, fixed `h-[36rem]`. Escape and a `mousedown` outside close it. Reads `useCatalog()`, `useAgents()` (to map `userInstallId` → local agent id for **Open**), `useRefreshCatalogState()` and `useCinnaReauth()`.
- The header's refresh is icon-only beside the close button — `RefreshCw`, `title` and `aria-label` "Refresh catalog", spinning and disabled while `catalog.isFetching` — styled like the agent status overlay's refresh, so the dialog's title row holds a title and two icons rather than a text button competing with the title
- The grid stays mounted under the detail, `invisible` + `inert` + `aria-hidden`, so its scroll position survives; focus returns to the search field when the detail closes. A `selectedId` whose bundle disappears on refresh falls back to the grid
- Filtering (`matches`) is case-insensitive over `displayName`, `description`, `publisherName`, `publisherHandle`, `bundleId`
- `CatalogTile` is a `role="group"` named by the display name, holding the body button (opens the detail) and the action as siblings — not a button inside a button. The error renders last in the tile so the button that caused it does not move
- `EntryAction`: uninstalled → **Install** (disabled while any install runs, titled "Another agent is installing" on the others; "Installing…" spinner on its own); installed → **Installed** pill plus **Open** when a synced agent exists. The detail passes `useSettleGuard(selectedId)`; each click checks `isUnsettledClick`
- The detail renders `CatalogCardCredentials` with `enabled={!selected.isInstalled}` and `compact`
- `LocalAgentsList` runs the install and passes the state in, so closing the dialog mid-install loses nothing

### `CatalogCardCredentials`
Takes an optional `compact` prop (default `false`) that drops its body text from `text-[12px]` to `text-[11px]` for the Agent catalog dialog's detail; the inner `AICredentialsSection` and `AIPublisherRow` receive it as `text`.

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

### Where uninstall is reachable from

`CatalogCardFooter` is the only caller of `useUninstallBundle` and `CatalogUninstallModal`. `src/renderer/src/components/agents/ExternalAgentActionsMenu.tsx` no longer imports either: a server-hosted agent's ⋯ menu offers **Open on the server** and the Desktop visibility switch, and nothing destructive ([Remote Agents](../remote_agents/remote_agents.md)). Uninstall undoes an install and belongs with it.

`src/shared/agentPresentation.ts` — `isBundleAgent` requires a remote `agent` target carrying `bundle_uuid` **and** `is_publisher_install === false`. `bundle_id` is not a bundle marker: cinna-server generates one for every agent at creation and it is non-nullable, so the former `bundle_uuid || bundle_id` read counted brand-new self-created agents as consumer installs. With the server-deletion path gone, the predicate's only remaining job is `canDevelopAgent`, whose complement it is. Profile → Agents has visibility rows, not expanded bundle cards.

### `CatalogUninstallModal`
Pure presentational. Receives `agentName`, `pending`, `errorMessage`, `onConfirm`, `onClose` from `CatalogCardFooter`, its only caller. It declares `role=dialog`, `aria-modal=true` and an agent-specific accessible name. Wording mirrors `frontend/src/components/Agents/UninstallAgent.tsx` in cinna-core so the desktop and web confirmations read identically. Backdrop click + close button are no-ops while `pending` is true so an in-flight uninstall can't be abandoned mid-request.

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
- **`CinnaApiError` codes do NOT survive a thrown rejection, and this doc used to claim they did.** `ipcMain.handle` serialises a rejection to message + stack and `contextBridge` re-clones it, so `_wrap.ts`'s re-attached `code` never reaches the renderer — `_wrap.ts` states this and records the same false claim being fixed there. Corrected at `12686f0` on 4 Sep 2026 by reading `_wrap.ts`, `catalog.ipc.ts` and `agent.ipc.ts` (`agent:apply-bundle-update`, now at line 146). See [Main-Process Layering](../../development/main_layering/main_layering_llm.md). Where a code *is* available to the renderer it is because the handler **returned** it rather than threw it:
  - `agent:apply-bundle-update` (`agent.ipc.ts:146`) catches internally and returns `{success:false, code, error}`; `useApplyBundleUpdate` (`useAgents.ts:293`) rebuilds the `Error` renderer-side and sets `.code`. **`settings/AgentCard.tsx:132` and `CatalogSettingsSection.tsx:139` therefore work.**
  - `agent:sync-remote` (`agent.ipc.ts`) catches `CinnaReauthRequired` and returns `{success:false, code:'reauth_required'}`; the install store's post-install sync message (`catalogInstall.store.ts:99`) therefore works.
  - `catalog:list` and `catalog:quick-install` return a `CatalogOutcome` through `outcome()`, and the renderer calls `unwrapCatalogOutcome` **after** the `contextBridge` crossing — in `useCatalog`'s `queryFn`, `useQuickInstallBundle`'s `mutationFn` and the install store — so the rebuilt `Error` keeps its `code`. **The `reauth_required` branches in `CatalogSettingsSection.tsx:108` and `:198`, `CatalogBrowserModal.tsx:164` and `catalogInstall.store.ts:148` therefore work.** Until 17 Sep 2026 both channels threw and all four branches were dead — an expired session got **Retry** instead of **Re-authenticate** and a server message instead of *"Cinna session expired …"* — while `CatalogBrowserModal.test.tsx` passed on a mock that attached `code` to the rejection by hand; it now mocks the outcome. A returned `success:false` with the re-auth code still raises the app-wide modal: `_wrap`'s `isReauthResult` checks returned values, not only thrown ones.
  - The other `catalog:*` channels — `install-context`, `uninstall`, `setup-status`, `setup-credentials`, `server-url` — are bare `ipcHandle`s that let the `CinnaApiError` throw. Their failures are shown only as sentences; a code branch on one of them would be dead until the channel is moved to `outcome()`.
- The server-supplied `setup_url` is treated as the authoritative frontend host; the desktop never substitutes its own host (matches the trust model used by existing cinna-server deep links in `JobRunRow.tsx` / `CinnaTaskRunView.tsx`)
