# User Accounts

## Purpose

Local user accounts for the desktop app, similar to OS-level login. Users can create password-protected profiles; all data (chats, providers, agents, settings) is scoped to the active user. Switching users changes the entire app context. Accounts can be managed (edited, deleted) from the Settings screen.

## Core Concepts

| Term | Definition |
|------|-----------|
| **Default User** | Built-in guest account (`id: __default__`) with no password — always present, cannot be deleted or edited. Shown with a "Guest" badge in all UI surfaces |
| **Local User** | A user-created account with username, display name, and password (`type: local_user`) |
| **Cinna User** | A user account linked to a remote Cinna server via OAuth (`type: cinna_user`) — see [Cinna Accounts](../cinna_accounts/cinna_accounts.md) |
| **User Type** | Discriminator field: `local_user` for local accounts, `cinna_user` for Cinna server-linked accounts |
| **Session** | In-memory record of the active user ID in the main process; persisted to disk as `session.json` |
| **Unlocked User** | A password-protected user who has authenticated in the current window session — won't be asked for password again until app restart |

## User Stories / Flows

### First Launch
1. App starts with default user active (no login screen)
2. User sees the normal new-chat page immediately
3. User menu in the top-right title bar shows "Default User / Guest"

### Create Account
1. User clicks the user menu dropdown in the title bar
2. Clicks "Add Account" — centered modal opens (wider layout, `w-96`)
3. Chooses account type via **horizontal cards**: "Local Account" or "Cinna Account" (see [Cinna Accounts](../cinna_accounts/cinna_accounts.md))
4. For local: fills in username, display name (optional), and optional password — fields have labels above them
5. Account is created and app immediately switches to the new user
6. All data queries refetch — the new user starts with a clean slate

### Switch User (No Password / Already Unlocked)
1. User opens the user menu dropdown — all profiles shown in a stable list, active profile highlighted with accent color
2. Default user always shows a "Guest" badge next to the name
3. Clicks another user's name
4. App switches immediately — chats, providers, agents all reload for that user; list order stays the same, only the highlight moves

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

### Sign Out (Account Removal)
1. User clicks "Sign Out" in the dropdown (only shown for non-default users)
2. Centered confirmation modal appears with warning: all **local** chat history, providers, agents, and settings for this account will be permanently erased
3. For Cinna accounts: modal notes that the cloud account will not be affected
4. If the account has a password set, the user must enter it to confirm
5. On confirmation: account is fully deleted (same cascade-delete flow as Settings → Delete Account), session falls back to default user
6. All data refetches for the default user's context

### Manage Accounts (Settings)
1. User navigates to Settings → "User Accounts" (last menu item in the main settings block, after MCP Providers)
2. All accounts listed as expandable cards — default user shows "Guest" badge, not expandable
3. Click a card to expand and see/edit account details

### Edit Account (Settings)
1. User expands an account card in Settings → User Accounts
2. **Local users**: can change display name and set/change/remove password
3. **Cinna users**: profile fields are read-only (username/email from OAuth), but read-only details are shown — host, hosting type (Cloud/Self-Hosted), connection status. User can set a local password for session lock
4. Click "Save Changes" to apply

### Delete Account (Settings)
1. User clicks the trash icon on an expanded account card
2. Red confirmation panel appears with warning: all user data (chats, providers, agents, settings) will be permanently deleted
3. If the account has a password set, the user must enter it to confirm deletion
4. Cinna accounts note: cloud data is not affected, only local data is removed
5. On deletion: all user-scoped data cascade-deleted, session falls back to default user if deleting the active account

## Business Rules

- The `__default__` user always exists and cannot be deleted or edited
- Usernames must be unique (case-sensitive)
- Passwords are optional for all account types — used only to lock the local session
- Password is required to delete a password-protected account (security confirmation)
- Cinna account profile fields (username, display name) come from OAuth and cannot be edited locally — only local password can be set/changed
- Every data table (chats, providers, agents, modes, MCP) is filtered by `userId` — users cannot see each other's data
- Messages and chat-MCP links inherit user scope through their chat foreign key
- On user switch: LLM adapters are cleared and re-initialized, MCP connections are disconnected and reconnected for the new user's providers (see [Resource Activation](../../core/resource_activation/resource_activation.md))
- On account deletion: deactivate session → clear Cinna tokens → cascade-delete all data tables → delete user row → re-activate as default user
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

Sign Out (from UserMenu):
  UserMenu "Sign Out" ──→ confirmation modal ──→ auth:delete-user
                          (password if set)       verify password → cascade delete → activate __default__

Account Management (Settings):
  UserAccountsSection ──→ auth:update-user ──→ update display name / password
                      ──→ auth:delete-user ──→ verify password → cascade delete → activate __default__
```

## Integration Points

- **All IPC handlers** filter queries by `getCurrentUserId()` — see [Messaging](../../chat/messaging/messaging.md), [Adapters](../../llm/adapters/adapters.md), [Connections](../../mcp/connections/connections.md), [Agents](../../agents/agents/agents.md), [Chat Modes](../../chat/chat_modes/chat_modes.md)
- **LLM Registry** — `clearAllAdapters()` + re-init on user switch (see [Adapters](../../llm/adapters/adapters.md))
- **MCP Manager** — `disconnectAll()` + reconnect on user switch (see [Connections](../../mcp/connections/connections.md))
- **Settings** — providers, modes, MCP servers, agents are all user-scoped via `userId` column; "User Accounts" is a settings section (see [Settings](../../ui/settings/settings.md))
- **Theme** — stored in `localStorage` (browser-level), not user-scoped (shared across all users on the same machine)
