# User Accounts — Technical Details

## File Locations

### Main Process

| Layer | File | Purpose |
|-------|------|---------|
| Schema | `src/main/db/schema.ts` | `users` table + `userId` column on all data tables |
| Migration | `src/main/db/migrations/users.ts` | Creates users table, default user, adds userId columns |
| DB Client | `src/main/db/client.ts` | Runs `migrateUsers()` first in migration order |
| Session | `src/main/auth/session.ts` | In-memory session, password hashing, disk persistence |
| Activation | `src/main/auth/activation.ts` | `UserActivation` singleton — gates all user-scoped operations |
| Reload | `src/main/auth/reload.ts` | `reloadUserProviders()` — clears and re-inits LLM/MCP for active user |
| IPC | `src/main/ipc/auth.ipc.ts` | Auth handlers: startup, login, register, logout, update, delete |
| IPC Index | `src/main/ipc/index.ts` | Registers auth handlers (first in order) |
| Entry | `src/main/index.ts` | Calls `initSession()` — no eager provider init (activation via auth flow) |
| Registry | `src/main/llm/registry.ts` | `clearAllAdapters()` used during activation/deactivation |

### Preload

| File | Purpose |
|------|---------|
| `src/preload/index.ts` | `UserData` interface + `window.api.auth.*` methods (listUsers, getCurrent, getStartup, register, login, logout, updateUser, deleteUser, cinnaOAuthAbort) |

### Renderer

| Layer | File | Purpose |
|-------|------|---------|
| Store | `src/renderer/src/stores/auth.store.ts` | Zustand: currentUser, needsPassword, unlockedUserIds, markUnlocked/markLocked |
| Hook | `src/renderer/src/hooks/useAuth.ts` | React Query mutations/queries: useUsers, useCurrentUser, useLogin, useRegister, useLogout, useUpdateUser, useDeleteUser, useCinnaOAuthAbort |
| AuthGate | `src/renderer/src/App.tsx` | Startup auth check, wraps app with login gate |
| UserMenu | `src/renderer/src/components/auth/UserMenu.tsx` | Title bar dropdown — "Guest" badge on default user |
| LoginScreen | `src/renderer/src/components/auth/LoginScreen.tsx` | Full-screen password prompt on restart |
| LoginPrompt | `src/renderer/src/components/auth/LoginPrompt.tsx` | Full-screen login overlay for user switching (OS-style centered avatar + password) |
| RegisterForm | `src/renderer/src/components/auth/RegisterForm.tsx` | Multi-step account creation modal with horizontal type-selection cards (local + Cinna) — see [Cinna Accounts Tech](../cinna_accounts/cinna_accounts_tech.md) |
| TitleBar | `src/renderer/src/components/layout/TitleBar.tsx` | Hosts UserMenu in top-right slot |
| Settings | `src/renderer/src/components/settings/UserAccountsSection.tsx` | User Accounts settings page — list, edit, delete accounts |
| Sidebar | `src/renderer/src/components/layout/Sidebar.tsx` | Settings sidebar includes "User Accounts" menu item |
| Settings Page | `src/renderer/src/components/settings/SettingsPage.tsx` | Routes `accounts` tab to `UserAccountsSection` |
| UI Store | `src/renderer/src/stores/ui.store.ts` | `SettingsMenu` type includes `'accounts'` |

## Database Schema

### `users` table
- `id` TEXT PK — nanoid, or `__default__` for built-in guest
- `type` TEXT NOT NULL DEFAULT `local_user` — extensible discriminator
- `username` TEXT UNIQUE NOT NULL
- `display_name` TEXT NOT NULL
- `password_hash` TEXT — PBKDF2 hex string, NULL for passwordless users
- `salt` TEXT — random 32-byte hex, NULL for passwordless users
- `cinna_server_url` TEXT — Cinna server URL (NULL for local users)
- `cinna_hosting_type` TEXT — `cloud` or `self_hosted` (NULL for local users)
- `cinna_client_id` TEXT — server-assigned OAuth client ID (NULL for local users)
- `cinna_access_token_enc` BLOB — encrypted access token (NULL for local users)
- `cinna_refresh_token_enc` BLOB — encrypted refresh token (NULL for local users)
- `cinna_token_expires_at` INTEGER — token expiry in unix ms (NULL for local users)
- `created_at` INTEGER NOT NULL — timestamp

