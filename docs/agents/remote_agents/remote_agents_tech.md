# Remote Agents — Technical Details

## File Locations

### Main Process

| Purpose | File |
|---------|------|
| Periodic sync runner | `src/main/agents/remote-sync.ts` — owns the 5-minute timer + `runSyncOnce()`; delegates fetch + DB work to `agentService` |
| Sync logic (fetch + transactional upsert/prune) | `src/main/services/agentService.ts` — `agentService.syncRemoteAgents()` |
| Transactional remote upsert/prune | `src/main/db/agents.ts` — `agentRepo.syncRemote(userId, targets)` |
| A2A client (shared) | `src/main/agents/a2a-client.ts` |
| IPC handlers (CRUD + sync) | `src/main/ipc/agent.ipc.ts` |
| IPC handlers (A2A + JWT routing) | `src/main/ipc/agent_a2a.ipc.ts` |
| User activation (sync trigger) | `src/main/auth/activation.ts` |
| JWT token management | `src/main/auth/cinna-tokens.ts` |
| DB schema | `src/main/db/schema.ts` — `agents` table (remote columns) |
| DB migration | `src/main/db/migrations/agents.ts` — `migrateAgents()` (remote columns) |

### Preload

| Purpose | File |
|---------|------|
| Bridge API (manual sync) | `src/preload/index.ts` — `api.agents.syncRemote()` |
| Bridge API (sync event) | `src/preload/index.ts` — `api.agents.onRemoteSyncComplete(handler)` |
| Type definition | `src/preload/index.ts` — `AgentData` interface (remote fields) |

### Renderer

| Purpose | File |
|---------|------|
| Sync mutation hook | `src/renderer/src/hooks/useAgents.ts` — `useSyncRemoteAgents()` |
| Sync-complete listener | `src/renderer/src/hooks/useAgents.ts` — `useAgents()` auto-invalidation via `onRemoteSyncComplete` |
| Settings section (remote grouping) | `src/renderer/src/components/settings/AgentsSettingsSection.tsx` |
| Agent card (remote mode) | `src/renderer/src/components/settings/AgentCard.tsx` |
| Agent selector (categorized) | `src/renderer/src/components/chat/AgentSelector.tsx` |
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
| `agent:sync-remote` | handle | — | `{ success, synced?, removed?, error? }` |
| `agent:list` | handle | — | `AgentData[]` — now includes `source`, `remoteTargetType`, `remoteTargetId`, `remoteMetadata` |
| `agent:delete` | handle | `agentId` | Returns `{ success: false, error }` for `source='remote'` agents |
| `agents:remote-sync-complete` | send (main→renderer) | — | Fired after each successful remote sync (initial and periodic) |

Existing channels (`agent:send-message`, `agent:test`, `agent:fetch-card`) work unchanged for remote agents — the JWT routing is handled internally.

## Services & Key Methods

### Sync Logic — `src/main/services/agentService.ts`

- `agentService.syncRemoteAgents(userId)` — Returns `{ synced: 0, removed: 0 }` for non-Cinna users. Otherwise: fetches a fresh JWT via `getCinnaAccessToken(userId)`, GETs `{cinnaServerUrl}/api/v1/external/agents`, validates each target's `target_type` (one of `agent`, `app_mcp_route`, `identity`) and `target_id` (UUID v1–v5), then delegates the transactional upsert/prune to `agentRepo.syncRemote()`. Re-throws `CinnaReauthRequired` so the periodic loop can stop on revoked tokens.

### Transactional Repo — `src/main/db/agents.ts`

- `agentRepo.syncRemote(userId, targets)` — Single Drizzle transaction that upserts each target (using deterministic ID `remote:{target_type}:{target_id}`) and deletes any local rows with `source='remote'` not in the incoming set. Returns `{ synced, removed }`.

### Periodic Runner — `src/main/agents/remote-sync.ts`

- `runSyncOnce(userId)` — Calls `agentService.syncRemoteAgents()`, then notifies the renderer via `agents:remote-sync-complete`. On `CinnaReauthRequired`, stops the periodic timer and notifies with `{ error: 'reauth_required' }`. On other errors, notifies with `{ error: 'sync_failed' }` but keeps the timer running.
- `startPeriodicSync(userId)` — Starts a 5-minute interval that calls `runSyncOnce()`. Stops any existing interval first.
- `stopPeriodicSync()` — Clears the periodic sync interval.

### JWT Resolution — `src/main/services/agentService.ts`

- `agentService.resolveAccessToken(userId, agent)` — For `source='remote'`: calls `getCinnaAccessToken(userId)` to get a fresh JWT. For `source='local'`: decrypts `agent.accessTokenEncrypted`. Used by both `agent:send-message` and `agent:test` IPC handlers.
- `agentService.resolveEndpointIfNeeded(userId, agent)` — When a remote agent has no cached `endpointUrl`, fetches the card to resolve the protocol endpoint, then caches `endpointUrl`, `protocolInterfaceUrl`, and `protocolInterfaceVersion` via `agentRepo.updateResolvedEndpoint()`. Subsequent messages use the cached endpoint.

### Activation — `src/main/auth/activation.ts`

- `activate(userId)` — Calls `_startRemoteSync()` after providers are loaded.
- `_startRemoteSync(userId)` — Checks if user is `cinna_user` with `cinnaServerUrl`, then fires `runSyncOnce(userId)` (non-blocking) and `startPeriodicSync(userId)`. The runner is responsible for broadcasting `agents:remote-sync-complete`.
- `deactivate()` — Calls `stopPeriodicSync()` before clearing providers.

## Renderer Components

- `AgentsSettingsSection` — Splits agents into remote (grouped by target type: My Agents / Shared with Me / People) and local sections. Remote section shown only for `cinna_user`. Includes "Sync" button that calls `useSyncRemoteAgents()`.
- `AgentCard` — Detects `agent.source === 'remote'` to: show "Remote" badge, hide delete button, hide access token section (JWT is automatic).
- `AgentSelector` — Groups enabled agents into sections based on `source` and `remoteTargetType`. Shows section headers only when multiple sections exist.
- `useAgents()` — Subscribes to `onRemoteSyncComplete` via `useEffect`, calling `queryClient.invalidateQueries({ queryKey: ['agents'] })` on each event. This ensures agent list auto-refreshes after initial and periodic syncs without manual action.

## Security

- **JWT-based auth** — Remote agents authenticate with the user's Cinna JWT, not a per-agent token. The JWT is fetched fresh at send time via `getCinnaAccessToken()`, which handles auto-refresh within 60s of expiry.
- **No token storage** — Remote agents have `accessTokenEncrypted = null`. The JWT is never persisted in the agents table.
- **Backend access control** — The backend re-verifies agent accessibility on every A2A request (ownership, route effectiveness, binding validity), so stale local agent entries cannot be used to bypass revocations.
