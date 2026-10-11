# Bundle Updates — Technical Reference

Cross-cutting technical reference for detecting that an installed bundle is behind the publisher's latest revision and applying the update in-app. Business behavior lives in [Bundles Catalog → Update Available](./bundles_catalog.md#update-available); this file documents the implementation, which spans the **catalog** and **agents** domains plus a shared Cinna HTTP client.

## Data Source: the sync first, the listing before it

The version state rides the **agent-sync feed**:

- `GET /api/v1/external/agents` attaches a `bundle_version` object to each consumer-install target (`installed_version` / `installed_revision_number`, `latest_version` / `latest_revision_number`, `update_available`, `update_mode`, `last_update_status`). Present only for the caller's own consumer installs (`target_type='agent'`, has `bundle_uuid`, `is_publisher_install=false`); `null` otherwise. Server-computed read-only (discovery never mutates `pending_update`).
- Before an install has synced into an agent row, the catalog's item listing (`GET /api/v1/catalog/items`) is the **fallback**: the caller's install in the item's `my_installs` has a `revision_number`, and an install below the item's `latest.revision_number` is behind. The listing can flag an update but carries no `update_mode`, so the catalog offers **Update** whatever the mode.

Server reference: `workflow-runner-core/backend/app/models/external/external_agents.py` (`BundleVersionInfo`), `ExternalAgentCatalogService.build_bundle_version_info`, and the native routes in `backend/app/api/routes/external_agents.py`.

## File Locations

### Shared
- `src/shared/agentMetadata.ts` — `BundleVersionInfo` interface; `RemoteAgentMetadata.bundle_version` field (the data carrier persisted on synced agents)
- `src/shared/catalogItems.ts` — `CatalogInstallWire.revision_number` and `CatalogLatestWire.revision_number` (the fallback comparison)

### Main Process
- `src/main/services/cinna-http.ts` — shared authenticated Cinna HTTP client (`cinnaFetch`, `resolveBaseUrl`); used by both `agentService` and `catalogService`
- `src/main/services/agentService.ts` — `ExternalTarget.bundle_version` ingest field; sync mapping carries `bundle_version` into `remoteMetadata`; `applyBundleUpdate(userId, installId)`
- `src/main/ipc/agent.ipc.ts` — `agent:apply-bundle-update` handler
- `src/main/errors.ts` — `AgentErrorCode` gains `update_failed`
- `src/main/services/inboxService.ts` — `list()` appends `cloudUpdateItems()` to the desktop agents' items in `InboxSnapshot.updates`
- `src/main/agents/cloudUpdateFollow.ts` — `installCloudUpdateFollow()`: a listing naming a newer revision of an installed cloud agent runs the remote agents' sync once (`libraryService.onListingChanged` → `runSyncOnce`)

### Preload
- `src/preload/index.ts` — `window.api.agents.applyBundleUpdate(installId)` typed binding (the catalog namespace has no apply-update method — the action is agents-scoped)

### Renderer
- `src/renderer/src/utils/bundleVersion.ts` — `deriveBundleUpdate(bundleVersion)` → `BundleUpdateState` (`updateAvailable`, `installedLabel`, `latestLabel`); the agent page's label/gate derivation
- `src/renderer/src/hooks/useAgents.ts` — `useApplyBundleUpdate()` mutation
- `src/renderer/src/components/settings/AgentCard.tsx` — Connection update banner from `agent.remoteMetadata.bundle_version`
- `src/renderer/src/hooks/useCatalogEntries.ts` (`catalogEntryViews`: `updateAvailable`), `src/renderer/src/components/agents/CatalogItemViews.tsx` — the catalog's **Update** on a Runs in Cinna tile and detail, in the dialog and Settings → Catalog; `src/renderer/src/hooks/useCatalogActions.ts` owns its `useApplyBundleUpdate` (see [Bundles Catalog tech](./bundles_catalog_tech.md#the-shared-catalog-entries-actions-parts))
- `src/main/services/cloudUpdateNotices.ts` — `cloudUpdateItems(profileUserId?)`, the Inbox's cloud **Update available** cards; `src/renderer/src/components/inbox/InboxUpdateCard.tsx` — `UpdateAvailableCard`, whose Update for a cloud agent is `useApplyBundleUpdate`

