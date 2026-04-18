# Main-Process Layering — LLM Reference

Project-specific layering convention for `src/main/`. LLM-targeted reference — concise patterns only, skip standard Electron/Drizzle knowledge.

## The Three Layers

```
ipc/*.ipc.ts         (transport)   — ipcHandle wrap, requireActivated, DTO pass-through
services/*Service.ts (business)    — orchestration, validation, encryption, registry sync
db/*.ts              (persistence) — Drizzle queries, all writes scoped by userId
```

Adapters (`llm/*.ts`, `mcp/manager.ts`, `agents/a2a-client.ts`) sit beside the service layer; services call them directly.

## Per-Domain File Map

| Domain | Repo | Service | IPC |
|--------|------|---------|-----|
| Users | `db/users.ts` (`userRepo`) | `services/authService.ts` | `ipc/auth.ipc.ts` |
| Chats | `db/chats.ts` (`chatRepo`) + `db/messages.ts` (`messageRepo`) + `db/chatMcp.ts` (`chatMcpRepo`) | `services/chatService.ts` + `services/chatStreamingService.ts` | `ipc/chat.ipc.ts` + `ipc/llm.ipc.ts` |
| Chat modes | `db/chatModes.ts` (`chatModeRepo`) | `services/chatModeService.ts` | `ipc/chatmode.ipc.ts` |
| LLM providers | `db/llmProviders.ts` (`llmProviderRepo`) | `services/providerService.ts` (uses `llm/factory.ts` + `llm/registry.ts`) | `ipc/provider.ipc.ts` |
| MCP providers | `db/mcpProviders.ts` (`mcpProviderRepo`) | `services/mcpService.ts` (uses `mcp/manager.ts`) | `ipc/mcp.ipc.ts` |
| Agents | `db/agents.ts` (`agentRepo`, `a2aSessionRepo`) | `services/agentService.ts` | `ipc/agent.ipc.ts` + `ipc/agent_a2a.ipc.ts` |

## Layer Rules

### `db/<entity>.ts`
- Exports a single `<entity>Repo` object (no class)
- Every read/write filters by `userId` argument (except junction tables that key off `chatId` and rely on the chat being user-scoped)
- `getOwned(userId, id)` is the canonical "fetch + ownership check" method
- Multi-row writes that must be atomic use `db.transaction((tx) => ...)` (see `agentRepo.syncRemote`, `userRepo.deleteWithCascade`, `chatMcpRepo.replaceForChat`)
- Repos never touch encryption, never call adapters, never log — they are pure persistence
- Type alias: `export type EntityRow = typeof entities.$inferSelect`

### `services/<entity>Service.ts`
- Exports a single `<entity>Service` object
- Owns: input validation, DomainError throwing, encryption (`encryptApiKey/decryptApiKey`), DTO mapping (`hasApiKey: boolean`, etc.), side effects (registry register/unregister, `mcpManager.connect/disconnect`, logging)
- Receives `userId` as the first arg (or no userId for "session-less" calls like `fetchCardPreview`)
- Returns DTOs, never raw rows containing encrypted blobs
- May call other services directly (e.g. `agentService.resolveAccessToken` calls `getCinnaAccessToken`)
- Use `createLogger('domain')` for structured logs

### `ipc/<entity>.ipc.ts`
- Each handler is a one-liner: `requireActivated()` → call service → return result
- Wrap every handler with `ipcHandle(channel, fn)` from `ipc/_wrap.ts` (NOT `ipcMain.handle` directly) — this gives uniform DomainError serialization and structured error logs
- For streaming (MessagePort) handlers, use `ipcMain.on` directly and check `userActivation.isActivated()` manually (cannot throw — must post error to port and close)
- Auth-flow handlers that show inline form errors return a discriminated `{ success: true, ... } | { success: false, error }` shape — wrap the service call in try/catch and use `ipcErrorShape(err).message`
- All other handlers let DomainError flow through `ipcHandle` (renderer's `invoke()` rejects with the error code preserved)

## Errors — `src/main/errors.ts`

Every domain has a typed error class with a string-literal code union:

| Class | Codes |
|-------|-------|
| `AuthError` | `not_found`, `username_taken`, `username_required`, `password_required`, `password_too_weak`, `invalid_password`, `default_user_immutable`, `oauth_failed`, `missing_server_url` |
| `ProviderError` | `not_found`, `unsupported_type`, `missing_api_key`, `not_activated` |
| `McpError` | `not_found`, `not_activated`, `invalid_transport`, `connect_failed` |
| `ChatError` | `not_found`, `not_configured`, `adapter_unavailable`, `not_activated` |
| `AgentError` | `not_found`, `not_activated`, `unsupported_protocol`, `no_card_url`, `no_endpoint`, `remote_immutable`, `invalid_id`, `sync_reauth_required`, `sync_failed` |

All extend `DomainError<TCode>` which carries `code` + `detail` across the IPC boundary (re-attached as enumerable own properties on the thrown Error so they survive structured-clone serialization).

Use `ipcErrorShape(err)` to extract `{ code, message, detail? }` for inline `{ success: false, error }` responses.

## Activation Gate

`userActivation.requireActivated()` is the first call inside every user-scoped IPC handler. Auth handlers (`auth:*`) are NOT gated — they are the activation mechanism. MessagePort handlers use `userActivation.isActivated()` since they can't throw.

## DTO Conventions

- Encrypted blobs are masked: `apiKeyEncrypted: Buffer | null` → `hasApiKey: boolean`
- Token presence: `cinnaAccessTokenEnc + cinnaRefreshTokenEnc` → `hasCinnaTokens: boolean`
- Live state from a manager (e.g. MCP `status`, `tools`, `error`) is merged into the DTO at service-layer DTO mapping time
- Renderer never sees raw rows — services always wrap with `toDto(row)` helpers

## When Adding a New Domain

1. Create `db/<entity>.ts` with `<entity>Repo` (CRUD + `getOwned(userId, id)`)
2. Add a domain error class in `errors.ts` with the code union
3. Create `services/<entity>Service.ts` with DTO mapping, validation, encryption, side effects
4. Create `ipc/<entity>.ipc.ts` with `ipcHandle()`-wrapped handlers that `requireActivated()` → delegate
5. Register in `ipc/index.ts`
6. Expose via `preload/index.ts` and add `userId`-aware migration for any new table
