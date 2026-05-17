# Resource Activation

## Purpose

All app resources (LLM adapters, MCP connectors, user data) are scoped to the active user account and only activated after explicit authentication. Nothing runs until a user is authenticated — the app starts cold and the auth flow is the single trigger that brings services online.

## Core Concepts

| Term | Definition |
|------|-----------|
| **User Account** | A local profile (username + password) that scopes all data — chats, providers, agents, settings. See [User Accounts](../../auth/user_accounts/user_accounts.md) |
| **Activation** | The transition from "no user session" to "authenticated user with running services" |
| **Activation Gate** | A guard on every user-scoped IPC handler that rejects calls when no user is activated |
| **Deactivation** | Tearing down all services (LLM adapters cleared, MCP disconnected) without loading new ones |
| **User-Scoped Resource** | Any data or service tied to a userId: chats, LLM providers, MCP servers, agents, chat modes |

## How It Works

### Account-Scoped Data Model

Every data table in the app has a `userId` column, but it is filtered along one of two scopes — see [Settings Scope](../settings_scope/settings_scope.md):

- **Default scope** (`userId = '__default__'`) — shared across profiles:
  - **LLM providers** — API keys, model selection, default provider
  - **MCP servers** — server configs, OAuth tokens, connection state
  - **Chat modes** — preset configurations bundling provider + MCP servers
  - **Local agents** — manually-registered A2A agents
- **Profile scope** (`userId = activeUserId`) — per-profile, swapped on user switch:
  - **Chats & messages** — conversations, message history, trash
  - **Remote agents** — agents synced from a Cinna account
  - **Agent overrides** — per-profile enable/disable of remote agents
  - **Cinna OAuth tokens** — stored on the user row

### Startup Lifecycle

1. App launches — database initialized, IPC handlers registered, **no services started**
2. Renderer loads `AuthGate` component, calls `auth:get-startup`
3. Main process checks the last active user from `session.json`:
   - **Passwordless / default user** — activated immediately (providers load, gate opens)
   - **Password-protected user** — stays deactivated; renderer shows login screen
4. User authenticates via login screen — activation triggers, providers load, gate opens
5. All user-scoped IPC handlers now accept calls

### Activation Flow

```
App Start
  │
  ├─ initDatabase()
  ├─ initSession()        [userId = __default__, NOT activated]
  ├─ registerIpcHandlers() [handlers registered but gated]
  └─ createWindow()
       │
       ▼
Renderer: AuthGate → auth:get-startup
  │
  ├─ Passwordless → activate(userId)
  │     ├─ Set current user
  │     ├─ Load LLM adapters
  │     ├─ Connect MCP servers
  │     └─ Gate opens ✓
  │
  └─ Password required → show LoginScreen
        │
        └─ User enters password → auth:login → activate(userId)
              ├─ Set current user
              ├─ Load LLM adapters
              ├─ Connect MCP servers
              └─ Gate opens ✓
```

### User Switch

When switching users (via UserMenu or login), the activation cycle repeats:
1. Previous user's adapters cleared, MCP connections disconnected
2. Default-scope providers reloaded (same set across profiles — see [Settings Scope](../settings_scope/settings_scope.md))
3. Remote-agent sync starts for the new profile if it's a Cinna account
4. All profile-scoped data queries (chats, remote agents) refetch for the new user's context

### Logout

Logout activates the `__default__` (guest) user — the guest account is always considered authorized, so the gate stays open and guest providers load.

### Deactivation

Deactivation (used when deleting the current user) is different from logout:
- All services are torn down (adapters cleared, MCP disconnected)
- Session falls back to `__default__` but **no providers are loaded**
- The gate closes — IPC handlers reject calls until re-activation

## Business Rules

- No LLM adapter or MCP connector runs before authentication
- Every user-scoped IPC handler checks the activation gate before executing
- Auth IPC handlers (`auth:*`) are NOT gated — they are the mechanism for activation
- The `__default__` guest user is always considered authenticated (no password)
- Activation is the **only** path to loading providers — there is no eager init at startup
- On app quit, `mcpManager.disconnectAll()` runs as a safety net regardless of activation state

## Integration Points

- **[Settings Scope](../settings_scope/settings_scope.md)** — defines which resources live in Default vs Profile scope and how reload routes them
- **[User Accounts](../../auth/user_accounts/user_accounts.md)** — authentication flow, session management, user CRUD
- **[Adapters](../../llm/adapters/adapters.md)** — LLM provider lifecycle controlled by activation
- **[Connections](../../mcp/connections/connections.md)** — MCP server connections controlled by activation
- **[Agents](../../agents/agents/agents.md)** — agent data gated behind activation
- **[Chat Modes](../../chat/chat_modes/chat_modes.md)** — mode data gated behind activation
- **[Messaging](../../chat/messaging/messaging.md)** — chat CRUD + streaming gated behind activation
