# Remote Agents — Technical Details

For manually added ACP WebSocket connections, see [Remote ACP agents](remote_acp.md). The automatic discovery and synchronization described below uses A2A.

## File Locations

### Main Process

| Purpose | File |
|---------|------|
| Periodic sync runner | `src/main/agents/remote-sync.ts` — owns the 5-minute timer + `runSyncOnce()`; delegates fetch + DB work to `agentService` |
| Sync logic (fetch + transactional upsert/prune) | `src/main/services/agentService.ts` — `agentService.syncRemoteAgents()` |
| Transactional remote upsert/prune | `src/main/db/agents.ts` — `agentRepo.syncRemote(userId, targets)` |
| A2A client (shared) | `src/main/agents/a2a-client.ts` |
| Server deletion | `src/main/services/remoteAgentActions.ts` — profile-owned cached target validation and server-first delete |
| Shared eligibility | `src/shared/agentDevelopment.ts` — `canDevelopAgent`; `src/shared/agentPresentation.ts` — `isBundleAgent` |
| IPC handlers (CRUD + sync) | `src/main/ipc/agent.ipc.ts` |
| IPC handlers (A2A + JWT routing) | `src/main/ipc/agent_a2a.ipc.ts` |
| User activation (sync trigger) | `src/main/auth/activation.ts` |
| JWT token management | `src/main/auth/cinna-tokens.ts` |
| DB schema | `src/main/db/schema.ts` — `agents` table (remote columns) |
| DB migration | `src/main/db/migrations/agents.ts` — `migrateAgents()` (remote columns) |

### Preload

| Purpose | File |
|---------|------|
| Bridge API (server delete) | `src/preload/index.ts` — `api.agents.deleteRemote(agentId)` |
| Bridge API (manual sync) | `src/preload/index.ts` — `api.agents.syncRemote()` |
| Bridge API (sync event) | `src/preload/index.ts` — `api.agents.onRemoteSyncComplete(handler)` |
| Type definition | `src/preload/index.ts` — `AgentData` interface (remote fields) |

### Renderer

| Purpose | File |
|---------|------|
| Sync mutation hook | `src/renderer/src/hooks/useAgents.ts` — `useSyncRemoteAgents()` |
| Sync-complete listener | `src/renderer/src/hooks/useAgents.ts` — `useAgents()` auto-invalidation via `onRemoteSyncComplete` |
| Shared agent page and actions | `src/renderer/src/components/agents/ExternalAgentPage.tsx`, `src/renderer/src/components/agents/ExternalAgentActionsMenu.tsx` |
| Desktop visibility | `src/renderer/src/hooks/useAgentDesktopVisibility.ts`, `src/renderer/src/utils/agentNavigation.ts` |
| Settings section (server visibility) | `src/renderer/src/components/settings/AgentsSettingsSection.tsx` |
| Agent card (remote mode) | `src/renderer/src/components/settings/AgentCard.tsx` |
| In-chat agent picker | `src/renderer/src/components/chat/AgentMentionPopup.tsx` (`@`-mention) + `src/renderer/src/components/agents/AgentPickerModal.tsx` (Capability Picker) |
| Auth store (user type check) | `src/renderer/src/stores/auth.store.ts` |

## Database Schema

**Table:** `agents` — extended columns for remote agents (migration: `src/main/db/migrations/agents.ts`)

| Column | Type | Notes |
|--------|------|-------|
| `source` | TEXT NOT NULL | `'local'` (default) or `'remote'` |
| `remote_target_type` | TEXT | `'agent'`, `'app_mcp_route'`, or `'identity'` |
| `remote_target_id` | TEXT | UUID from the Cinna backend |
| `remote_metadata` | TEXT (JSON) | `{ entrypoint_prompt, example_prompts, session_mode, ui_color_preset, protocol_versions, ...target.metadata }` |

Remote agents use deterministic IDs: `remote:{target_type}:{target_id}` — ensures stable identity across syncs without needing a separate mapping table.

## IPC Channels

