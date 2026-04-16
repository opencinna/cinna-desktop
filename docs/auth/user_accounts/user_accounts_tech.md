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
| IPC | `src/main/ipc/auth.ipc.ts` | Auth handlers: startup, login, register, logout, delete |
| IPC Index | `src/main/ipc/index.ts` | Registers auth handlers (first in order) |
| Entry | `src/main/index.ts` | Calls `initSession()` — no eager provider init (activation via auth flow) |
| Registry | `src/main/llm/registry.ts` | `clearAllAdapters()` used during activation/deactivation |

### Preload

| File | Purpose |
|------|---------|
| `src/preload/index.ts` | `UserData` interface + `window.api.auth.*` methods |

### Renderer

| Layer | File | Purpose |
|-------|------|---------|
| Store | `src/renderer/src/stores/auth.store.ts` | Zustand: currentUser, needsPassword, unlockedUserIds, markUnlocked/markLocked |
| Hook | `src/renderer/src/hooks/useAuth.ts` | React Query mutations/queries for auth operations |
| AuthGate | `src/renderer/src/App.tsx` | Startup auth check, wraps app with login gate |
| UserMenu | `src/renderer/src/components/auth/UserMenu.tsx` | Title bar dropdown |
| LoginScreen | `src/renderer/src/components/auth/LoginScreen.tsx` | Full-screen password prompt on restart |
| LoginPrompt | `src/renderer/src/components/auth/LoginPrompt.tsx` | Full-screen login overlay for user switching (OS-style centered avatar + password) |
| RegisterForm | `src/renderer/src/components/auth/RegisterForm.tsx` | Inline account creation form |
| TitleBar | `src/renderer/src/components/layout/TitleBar.tsx` | Hosts UserMenu in top-right slot |

## Database Schema

### `users` table
- `id` TEXT PK — nanoid, or `__default__` for built-in guest
- `type` TEXT NOT NULL DEFAULT `local_user` — extensible discriminator
- `username` TEXT UNIQUE NOT NULL
- `display_name` TEXT NOT NULL
- `password_hash` TEXT — PBKDF2 hex string, NULL for default user
- `salt` TEXT — random 32-byte hex, NULL for default user
- `created_at` INTEGER NOT NULL — timestamp

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
| `auth:register` | `({ username, displayName, password }) → { success, user?, error? }` | Create account + auto-switch |
| `auth:login` | `({ userId, password? }) → { success, user?, error? }` | Authenticate + switch + reload providers |
| `auth:logout` | `() → { success }` | Switch to default + reload providers |
| `auth:delete-user` | `(userId) → { success, error? }` | Delete user + cascade all data |

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
- Dropdown contains: stable "Profiles" list of all users (active highlighted with accent color), "Add Account", "Sign Out"
- List order never changes on profile switch — only the highlight moves
- Checks `isUnlocked(userId)` before prompting password on switch

### `LoginScreen` in `src/renderer/src/components/auth/LoginScreen.tsx`
- Full-screen with draggable titlebar area, centered card
- Large avatar with user initial, password input, unlock button
- "Continue as Guest" fallback to default user

## Security

- **Password storage**: PBKDF2-SHA512, 100k iterations, 64-byte derived key, 32-byte random salt per user
- **Session file**: `{userData}/session.json` stores only `{ lastUserId }` — no credentials
- **API key isolation**: each user's encrypted API keys are stored with their `userId`; `safeStorage` encryption is OS-level (same keychain for all local users on the same OS account)
- **No cross-user data leakage**: all IPC queries filter by `getCurrentUserId()` before returning data
- **Renderer sandbox**: auth operations go through typed `window.api.auth.*` — no direct DB or session access
