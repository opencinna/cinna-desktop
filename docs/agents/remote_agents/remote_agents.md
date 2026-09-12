# Remote Agents

For manually added ACP WebSocket connections, see [Remote ACP agents](remote_acp.md). The automatic discovery and synchronization described below uses A2A.

## Purpose

Automatically discovers and syncs agents from a connected Cinna backend so users can chat with remote agents (personal, shared, and identity-based) using the same A2A protocol infrastructure as locally-registered agents.

## Core Concepts

| Term | Definition |
|------|-----------|
| **Remote Agent** | An agent synced from the Cinna backend's External Agent Access API, stored locally with `source='remote'` |
| **Local Agent** | A manually-registered agent with `source='local'` (the existing behavior) |
| **External Agent Access API** | Backend REST + A2A surface at `/api/v1/external/` that exposes all agents addressable by the authenticated user |
| **Target Type** | Classification of a remote agent: `agent` (personal), `app_mcp_route` (shared via MCP routes), or `identity` (person-level contact) |
| **Agent Sync** | Process of fetching the remote agent list from the backend and upserting into the local `agents` table, removing stale entries |
| **Dynamic JWT** | Remote agents authenticate using the user's Cinna JWT fetched fresh at send time, not a stored per-agent token |
| **Entrypoint Prompt** | A suggested first-message prompt provided by the backend for a remote agent |
| **Example Prompts** | A list of clickable prompt suggestions provided by the backend for a remote agent |
| **Agent Override** | A row in `agent_overrides` recording a per-profile enable/disable toggle for a remote agent. Sync never touches this table — see [Settings Scope](../../core/settings_scope/settings_scope.md). |

## User Stories / Flows

### Automatic Discovery on Login

1. User authenticates with a Cinna account (OAuth 2.0 + PKCE)
2. On activation, the app automatically fetches `GET /api/v1/external/agents` with the user's JWT
3. Remote agents are upserted into the local database with deterministic IDs (`remote:{target_type}:{target_id}`)
4. On sync completion, main process sends `agents:remote-sync-complete` event to the renderer
5. The renderer's `useAgents()` hook listens for this event and auto-invalidates the TanStack Query cache, causing an immediate re-fetch
6. Enabled agents appear in the Agents sidebar under the active server domain and in the chat picker. **Settings → Profile → Agents** keeps both shown and hidden server agents under that domain — no page refresh needed
7. Periodic sync runs every 5 minutes to keep the list current; each periodic sync also triggers the same event-driven UI refresh

### Toggle a Remote Agent

1. User opens Settings → Profile → Agents
2. Presses **Disable** on its row, or **Disable in Desktop App** in its page header More actions menu
3. UI flips optimistically; main process writes a row to `agent_overrides` keyed by `(profileUserId, agentId)` via `agent:set-enabled` (see `agentService.setEnabled`)
4. Agent vanishes from the sidebar, chat picker and agent status listing. A toast names **Settings → Profile → Agents** as the recovery path. If its page is selected, navigation moves to the nearest preceding available agent in sidebar order, otherwise another agent, or an unbound new-chat screen when none remain. A delayed completion cannot redirect another profile or unrelated page
5. Future syncs upsert agent metadata but never touch `agent_overrides` — the toggle persists across syncs, app restarts, and re-appearances of the agent

### Manual Sync

1. User navigates to **Settings → Profile → Agents**
2. Clicks **Sync** beside "Synced from your Cinna account"
3. App fetches the latest agent list from the backend
4. New agents appear, removed agents disappear, updated agents reflect new metadata

### Chatting with a Remote Agent

1. User selects a remote agent in the Agents sidebar to open its chat composer, or chooses it from the chat picker
2. Types a message and sends
3. App fetches a fresh JWT via `getCinnaAccessToken()` (not a stored per-agent token)
4. If the agent's protocol endpoint hasn't been resolved yet (no `endpointUrl`), the app automatically fetches the agent card from `cardUrl`, extracts the endpoint, and caches it in the DB — no manual "Test" step required
5. Message is sent via standard A2A protocol to the backend's external A2A endpoint
6. Response streams back identically to local agent chats
7. A2A session (contextId, taskId) is stored locally for conversation continuity

### Agent Page and Profile Settings