## Database Schema

None new. `bundle_version` is persisted inside the existing `agents.remote_metadata` JSON column (written by `agentRepo.syncRemote`). The sync mapping omits the key entirely when the server doesn't send it, so an older server never nulls a previously-synced value mid-rollout.

## IPC Channels

| Channel | Args | Returns |
|---------|------|---------|
| `agent:apply-bundle-update` | `installId: string` | `{ success: boolean; bundleVersion?: BundleVersionInfo; code?: string; error?: string }` |

Inline error shape mirrors `agent:sync-remote`. `installId` is the cinna-server Agent UUID — i.e. the `install_id` in a catalog item's `my_installs` or a synced agent's `remoteTargetId` (both the same value). Gated by `userActivation.requireActivated()` + `getProfileScopeUserId()`.

## Services & Key Methods

### `agentService.applyBundleUpdate(userId, installId)` (`src/main/services/agentService.ts`)
- Validates `installId` against `UUID_RE`, throwing `AgentError('invalid_id')` before any request is built
- `POST /api/v1/external/agents/{installId}/apply-update` via the shared `cinnaFetch` → returns the post-update `BundleVersionInfo` snapshot
- Logs `apply bundle update start` / `done` (with `installedRevision`, `latestRevision`, `durationMs`) / `failed` (with the `CinnaApiError.code`)
- Error contract inherited from `cinnaFetch`: 401/403 → `CinnaApiError('reauth_required')`, other non-2xx → `request_failed`. The renderer can branch on `err.code === 'reauth_required'` **because the handler returns the code as data, not because it survives a throw**: `agent:apply-bundle-update` catches internally, calls `ipcErrorShape(err)`, and returns `{success:false, code, error}`, which `useApplyBundleUpdate` turns back into a `code`-tagged `Error` renderer-side. A thrown `DomainError` loses its `code` at two boundaries — see [Main-Process Layering](../../development/main_layering/main_layering_llm.md). This distinction is load-bearing: `catalog:items`, `catalog:item` and `catalog:quick-install` return a `CatalogOutcome` for the same reason (the list's and the install's `reauth_required` branches were dead until 17 Sep 2026, when they still threw), while the other `catalog:*` channels still throw — see Security in [Bundles Catalog tech](./bundles_catalog_tech.md)
- Server applies the latest revision in place (stop env → swap bundle folders → restart → refresh prompts); per-bundle App Data + credentials preserved

### `cinnaFetch<T>(userId, path, opts)` (`src/main/services/cinna-http.ts`)
- The single Cinna HTTP client, extracted from `catalogService` so both services share auth, error mapping, and latency logging (scope `cinna-http`). See [Bundles Catalog tech](./bundles_catalog_tech.md) for the full error-mapping table

### `deriveBundleUpdate(bundleVersion)` (`src/renderer/src/utils/bundleVersion.ts`)
- Pure helper. Produces `updateAvailable` (trusts `bundle_version.update_available`) and the `installedLabel` / `latestLabel` strings (`v<version>` preferred, `rev <n>` fallback, `null` when neither known). Used by `AgentCard`; the catalog's **Update** needs only the gate, which it reads from `bundle_version.update_available` directly

