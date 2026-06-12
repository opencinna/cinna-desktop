# Bundle Updates — Technical Reference

Cross-cutting technical reference for detecting that an installed bundle is behind the publisher's latest revision and applying the update in-app. Business behavior lives in [Bundles Catalog → Update Available](./bundles_catalog.md#update-available); this file documents the implementation, which spans the **catalog** and **agents** domains plus a shared Cinna HTTP client.

## Data Source: sync, not catalog

The version state rides the **agent-sync feed**, not the catalog list:

- `GET /api/v1/external/agents` attaches a `bundle_version` object to each consumer-install target (`installed_version` / `installed_revision_number`, `latest_version` / `latest_revision_number`, `update_available`, `update_mode`, `last_update_status`). Present only for the caller's own consumer installs (`target_type='agent'`, has `bundle_uuid`, `is_publisher_install=false`); `null` otherwise. Server-computed read-only (discovery never mutates `pending_update`).
- The catalog list (`GET /api/v1/catalog/`) still carries only `user_install_pending_update` (boolean) + `latest_version`. The desktop projects this to `CatalogEntryDto.pendingUpdate` and uses it as a **fallback** when the matching synced agent hasn't loaded yet (the boolean can flag an update but can't name the installed version).

Server reference: `workflow-runner-core/backend/app/models/external/external_agents.py` (`BundleVersionInfo`), `ExternalAgentCatalogService.build_bundle_version_info`, and the native routes in `backend/app/api/routes/external_agents.py`.

## File Locations

### Shared
- `src/shared/agentMetadata.ts` — `BundleVersionInfo` interface; `RemoteAgentMetadata.bundle_version` field (the data carrier persisted on synced agents)
- `src/shared/catalog.ts` — `CatalogEntryDto.pendingUpdate` (fallback boolean from the catalog list)

### Main Process
- `src/main/services/cinna-http.ts` — shared authenticated Cinna HTTP client (`cinnaFetch`, `resolveBaseUrl`); used by both `agentService` and `catalogService`
- `src/main/services/agentService.ts` — `ExternalTarget.bundle_version` ingest field; sync mapping carries `bundle_version` into `remoteMetadata`; `applyBundleUpdate(userId, installId)`
- `src/main/ipc/agent.ipc.ts` — `agent:apply-bundle-update` handler
- `src/main/services/catalogService.ts` — `projectEntry` maps `user_install_pending_update` → `pendingUpdate`
- `src/main/errors.ts` — `AgentErrorCode` gains `update_failed`

### Preload
- `src/preload/index.ts` — `window.api.agents.applyBundleUpdate(installId)` typed binding (the catalog namespace has no apply-update method — the action is agents-scoped)

### Renderer
- `src/renderer/src/utils/bundleVersion.ts` — `deriveBundleUpdate(bundleVersion)` → `BundleUpdateState` (`updateAvailable`, `installedLabel`, `latestLabel`); shared label/gate derivation for both surfaces
- `src/renderer/src/hooks/useAgents.ts` — `useApplyBundleUpdate()` mutation
- `src/renderer/src/components/settings/CatalogSettingsSection.tsx` — joins catalog entries to synced agents' `bundle_version`; `handleUpdate`; `updatingBundleId`
- `src/renderer/src/components/settings/CatalogCard.tsx` — `bundleVersion` prop; the "Update to v\<latest>" header action
- `src/renderer/src/components/settings/AgentCard.tsx` — header "Update" pill + expanded update banner from `agent.remoteMetadata.bundle_version`

## Database Schema

None new. `bundle_version` is persisted inside the existing `agents.remote_metadata` JSON column (written by `agentRepo.syncRemote`). The sync mapping omits the key entirely when the server doesn't send it, so an older server never nulls a previously-synced value mid-rollout.

## IPC Channels

| Channel | Args | Returns |
|---------|------|---------|
| `agent:apply-bundle-update` | `installId: string` | `{ success: boolean; bundleVersion?: BundleVersionInfo; code?: string; error?: string }` |

Inline error shape mirrors `agent:sync-remote`. `installId` is the cinna-server Agent UUID — i.e. the catalog entry's `userInstallId` or a synced agent's `remoteTargetId` (both the same value). Gated by `userActivation.requireActivated()` + `getProfileScopeUserId()`.

## Services & Key Methods