| Channel | Type | Params | Returns |
|---------|------|--------|---------|
| `agent:sync-remote` | handle | — | `{ success, synced?, removed?, error? }`. Also emits `agents:remote-sync-complete` (success → `{}`, reauth → `{ error: 'reauth_required' }`, other failure → `{ error: 'sync_failed' }`) via `notifyRemoteSyncComplete`, so a renderer-triggered sync refreshes the UI identically to the periodic runner |
| `agent:list` | handle | — | `AgentData[]` — now includes `source`, `remoteTargetType`, `remoteTargetId`, `remoteMetadata` |
| `agent:delete` | handle | `agentId` | Returns `{ success: false, error }` for `source='remote'` agents; direct connections use this channel |
| `agent:delete-remote` | handle | nonempty `agentId: string` | `{ success: true }`; requires activation, resolves profile internally, throws failures and broadcasts `agents:remote-sync-complete` after success |
| `agents:remote-sync-complete` | send (main→renderer) | — | Fired after **every** successful (or failed) remote sync — initial activation, the 5-minute periodic tick, **and** the on-demand `agent:sync-remote` IPC handler. The single refresh signal `useAgents` listens on |

Shared run:start/watch and agent test/discovery work for remote agents; the A2A driver owns JWT routing.

## Services & Key Methods

### Server Deletion and Desktop Visibility

- `src/main/services/remoteAgentActions.ts:deleteRemoteAgent(userId, agentId)` uses `agentRepo.getOwned`, requires `source=remote`, `remoteTargetType=agent` and a target ID, and rejects `isBundleAgent`. It sends DELETE `/api/v1/agents/{encoded remoteTargetId}` through `cinnaFetch`, then deletes the local row and forgets readiness. Server failure leaves the row intact. The cached ID selects the request target; the renderer supplies neither a server URL nor server target ID.
- `src/shared/agentPresentation.ts` — `isBundleAgent` recognizes `bundle_uuid` or `bundle_id`, only on remote agent targets, excluding explicit publisher installs. The header routes these to `useUninstallBundle`; other remote removal is offered only when `canDevelopAgent` passes. Main deletion deliberately leaves developer-role/ownership enforcement to the server rather than treating UI metadata as authorization.
- `useDeleteAgent` throws on returned `{success:false}` as well as IPC rejection. `useDeleteRemoteAgent` invalidates agents/catalog after success; the IPC broadcast refreshes other listeners. A successful removal clears the selected external agent only if profile and selection still match.
- `useAgentDesktopVisibility` rejects disabling non-remote connections; old disabled direct rows can still be enabled. It snapshots sidebar order before the optimistic mutation, invalidates agent-status on success, and uses `nextAgentAfterHiding` for the selected page. Profile and current-view checks protect unrelated navigation. Enabled folders remain candidates even when they cannot run yet; current cache filtering excludes remote rows hidden during the request.

### Sync Logic — `src/main/services/agentService.ts`

- `agentService.syncRemoteAgents(userId)` — Returns `{ synced: 0, removed: 0 }` for non-Cinna users. Otherwise: fetches a fresh JWT via `getCinnaAccessToken(userId)`, GETs `{cinnaServerUrl}/api/v1/external/agents`, validates each target's `target_type` (one of `agent`, `app_mcp_route`, `identity`) and `target_id` (UUID v1–v5), then delegates the transactional upsert/prune to `agentRepo.syncRemote()`. Re-throws `CinnaReauthRequired` so the periodic loop can stop on revoked tokens.

### Transactional Repo — `src/main/db/agents.ts`

- `agentRepo.syncRemote(userId, targets)` — Single Drizzle transaction that upserts each target (using deterministic ID `remote:{target_type}:{target_id}`) and deletes any local rows with `source='remote'` not in the incoming set. Returns `{ synced, removed }`.

### Periodic Runner — `src/main/agents/remote-sync.ts`