See [Cinna Accounts Tech](../cinna_accounts/cinna_accounts_tech.md) for full details on the Cinna columns.

### `userId` column on data tables
Added to: `llm_providers`, `mcp_providers`, `chats`, `chat_modes`, `agents`
- `user_id TEXT NOT NULL DEFAULT '__default__'`
- Existing rows backfilled with `__default__` via migration
- Not a foreign key (avoids migration complexity) — cascade handled in `auth:delete-user`

### Tables that inherit user scope via FK
- `messages` — scoped through `chat_id` FK to `chats`
- `chat_mcp_providers` — scoped through `chat_id` FK to `chats`
- `a2a_sessions` — scoped through `chat_id` FK to `chats`

## IPC Channels

| Channel | Signature | Purpose |
|---------|-----------|---------|
| `auth:list-users` | `() → UserInfo[]` | All users (id, type, username, displayName, hasPassword) |
| `auth:get-current` | `() → UserInfo \| null` | Currently active user |
| `auth:get-startup` | `() → { needsLogin, user?, pendingUser? }` | One-time startup state resolution |
| `auth:register` | `({ username?, displayName?, password?, accountType, cinnaHostingType?, cinnaServerUrl? }) → { success, user?, error? }` | Create local or Cinna account + auto-switch |
| `auth:cinna-oauth-abort` | `() → { success }` | Abort in-progress Cinna OAuth flow |
| `auth:login` | `({ userId, password? }) → { success, user?, error? }` | Authenticate + switch + reload providers |
| `auth:logout` | `() → { success }` | Switch to default + reload providers |
| `auth:update-user` | `({ userId, displayName?, password?, removePassword? }) → { success, user?, error? }` | Update display name and/or password for an existing user |
| `auth:delete-user` | `({ userId, password? }) → { success, error? }` | Verify password (if set) + cascade-delete all user data + fall back to default |

## Services & Key Methods

### `src/main/auth/session.ts`
- `getCurrentUserId()` — returns in-memory active user ID
- `setCurrentUser(userId)` — sets active user + persists to `session.json`
- `getLastUserId()` — reads raw last-user from disk (may need password)
- `initSession()` — resets to `__default__`; renderer calls `auth:get-startup` to resolve
- `hashPassword(password)` — PBKDF2 (100k iterations, 64-byte key, SHA-512) with random 32-byte salt
- `verifyPassword(password, hash, salt)` — constant-time comparison via PBKDF2

### `src/main/auth/activation.ts`
- `userActivation.activate(userId)` — single entry point: sets user + loads providers + opens gate
- `userActivation.deactivate()` — tears down services + closes gate
- `userActivation.requireActivated()` — guard for IPC handlers, throws if gate is closed
- See [Resource Activation](../../core/resource_activation/resource_activation_tech.md) for full details

### `src/main/auth/reload.ts`
- `reloadUserProviders()` — clears LLM registry, disconnects all MCP, re-inits both for `getCurrentUserId()`

### `src/main/ipc/auth.ipc.ts` — Update & Delete handlers
- `auth:update-user` — validates user exists, not default; applies display name change and/or password set/change/remove via `hashPassword()`; returns updated `UserInfo`
- `auth:delete-user` — verifies password if user has one set; deactivates session if deleting current user; clears Cinna tokens; cascade-deletes from all data tables (`chats`, `llmProviders`, `mcpProviders`, `chatModes`, `agents`); re-activates as `__default__` if was current user

