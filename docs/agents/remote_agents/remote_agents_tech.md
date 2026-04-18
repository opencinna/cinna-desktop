# Remote Agents — Technical Details

## File Locations

### Main Process

| Purpose | File |
|---------|------|
| Remote sync service | `src/main/agents/remote-sync.ts` |
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

### Remote Sync — `src/main/agents/remote-sync.ts`

- `syncRemoteAgents(userId)` — Fetches `GET {cinnaServerUrl}/api/v1/external/agents` with JWT. Upserts each target into local `agents` table. Deletes local remote agents no longer in the response. Returns `{ synced, removed }`.
- `startPeriodicSync(userId)` — Starts a 5-minute interval that calls `syncRemoteAgents()`. Stops any existing interval first. Each periodic sync broadcasts `agents:remote-sync-complete` to the renderer on completion.
- `stopPeriodicSync()` — Clears the periodic sync interval.

### JWT Resolution — `src/main/ipc/agent_a2a.ipc.ts`

- `resolveAgentAccessToken(agent)` — For `source='remote'`: calls `getCinnaAccessToken(getCurrentUserId())` to get a fresh JWT. For `source='local'`: decrypts `agent.accessTokenEncrypted`. Used by both `agent:send-message` and `agent:test` handlers.
- Endpoint auto-resolution in `agent:send-message` — When a remote agent has no cached `endpointUrl`, the handler calls `fetchAgentCard(cardUrl, jwt)` to resolve the protocol endpoint, then caches `endpointUrl`, `protocolInterfaceUrl`, and `protocolInterfaceVersion` in the agents table. Subsequent messages use the cached endpoint.

### Activation — `src/main/auth/activation.ts`

- `activate(userId)` — Extended to call `_startRemoteSync()` after providers are loaded.
- `_startRemoteSync(userId)` — Checks if user is `cinna_user` with `cinnaServerUrl`, then fires initial `syncRemoteAgents()` (non-blocking) and `startPeriodicSync()`. On sync completion, broadcasts `agents:remote-sync-complete` to the renderer via `getMainWindow().webContents.send()`.
- `deactivate()` — Extended to call `stopPeriodicSync()` before clearing providers.

## Renderer Components

- `AgentsSettingsSection` — Splits agents into remote (grouped by target type: My Agents / Shared with Me / People) and local sections. Remote section shown only for `cinna_user`. Includes "Sync" button that calls `useSyncRemoteAgents()`.
- `AgentCard` — Detects `agent.source === 'remote'` to: show "Remote" badge, hide delete button, hide access token section (JWT is automatic).
- `AgentSelector` — Groups enabled agents into sections based on `source` and `remoteTargetType`. Shows section headers only when multiple sections exist.
- `useAgents()` — Subscribes to `onRemoteSyncComplete` via `useEffect`, calling `queryClient.invalidateQueries({ queryKey: ['agents'] })` on each event. This ensures agent list auto-refreshes after initial and periodic syncs without manual action.

## Security

- **JWT-based auth** — Remote agents authenticate with the user's Cinna JWT, not a per-agent token. The JWT is fetched fresh at send time via `getCinnaAccessToken()`, which handles auto-refresh within 60s of expiry.
- **No token storage** — Remote agents have `accessTokenEncrypted = null`. The JWT is never persisted in the agents table.
- **Backend access control** — The backend re-verifies agent accessibility on every A2A request (ownership, route effectiveness, binding validity), so stale local agent entries cannot be used to bypass revocations.