### `agentService.applyBundleUpdate(userId, installId)` (`src/main/services/agentService.ts`)
- Validates `installId` against `UUID_RE`, throwing `AgentError('invalid_id')` before any request is built
- `POST /api/v1/external/agents/{installId}/apply-update` via the shared `cinnaFetch` → returns the post-update `BundleVersionInfo` snapshot
- Logs `apply bundle update start` / `done` (with `installedRevision`, `latestRevision`, `durationMs`) / `failed` (with the `CinnaApiError.code`)
- Error contract inherited from `cinnaFetch`: 401/403 → `CinnaApiError('reauth_required')`, other non-2xx → `request_failed`. `ipcErrorShape` maps the `DomainError.code` through the handler so the renderer still branches on `err.code === 'reauth_required'`
- Server applies the latest revision in place (stop env → swap bundle folders → restart → refresh prompts); per-bundle App Data + credentials preserved

### `cinnaFetch<T>(userId, path, opts)` (`src/main/services/cinna-http.ts`)
- The single Cinna HTTP client, extracted from `catalogService` so both services share auth, error mapping, and latency logging (scope `cinna-http`). See [Bundles Catalog tech](./bundles_catalog_tech.md) for the full error-mapping table

### `deriveBundleUpdate(bundleVersion)` (`src/renderer/src/utils/bundleVersion.ts`)
- Pure helper. Produces `updateAvailable` (trusts `bundle_version.update_available`) and the `installedLabel` / `latestLabel` strings (`v<version>` preferred, `rev <n>` fallback, `null` when neither known). Shared by `CatalogCard` and `AgentCard` so the two surfaces render identical labels

### `useApplyBundleUpdate()` (`src/renderer/src/hooks/useAgents.ts`)
- Mutation over `window.api.agents.applyBundleUpdate`; rejects with a `code`-tagged `Error` so callers branch on `reauth_required`
- `onSuccess`: invalidates `['catalog']` and fires `window.api.agents.syncRemote()`. Deliberately does **not** invalidate `['agents']` directly — the sync's `agents:remote-sync-complete` broadcast does it once the fresh `bundle_version` has landed, avoiding the stale-read race (same rule as `useRefreshCatalogState`)
- The card's update state is driven by the synced `bundle_version`, so refreshing it depends on `['agents']` being invalidated. The `agent:sync-remote` IPC handler now emits `agents:remote-sync-complete` via `notifyRemoteSyncComplete` (`src/main/agents/remote-sync.ts`) — previously only the periodic/activation runner did, so a renderer-triggered sync wrote the DB but never told the renderer to refetch, leaving the "Update available" affordance stuck on screen after a successful update
- Note: the desktop does not call the server's `POST /external/agents/{id}/check-updates` route — the discovery snapshot (`bundle_version` on sync) is the only update-state source the UI reads

## Renderer Components

### `CatalogSettingsSection`
- Builds `bundleVersionByInstall: Map<installId, BundleVersionInfo>` via `useMemo` over `useAgents()` data, keyed by `remoteTargetId` for `source === 'remote'` && `remoteTargetType === 'agent'` agents. Declared before the `!isCinnaUser` early return to keep hook order stable
- Passes `bundleVersion={bundleVersionByInstall.get(entry.userInstallId)}` to each `CatalogCard`
- `handleUpdate(bundleId, installId, displayName)` tracks `updatingBundleId` (one install/update at a time), calls `applyUpdate.mutateAsync(installId)`, toasts success/error (reauth code → re-auth-prompted toast)

### `CatalogCard`
- New `bundleVersion?` prop. `hasUpdate = entry.isInstalled && (bundleVersion ? bundleUpdate.updateAvailable : entry.pendingUpdate)` — trusts the synced snapshot, falls back to the catalog boolean
- When `hasUpdate`: status dot turns amber, the neutral `v<latest>` chip is replaced by an amber `v1.0 → v1.2` transition chip (or "Update available" when only one end is known), and the right-side action becomes an amber **"Update to v\<latest>"** button (`ArrowUpCircle`, → "Update" when no version string). Header slot is the same one the Install button / "Installed" indicator occupy
- Gates on `updating`/`disabled` from the parent

### `AgentCard`
- Reads `agent.remoteMetadata.bundle_version` directly; `showUpdate = isBundleInstall && bundleUpdate.updateAvailable`
- Header: amber "Update" pill next to the green "Bundle" pill when `showUpdate`
- Expanded body: amber banner "Bundle update available · v1.0 → v1.2" + "Update to v\<latest>" button (`useApplyBundleUpdate`, `applyUpdate.isPending` spinner). `updateError` local state renders inline; `reauth_required` code maps to a re-auth message

## Security
- The apply-update call runs only in the main process; the Bearer JWT never reaches the renderer. Server owner-gates the install (403 for non-owner) and the desktop validates UUID shape before issuing the request
- `bundle_version` carries no secrets — only revision numbers, version strings, and update flags — so it's safe to persist in `remote_metadata` and surface to the renderer