- `runSyncOnce(userId)` — Calls `agentService.syncRemoteAgents()`, then notifies the renderer via `agents:remote-sync-complete`. On `CinnaReauthRequired`, stops the periodic timer and notifies with `{ error: 'reauth_required' }`. On other errors, notifies with `{ error: 'sync_failed' }` but keeps the timer running.
- `notifyRemoteSyncComplete(payload?)` — **Exported** broadcast helper (`webContents.send('agents:remote-sync-complete', payload)`). Used by `runSyncOnce` (periodic/activation) AND by the `agent:sync-remote` IPC handler (`src/main/ipc/agent.ipc.ts`) so on-demand renderer-triggered syncs notify identically. Without the IPC handler calling this, a renderer-invoked sync writes the DB but never tells the renderer to refetch `['agents']` — leaving stale agent rows (e.g. a just-applied bundle update still showing "Update available").
- `startPeriodicSync(userId)` — Starts a 5-minute interval that calls `runSyncOnce()`. Stops any existing interval first.
- `stopPeriodicSync()` — Clears the periodic sync interval.

### JWT Resolution — `src/main/agents/drivers/a2aConnection.ts`

- `resolveAccessToken(userId, agent)` — decided by `capabilitiesFor(agent).auth` rather than by `source`:
  - `cinna` (a synced agent) calls `getCinnaAccessToken(userId)` for a fresh JWT
  - `token` (a hand-added agent with a stored token) decrypts `agent.accessTokenEncrypted`
  - anything else returns `undefined`

  It is used by the A2A driver's turn pre-flight and readiness check (so by main run dispatch, the orchestrator’s agent tool and `agent:check-readiness`), and by `agentService.testAgent` behind `agent:test`.
- `resolveEndpointIfNeeded(userId, agent)` — When a synced agent has no cached `endpointUrl`, fetches the card to resolve the protocol endpoint, then caches `endpointUrl`, `protocolInterfaceUrl`, and `protocolInterfaceVersion` via `agentRepo.updateResolvedEndpoint()`. Subsequent messages use the cached endpoint. It returns `null` for a folder agent (`capabilities.cwd`), and a hand-added agent with no endpoint must be tested first.

### Activation — `src/main/auth/activation.ts`

- `activate(userId)` — Calls `_startRemoteSync()` after providers are loaded.
- `_startRemoteSync(userId)` — Checks if user is `cinna_user` with `cinnaServerUrl`, then fires `runSyncOnce(userId)` (non-blocking) and `startPeriodicSync(userId)`. The runner is responsible for broadcasting `agents:remote-sync-complete`.
- `deactivate()` — Calls `stopPeriodicSync()` before clearing providers.

## Renderer Components

- `AgentsSettingsSection` — Filters `source === 'remote'`, groups under `serverLabel(currentUser.cinnaServerUrl)`, and retains disabled rows with Enable. Enabled rows open the agent in Settings mode. Includes sync/reauthentication controls for the active Cinna profile; it has no default-scope variant or direct connection forms.
- `ExternalAgentPage` uses `AgentCard(connectionOnly)` for A2A Connection; the Authentication section explains active-profile JWT use without a token editor. Overview owns skills. Header More actions owns visibility and removal.
- `AgentMentionPopup` / `AgentPickerModal` — In-chat agent selection (the `@`-mention popup and the Capability Picker). Remote agents surface here once synced; target type remains metadata; the profile visibility list uses one server-domain group.
- `useAgents()` — Subscribes to `onRemoteSyncComplete` via `useEffect`, calling `queryClient.invalidateQueries({ queryKey: ['agents'] })` on each event (and mirroring `payload.error` into the shared sync-status cache). This auto-refreshes the agent list after **any** sync — initial, periodic, or on-demand — without manual invalidation. Callers that trigger a sync (`useRefreshCatalogState`, `useApplyBundleUpdate`) deliberately rely on this broadcast instead of invalidating `['agents']` directly, avoiding a stale-read race during the sync window.

## Security

- **JWT-based auth** — Remote agents authenticate with the user's Cinna JWT, not a per-agent token. The JWT is fetched fresh at send time via `getCinnaAccessToken()`, which handles auto-refresh within 60s of expiry.
- **No token storage** — Remote agents have `accessTokenEncrypted = null`. The JWT is never persisted in the agents table.
- **Backend access control** — The backend re-verifies agent accessibility on every A2A request (ownership, route effectiveness, binding validity), so stale local agent entries cannot be used to bypass revocations.
