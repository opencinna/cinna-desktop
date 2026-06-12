# Remote Agents

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
6. Agents appear in the chat agent selector and Settings > Agents under "Remote Agents" — no page refresh needed
7. Periodic sync runs every 5 minutes to keep the list current; each periodic sync also triggers the same event-driven UI refresh

### Toggle a Remote Agent

1. User opens Settings → Profile → Agents
2. Clicks the toggle on a remote agent card
3. UI flips optimistically; main process writes a row to `agent_overrides` keyed by `(profileUserId, agentId)` via `agent:set-enabled` (see `agentService.setEnabled`)
4. Agent vanishes from the chat agent selector
5. Future syncs upsert agent metadata but never touch `agent_overrides` — the toggle persists across syncs, app restarts, and re-appearances of the agent

### Manual Sync

1. User navigates to Settings > Agents
2. Clicks the "Sync" button next to the "Remote Agents" heading
3. App fetches the latest agent list from the backend
4. New agents appear, removed agents disappear, updated agents reflect new metadata

### Chatting with a Remote Agent

1. User selects a remote agent from the agent selector (grouped under "My Agents", "Shared with Me", or "People")
2. Types a message and sends
3. App fetches a fresh JWT via `getCinnaAccessToken()` (not a stored per-agent token)
4. If the agent's protocol endpoint hasn't been resolved yet (no `endpointUrl`), the app automatically fetches the agent card from `cardUrl`, extracts the endpoint, and caches it in the DB — no manual "Test" step required
5. Message is sent via standard A2A protocol to the backend's external A2A endpoint
6. Response streams back identically to local agent chats
7. A2A session (contextId, taskId) is stored locally for conversation continuity

### Agent Categories in Selector

When remote agents are present, the agent selector dropdown groups agents into sections:
- **My Agents** — user's personal agents (`target_type='agent'`)
- **Shared with Me** — agents shared via App MCP routes (`target_type='app_mcp_route'`)
- **People** — identity contacts (`target_type='identity'`)
- **Local** — manually-registered local agents

## Business Rules

- **Cinna-only feature** — Remote agent sync only activates for `cinna_user` accounts with a valid `cinnaServerUrl`
- **Deterministic IDs** — Remote agents use `remote:{target_type}:{target_id}` as their local ID, ensuring stable identity across syncs
- **Sync-managed lifecycle** — Remote agents cannot be manually deleted; they appear/disappear based on backend state. Users can only enable/disable them locally via the `agent_overrides` table (sync never writes there)
- **Override survives re-add** — `agent_overrides` has no FK / no cascade against `agents.id`; if a remote agent is removed and later re-synced under the same id, the prior override re-applies on the next list. Per-user cleanup happens in `userRepo.deleteWithCascade` only
- **Dynamic JWT auth** — Remote agents never store an access token in `accessTokenEncrypted`. At send time, the system detects `source='remote'` and fetches a fresh JWT via `getCinnaAccessToken()`. This avoids stale tokens and leverages the existing token refresh mechanism
- **Graceful degradation** — If the backend is unreachable during sync (network error, 4xx/5xx), the sync silently fails and existing remote agents remain unchanged
- **Stale agent removal** — Remote agents that no longer appear in the backend response are deleted from the local DB during sync
- **No card pre-fetch** — Remote agents are synced with `cardUrl` but without pre-fetching the agent card. The card and protocol endpoint are auto-resolved on first message send; the result is cached so subsequent messages skip the card fetch
- **Event-driven UI refresh** — After **every** sync — initial activation, the 5-minute periodic tick, **and** on-demand renderer-triggered syncs (`agent:sync-remote`: the Settings Refresh button, catalog install/uninstall refresh, bundle-update apply) — the main process broadcasts `agents:remote-sync-complete` to the renderer, which auto-invalidates the agents query cache for immediate UI updates. This single broadcast is the only refresh signal callers may rely on; renderer code must not invalidate `['agents']` directly before a sync (it would refetch the DB before the sync writes). Consumers that depend on freshly-synced fields (e.g. the catalog's bundle-update affordance reading `bundle_version`) only update because this fires on the on-demand path too — see [Bundle Updates](../bundles_catalog/bundle_updates_tech.md)
- **Periodic sync** — A 5-minute interval timer runs while a Cinna user is active; it stops on deactivation
- **Settings UI** — Remote agents show a "Remote" badge, hide the delete button, and hide the access token section (JWT is managed automatically). They live in the sidebar's "Profile {name}" group, separate from the Default group's local agents — see [Settings](../../ui/settings/settings.md)

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
  agent:send-message (MessagePort)
    → Load agent from DB
    → agent.source === 'remote'?
      → YES: getCinnaAccessToken(userId) → JWT as accessToken
      → NO:  decryptApiKey(agent.accessTokenEncrypted) → stored token
    → endpointUrl missing AND source='remote'?
      → YES: fetchAgentCard(cardUrl, JWT) → resolve protocol endpoint
             → cache endpointUrl + protocolInterfaceUrl in agents table
    → createA2AClient(endpointUrl, cardUrl, accessToken)
    → Standard A2A streaming (identical to local agents)

Agent Selector (categorized):
  useAgents() → group by source + remoteTargetType
    → "My Agents" (remote, agent)
    → "Shared with Me" (remote, app_mcp_route)
    → "People" (remote, identity)
    → "Local" (local)
```

## Integration Points

- **[Agents](../agents/agents.md)** — Remote agents are stored in the same `agents` table and reuse the same A2A client, IPC handlers, session management, and UI components as local agents
- **[Example Prompts](../../chat/example_prompts/example_prompts.md)** — Consumes `remoteMetadata.example_prompts` to drive the new-chat tag cloud and the `#` picker in the chat input
- **[Cinna Accounts](../../auth/cinna_accounts/cinna_accounts.md)** — JWT obtained via `getCinnaAccessToken()` which handles token refresh and rotation. Sync triggers on Cinna user activation
- **[Resource Activation](../../core/resource_activation/resource_activation.md)** — Remote sync starts on `activate()` and stops on `deactivate()`, following the same resource lifecycle gate as LLM/MCP providers
- **External Agent Access API** — Backend surface at `/api/v1/external/` providing agent discovery (`GET /agents`) and per-target A2A endpoints (`/a2a/{target_type}/{target_id}/`)
- **[Settings Scope](../../core/settings_scope/settings_scope.md)** — defines why remote agents live in Profile scope and how `agent_overrides` overlays the synced `enabled` flag in `agentService.listMerged`