### Modified IPC handlers (userId filtering + activation gate)
Every list/get/create/update/delete handler in these files now calls `getCurrentUserId()` and adds `eq(table.userId, userId)` to queries:
- `src/main/ipc/chat.ipc.ts` — all chat CRUD + trash operations
- `src/main/ipc/provider.ipc.ts` — provider list/upsert/delete, default-clearing scoped to user
- `src/main/ipc/chatmode.ipc.ts` — mode list/get/upsert/delete
- `src/main/ipc/agent.ipc.ts` — agent list/upsert/delete
- `src/main/ipc/mcp.ipc.ts` — MCP list/upsert, insert includes userId

## Renderer Components

### `AuthGate` in `src/renderer/src/App.tsx`
- Wraps entire app inside `QueryClientProvider`
- On mount: calls `window.api.auth.getStartup()`
- If `needsLogin` → renders `LoginScreen`; otherwise renders children
- Shows empty bg-colored div until startup state resolves (avoids flash)

### `UserMenu` in `src/renderer/src/components/auth/UserMenu.tsx`
- Rendered in TitleBar top-right (replaces empty `w-[100px]` div)
- Shows current user avatar (initial or guest icon) + name + chevron
- Default user shows "Guest" badge (pill with muted bg) in the dropdown profile list
- Dropdown contains: stable "Profiles" list of all users (active highlighted with accent color), "Add Account", "Sign Out"
- List order never changes on profile switch — only the highlight moves
- Checks `isUnlocked(userId)` before prompting password on switch
- "Add Account" opens wider modal (`w-96`) with `RegisterForm`

### `RegisterForm` in `src/renderer/src/components/auth/RegisterForm.tsx`
- Multi-step modal: type selection → form/OAuth
- Type selection step: **horizontal cards** (`flex gap-3`) with centered icons — "Local Account" and "Cinna Account"
- Cinna hosting step: also horizontal cards for Cloud vs Self-Hosted
- Local form: labeled fields (username, display name, password) with larger sizing (`text-sm`, `px-3 py-2`)
- Cinna waiting: spinner + cancel button

### `LoginScreen` in `src/renderer/src/components/auth/LoginScreen.tsx`
- Full-screen with draggable titlebar area, centered card
- Large avatar with user initial, password input, unlock button
- "Continue as Guest" fallback to default user

### `UserAccountsSection` in `src/renderer/src/components/settings/UserAccountsSection.tsx`
- Settings page accessible via Settings → "User Accounts" sidebar item
- Lists all accounts as expandable `UserAccountCard` components
- Default user card shows "Guest" badge, is not expandable (no editable fields)
- Each non-default card header: avatar (accent-colored if active), display name, type icon (Cloud/HardDrive/User), lock/unlock icon, "Active" badge if current user
- Expanded local user: editable display name, set/change/remove password, delete button
- Expanded Cinna user: read-only grid (host, hosting type, connection status, email) + password section + delete button
- Delete flow: trash icon → red confirmation panel with warning text → password input if user has password → "Delete Account" button
- Uses `useUpdateUser()` and `useDeleteUser()` hooks from `src/renderer/src/hooks/useAuth.ts`

### Settings integration
- `src/renderer/src/stores/ui.store.ts` — `SettingsMenu` union includes `'accounts'`
- `src/renderer/src/components/layout/Sidebar.tsx` — "User Accounts" with `Users` icon, after "MCP Providers" in the settings menu items array
- `src/renderer/src/components/settings/SettingsPage.tsx` — routes `accounts` tab to `UserAccountsSection`, title "User Accounts"

## Security

- **Password storage**: PBKDF2-SHA512, 100k iterations, 64-byte derived key, 32-byte random salt per user
- **Password-verified deletion**: `auth:delete-user` requires password re-entry if the user has a password set — prevents unauthorized account removal
- **Session file**: `{userData}/session.json` stores only `{ lastUserId }` — no credentials
- **API key isolation**: each user's encrypted API keys are stored with their `userId`; `safeStorage` encryption is OS-level (same keychain for all local users on the same OS account)
- **No cross-user data leakage**: all IPC queries filter by `getCurrentUserId()` before returning data
- **Renderer sandbox**: auth operations go through typed `window.api.auth.*` — no direct DB or session access