### `useApplyBundleUpdate()` (`src/renderer/src/hooks/useAgents.ts`)
- Mutation over `window.api.agents.applyBundleUpdate`; rejects with a `code`-tagged `Error` so callers branch on `reauth_required`
- `onSuccess`: invalidates `['catalog']` and fires `window.api.agents.syncRemote()`. Deliberately does **not** invalidate `['agents']` directly — the sync's `agents:remote-sync-complete` broadcast does it once the fresh `bundle_version` has landed, avoiding the stale-read race (same rule as `useRefreshCatalogState`)
- The catalog's and the agent page's update state is driven by the synced `bundle_version`, so refreshing it depends on `['agents']` being invalidated. The `agent:sync-remote` IPC handler now emits `agents:remote-sync-complete` via `notifyRemoteSyncComplete` (`src/main/agents/remote-sync.ts`) — previously only the periodic/activation runner did, so a renderer-triggered sync wrote the DB but never told the renderer to refetch, leaving the "Update available" affordance stuck on screen after a successful update
- Note: the desktop does not call the server's `POST /external/agents/{id}/check-updates` route — the discovery snapshot (`bundle_version` on sync) is the only update-state source the UI reads

## Renderer Components

### `AgentCard`
- Reads `agent.remoteMetadata.bundle_version` directly; `showUpdate = isBundleInstall && bundleUpdate.updateAvailable`
- The routed agent page passes `connectionOnly`: its legacy header pills are hidden, and Profile → Agents renders visibility rows instead of cards.
- Settings → Connection: amber banner "Bundle update available · v1.0 → v1.2" + "Update to v\<latest>" button (`useApplyBundleUpdate`, `applyUpdate.isPending` spinner). `updateError` local state renders inline; `reauth_required` code maps to a re-auth message

### Catalog tile and detail (the dialog and Settings → Catalog)
- The **Update** on a Runs in Cinna tile or detail reads the synced row's `bundle_version.update_available` (the row found by `remoteTargetId` = the install id), and before the agent has synced, the listing's own numbers: the install's `revision_number` below the item's `latest.revision_number`. It is offered whatever the `update_mode`. Its busy state and failure come from the `useApplyBundleUpdate` that `useCatalogActions` holds for the surface's host; all Updates wait while one runs

### Inbox card (`cloudUpdateItems`)
- One `UpdateAvailableInboxItem` (`target: 'cloud_agent'`, `installId`) per synced remote agent of the active profile (`agentRepo.listRemote`) whose `bundle_version.update_available` is true, whose `update_mode` is not `automatic`, and which has a `remoteTargetId`. A server that applies updates on its own needs no button, so it gets no card
- `version` / `versionLabel` from `bundle_version.latest_revision_number` / `latest_version`, else from the cached listing's item; `changedBy` / `changedAt` from the listing's `latest.published_by` / `published_at`. The item is the one with `kind: agent`, `runs_on` not `desktop` and this install id in `my_installs` — a skill's `my_installs` can carry the id of the agent it is linked to, so matching any kind would borrow a skill's version
- Local reads only, never a request; a failure is logged and is an empty list, never a failed Inbox. Without a cached listing the card still appears, without who and when
- **The sync follows the listing** (`src/main/agents/cloudUpdateFollow.ts`, installed by `initializeHubCore`): `libraryService.onListingChanged` tells it of every listing that moved (the same test as `sharing:changed` / `catalog:items-changed`). When an item with `kind: agent`, `runs_on` not `desktop`, has a `where: 'cloud'` install whose `install_id` is a synced row's `remoteTargetId`, and its `latest.revision_number` is past the row's `bundle_version.latest_revision_number` (else `installed_revision_number`), it calls `runSyncOnce` for that profile, sharing the periodic runner's in-flight guard. A row with no `bundle_version` is skipped. Bounded: one follow-up sync per profile at a time (listings that land meanwhile are looked at once when it ends) and one per install and revision, so a server whose `bundle_version` lags the listing costs one sync per new revision
- `UpdateAvailableCard`'s Update for this target calls `useApplyBundleUpdate(installId)`; success shows **Updated.**, and the next read no longer lists it once the sync has landed the new `bundle_version`. `reauth_required` reads as an expired session; anything else is the message, beside the button

## Security
- The apply-update call runs only in the main process; the Bearer JWT never reaches the renderer. Server owner-gates the install (403 for non-owner) and the desktop validates UUID shape before issuing the request
- `bundle_version` carries no secrets — only revision numbers, version strings, and update flags — so it's safe to persist in `remote_metadata` and surface to the renderer
