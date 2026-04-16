# Resource Activation — Technical Details

## File Locations

### Main Process

| Layer | File | Purpose |
|-------|------|---------|
| Activation | `src/main/auth/activation.ts` | `UserActivation` singleton — `activate()`, `deactivate()`, `requireActivated()` |
| Session | `src/main/auth/session.ts` | `getCurrentUserId()`, `setCurrentUser()` — low-level session state |
| Reload | `src/main/auth/reload.ts` | `reloadUserProviders()` — clears and re-inits LLM/MCP for active user |
| Entry | `src/main/index.ts` | Startup sequence — no eager provider init |
| Auth IPC | `src/main/ipc/auth.ipc.ts` | Auth handlers call `userActivation.activate()` / `deactivate()` |
| Registry | `src/main/llm/registry.ts` | `clearAllAdapters()` called during activation/deactivation |
| MCP | `src/main/mcp/manager.ts` | `disconnectAll()` called during activation/deactivation |

### Guarded IPC Handlers

Every user-scoped handler calls `userActivation.requireActivated()` as its first statement:

- `src/main/ipc/chat.ipc.ts` — all chat CRUD + trash handlers
- `src/main/ipc/provider.ipc.ts` — list, upsert, delete, test, list-models
- `src/main/ipc/mcp.ipc.ts` — list, upsert, delete, connect, disconnect, list-tools, chat MCP links
- `src/main/ipc/agent.ipc.ts` — list, upsert, delete
- `src/main/ipc/agent_a2a.ipc.ts` — fetch-card, test, get-session, send-message
- `src/main/ipc/chatmode.ipc.ts` — list, get, upsert, delete
- `src/main/ipc/llm.ipc.ts` — send-message (streaming via MessagePort)

### NOT Guarded (Auth Handlers)

- `auth:list-users` — needed to render login screen
- `auth:get-current` — may be called pre-auth
- `auth:get-startup` — the activation trigger itself
- `auth:login`, `auth:register` — authentication actions
- `auth:logout`, `auth:delete-user` — deactivation actions

## Services & Key Methods

### `src/main/auth/activation.ts`

- `userActivation.activate(userId)` — calls `setCurrentUser()` + `reloadUserProviders()` + sets `_activated = true`
- `userActivation.deactivate()` — sets `_activated = false` + `clearAllAdapters()` + `mcpManager.disconnectAll()` + `setCurrentUser('__default__')`
- `userActivation.isActivated()` — returns current gate state (used by MessagePort handlers that can't throw)
- `userActivation.requireActivated()` — throws `'Session not activated'` if gate is closed (used by `ipcMain.handle` handlers)

### Activation call sites in `src/main/ipc/auth.ipc.ts`

| Handler | Call |
|---------|------|
| `auth:get-startup` (deleted user fallback) | `userActivation.activate('__default__')` |
| `auth:get-startup` (passwordless user) | `userActivation.activate(lastUser.id)` |
| `auth:get-startup` (password user) | No activation — stays gated |
| `auth:register` | `userActivation.activate(id)` |
| `auth:login` | `userActivation.activate(user.id)` |
| `auth:logout` | `userActivation.activate('__default__')` |
| `auth:delete-user` (current user) | `userActivation.deactivate()` |

### Guard patterns

For `ipcMain.handle` handlers (request/response):
- `userActivation.requireActivated()` throws, error propagates to renderer as rejected promise

For `ipcMain.on` handlers (MessagePort streaming):
- Check `userActivation.isActivated()`, send error via port + close if not activated
- Used in `llm:send-message` and `agent:send-message`
