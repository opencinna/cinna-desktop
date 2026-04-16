# User Accounts

## Purpose

Local user accounts for the desktop app, similar to OS-level login. Users can create password-protected profiles; all data (chats, providers, agents, settings) is scoped to the active user. Switching users changes the entire app context.

## Core Concepts

| Term | Definition |
|------|-----------|
| **Default User** | Built-in guest account (`id: __default__`) with no password — always present, cannot be deleted. Gets a random [cyberpunk alias](guest_aliases.md) on each app restart |
| **Local User** | A user-created account with username, display name, and password (`type: local_user`) |
| **User Type** | Extensible discriminator field (`local_user` now, `cinna_user` planned for future cloud accounts) |
| **Session** | In-memory record of the active user ID in the main process; persisted to disk as `session.json` |
| **Unlocked User** | A password-protected user who has authenticated in the current window session — won't be asked for password again until app restart |

## User Stories / Flows

### First Launch
1. App starts with default user active (no login screen)
2. User sees the normal new-chat page immediately
3. User menu in the top-right title bar shows "Default User / Guest"

### Create Account
1. User clicks the user menu dropdown in the title bar
2. Clicks "Add Account"
3. Fills in username, display name (optional), and password
4. Account is created and app immediately switches to the new user
5. All data queries refetch — the new user starts with a clean slate

### Switch User (No Password / Already Unlocked)
1. User opens the user menu dropdown — all profiles shown in a stable list, active profile highlighted with accent color
2. Clicks another user's name
3. App switches immediately — chats, providers, agents all reload for that user; list order stays the same, only the highlight moves

### Switch User (Password Required)
1. User opens the user menu dropdown — all profiles shown in a stable list, active profile highlighted
2. Clicks a password-protected user who hasn't authenticated this session
3. Dropdown closes; full-screen login overlay appears (OS-style: centered avatar + password input with blurred backdrop)
4. After correct password, app switches to that user
5. That user is marked "unlocked" for the rest of the window session (or until sign-out)

### App Restart with Password-Protected User
1. App remembers last active user from `session.json`
2. If last user has a password: full-screen login screen shown
3. User enters password or clicks "Continue as Guest" to use default account
4. If last user was default or passwordless: app loads directly to new-chat page

### Sign Out
1. User clicks "Sign Out" in the dropdown (only shown for non-default users)
2. User's unlock state is cleared (will require password again on next sign-in)
3. Session switches to default user
4. All data refetches for the default user's context

### Delete Account
1. Account deleted via IPC call
2. All user's data cascade-deleted (chats, providers, agents, modes)
3. If deleting the current user, session falls back to default

## Business Rules

- The `__default__` user always exists and cannot be deleted
- Usernames must be unique (case-sensitive)
- Passwords are required for local user creation (default user has no password)
- Every data table (chats, providers, agents, modes, MCP) is filtered by `userId` — users cannot see each other's data
- Messages and chat-MCP links inherit user scope through their chat foreign key
- On user switch: LLM adapters are cleared and re-initialized, MCP connections are disconnected and reconnected for the new user's providers (see [Resource Activation](../../core/resource_activation/resource_activation.md))
- Password verification uses PBKDF2 (100k iterations, SHA-512) — no plaintext storage
- Session persistence stores only the last user ID, not credentials
- Per-session unlock tracking resets on app restart or sign-out (password required again)

## Architecture Overview

```
App Startup:
  Main Process                          Renderer
  ───────────                          ─────────
  initSession() [stays as __default__]
                                       AuthGate calls auth:get-startup
  Check last user from session.json ──→ { needsLogin, user/pendingUser }
  If needsLogin: stay __default__       Show LoginScreen
  If no password: activate user         Show main app
                                       
User Switch:
  UserMenu click ──→ auth:login ──→ setCurrentUser(id)
                                   reloadUserProviders()
                 ←── { success, user }
                     queryClient.resetQueries()
                     All data refetches for new user
```

## Integration Points

- **All IPC handlers** filter queries by `getCurrentUserId()` — see [Messaging](../../chat/messaging/messaging.md), [Adapters](../../llm/adapters/adapters.md), [Connections](../../mcp/connections/connections.md), [Agents](../../agents/agents/agents.md), [Chat Modes](../../chat/chat_modes/chat_modes.md)
- **LLM Registry** — `clearAllAdapters()` + re-init on user switch (see [Adapters](../../llm/adapters/adapters.md))
- **MCP Manager** — `disconnectAll()` + reconnect on user switch (see [Connections](../../mcp/connections/connections.md))
- **Settings** — providers, modes, MCP servers, agents are all user-scoped via `userId` column
- **Theme** — stored in `localStorage` (browser-level), not user-scoped (shared across all users on the same machine)