- The page opens in chat mode; **Settings** exposes Overview and Connection, and **Start chat** returns to the same draft. Overview contains skills and readiness. Connection contains labeled protocol/endpoint details, automatic profile authentication and connection testing.
- Profile → Agents is a visibility and sync list for the active Cinna server only. Enabled rows have a Settings shortcut; hidden rows remain available to Enable. Sync failures and reauthentication remain on this page. Target types are backend metadata, not separate My Agents/Shared with Me/People settings groups.
- The header server domain opens the configured Cinna server externally.
- **Develop** prepares an eligible remote agent as a local coding connection when Local Development is ready; see [Local Development](../local_dev/local_dev.md#develop-a-remote-agent).

## Business Rules

- **Cinna-only feature** — Remote agent sync only activates for `cinna_user` accounts with a valid `cinnaServerUrl`
- **Deterministic IDs** — Remote agents use `remote:{target_type}:{target_id}` as their local ID, ensuring stable identity across syncs
- **Server-owned lifecycle** — Disable changes only the per-profile Desktop override; server state is retained. The header offers **Uninstall agent** for consumer bundle installs and **Delete agent** for eligible ordinary agents or publisher working copies. Both confirm the server effect and retain failures in the dialog; dismissal is blocked while pending. Existing Desktop chats remain. A shared route or identity has no Delete action.
- **Deletion eligibility** — UI eligibility requires a remote `agent` target with a target ID, no explicit `can_build: false`, no `is_foreign_install: true`, and either no bundle marker or `is_publisher_install: true`. This is presentation gating, not proof of ownership/developer roles; the server authorizes the operation. Main independently checks the cached target belongs to this profile and rejects consumer bundles.
- **Delete on the server first** — Desktop calls the owning Cinna server and prunes its cache only after success; deleting the cache alone would let the next sync restore the agent. Consumer bundles use [uninstall](../bundles_catalog/bundles_catalog.md), preserving bundle App Data under that server contract.
- **Override survives re-add** — `agent_overrides` has no FK / no cascade against `agents.id`; if a remote agent is removed and later re-synced under the same id, the prior override re-applies on the next list. Per-user cleanup happens in `userRepo.deleteWithCascade` only
- **Dynamic JWT auth** — Remote agents never store an access token in `accessTokenEncrypted`. At send time, the system detects `source='remote'` and fetches a fresh JWT via `getCinnaAccessToken()`. This avoids stale tokens and leverages the existing token refresh mechanism
- **Graceful degradation** — If the backend is unreachable during sync (network error, 4xx/5xx), the sync silently fails and existing remote agents remain unchanged
- **Stale agent removal** — Remote agents that no longer appear in the backend response are deleted from the local DB during sync
- **No card pre-fetch** — Remote agents are synced with `cardUrl` but without pre-fetching the agent card. The card and protocol endpoint are auto-resolved on first message send; the result is cached so subsequent messages skip the card fetch
- **Event-driven UI refresh** — After **every** sync — initial activation, the 5-minute periodic tick, **and** on-demand renderer-triggered syncs (`agent:sync-remote`: the Settings Refresh button, catalog install/uninstall refresh, bundle-update apply) — the main process broadcasts `agents:remote-sync-complete` to the renderer, which auto-invalidates the agents query cache for immediate UI updates. This single broadcast is the only refresh signal callers may rely on; renderer code must not invalidate `['agents']` directly before a sync (it would refetch the DB before the sync writes). Consumers that depend on freshly-synced fields (e.g. the catalog's bundle-update affordance reading `bundle_version`) only update because this fires on the on-demand path too — see [Bundle Updates](../bundles_catalog/bundle_updates_tech.md)
- **Periodic sync** — A 5-minute interval timer runs while a Cinna user is active; it stops on deactivation
- **Settings UI** — Profile → Agents is the server visibility/sync list, including hidden rows. Agent-page Settings → Connection explains automatic profile JWT authentication without a token editor; its header offers eligible server Delete or consumer-bundle Uninstall. See [Settings](../../ui/settings/settings.md).

## Architecture Overview

```
Sync Flow:
  User Activation (cinna_user)
    → syncRemoteAgents(userId)
      → getCinnaAccessToken(userId) → JWT
      → GET {cinnaServerUrl}/api/v1/external/agents (Bearer JWT)
      → Parse ExternalAgentListResponse
      → Upsert into agents table (source='remote', deterministic ID)
      → Delete stale remote agents not in response
      → webContents.send('agents:remote-sync-complete')
    → startPeriodicSync(userId) — repeats every 5 minutes, same event on each sync

On-Demand Sync Flow (Refresh button / catalog install·uninstall·update):
  Renderer: window.api.agents.syncRemote()
    → IPC: agent:sync-remote handler
      → syncRemoteAgents(userId)
      → notifyRemoteSyncComplete()  (same broadcast as the periodic runner)
    → returns { success, synced, removed } to the caller

UI Refresh Flow:
  Main: syncRemoteAgents() completes (any trigger)
    → Main: notifyRemoteSyncComplete() → webContents.send('agents:remote-sync-complete')
    → Preload: ipcRenderer.on('agents:remote-sync-complete')
    → Renderer: useAgents() hook listener fires
    → Renderer: queryClient.invalidateQueries(['agents'])
    → Renderer: agents list refetches automatically

Communication Flow:
  run:start → main runExecutionService → A2A driver
    → capabilities.auth selects Cinna JWT or stored token
    → resolve/cache a missing Cinna protocol endpoint
    → createA2AClient → A2A stream → persisted transcript
  run:watch → independent sequenced live subscription

Desktop Navigation:
  useAgents() → visible remote rows under active server domain → ExternalAgentPage
  Profile → Agents → all remote rows, including hidden → visibility / sync
```

## Integration Points

- **[Agents](../agents/agents.md)** — Remote agents are stored in the same `agents` table and reuse the same A2A client, IPC handlers, session management, and UI components as local agents
- **[Example Prompts](../../chat/example_prompts/example_prompts.md)** — Consumes `remoteMetadata.example_prompts` to drive the new-chat tag cloud and the `#` picker in the chat input
- **[Cinna Accounts](../../auth/cinna_accounts/cinna_accounts.md)** — JWT obtained via `getCinnaAccessToken()` which handles token refresh and rotation. Sync triggers on Cinna user activation
- **[Resource Activation](../../core/resource_activation/resource_activation.md)** — Remote sync starts on `activate()` and stops on `deactivate()`, following the same resource lifecycle gate as LLM/MCP providers
- **External Agent Access API** — Backend surface at `/api/v1/external/` providing agent discovery (`GET /agents`) and per-target A2A endpoints (`/a2a/{target_type}/{target_id}/`)
- **[Settings Scope](../../core/settings_scope/settings_scope.md)** — defines why remote agents live in Profile scope and how `agent_overrides` overlays the synced `enabled` flag in `agentService.listMerged`
