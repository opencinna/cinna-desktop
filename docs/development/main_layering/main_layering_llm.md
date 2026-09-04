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
- All other handlers let DomainError flow through `ipcHandle`. **The renderer's `invoke()` rejects with the message only — the code does NOT survive.** See "Errors" below before writing any renderer branch on `err.code`

## Errors — `src/main/errors.ts`

Every domain has a typed error class with a string-literal code union:

| Class | Codes |
|-------|-------|
| `AuthError` | `not_found`, `username_taken`, `username_required`, `password_required`, `password_too_weak`, `invalid_password`, `default_user_immutable`, `oauth_failed`, `missing_server_url` |
| `ProviderError` | `not_found`, `unsupported_type`, `missing_api_key`, `not_activated` |
| `McpError` | `not_found`, `not_activated`, `invalid_transport`, `connect_failed` |
| `ChatError` | `not_found`, `not_configured`, `adapter_unavailable`, `not_activated` |
| `AgentError` | `not_found`, `not_activated`, `unsupported_protocol`, `no_card_url`, `no_endpoint`, `remote_immutable`, `invalid_id`, `sync_reauth_required`, `sync_failed` |

**The table above is a sample, not the roster.** `errors.ts` defines 14 `DomainError` subclasses at `12686f0` (adding `KitError`, `LocalAgentError`, `LocalToolsError`, `ChatModeError`, `AgentStatusError`, `JobError`, `NoteError`, `CinnaApiError`). Read `errors.ts` for the current set; counted on 4 Sep 2026 by reading the `export class … extends DomainError` lines.

All extend `DomainError<TCode>`, which carries `code` + `detail` **inside the main process**.

### `code` does NOT reach the renderer — two boundaries discard it

This paragraph previously claimed the opposite ("re-attached as enumerable own properties … so they survive structured-clone serialization"). **That was never true at any commit**, and `src/main/ipc/_wrap.ts` says so in its own docstring, which records the same false claim being fixed there after `isStaleWriteError` silently answered `false` for every refused write until it was probed in a running app. Corrected here at `12686f0` on 4 Sep 2026 by reading `_wrap.ts:32-99` and `errors.ts:191-215`.

1. `ipcMain.handle` serialises a rejection to `message` + `stack` only, and rewrites the message as `Error invoking remote method '<channel>': <Class>Error: <message>`.
2. `contextBridge` then clones whatever preload throws into the renderer's world as a fresh `Error` — so re-attaching the code in preload does not help either; it lands on the wrong side of this one.

What the renderer receives is a plain `Error` whose only own properties are `message` and `stack`. `ipcHandle` still sets `outbound.code` faithfully, and that is still worth doing — it is read by callers *inside* main and it makes the logged error self-describing. **It is not a wire contract.**

**So a handler whose failure code must drive renderer behaviour has to return the code as data rather than throw it.** Two established shapes:

- `{ success: false, code, error }` — the older, more widespread convention. The renderer builds the `Error` and sets `.code` itself (`useAgents.ts:234` `useApplyBundleUpdate` is the worked example), so the code never goes near the wire.
- `LocalAgentOutcome<T>` in `src/shared/localAgents.ts` — main returns `{ok: false, code, name, message}` and the **renderer**, not preload, turns it back into a throw.

**A renderer `catch` that reads `err.code` off a rejected `invoke()` is a silent no-op**, and it looks correct in review. Check what the channel does before writing one: a handler that catches internally and returns an outcome gives you a code; a bare `ipcHandle` that lets a `DomainError` throw does not.

**This defect class is invisible to ordinary testing**, which is why it keeps recurring. The branch is unreachable rather than wrong, so nothing throws, nothing logs, and the code reads correctly at the call site — `isStaleWriteError` answered `false` for every genuinely stale write and the reload prompt it gates simply never appeared. `src/main/ipc/localAgentOutcome.test.ts` exists specifically because *"the property being restored is invisible at every call site … so nothing else would notice it breaking again."* A test that asserts the outcome shape is the only thing that catches a regression here.

**The fullest treatment, with the two channels that motivated the outcome shape and the reason unwrapping must happen in the renderer rather than in preload, is [Agents Tab & Agent Page](../../agents/local_agents/agents_tab.md) → "IPC error codes do not survive a thrown rejection".** Read it before adding a channel whose failure code drives behaviour. It is linked here rather than restated because this file having said the *opposite* for as long as it did is what let a reader find support for either belief and act on whichever they met first.

For a failure that is only ever *shown as a sentence*, throwing is fine — but strip the transport first. `src/renderer/src/utils/ipcError.ts` `unwrapIpcError(err, fallback)` removes the `Error invoking remote method '<channel>': ` prefix and the leading `<Class>Error: `, so the user reads the sentence main authored rather than the name of our IPC channel.

Use `ipcErrorShape(err)` to extract `{ code, message, detail? }` for inline `{ success: false, error }` responses — main-side, before the value crosses.

## Logging — `src/main/logger/logger.ts`

- `createLogger('domain')` from `logger/logger.ts`. **109 files import it at `12686f0`** — 76 non-test modules under `src/main/`, the rest tests (counted by grep on 4 Sep 2026). That population is why the next rule exists.
- **`logger/logger.ts` must stay importless.** No `electron`, no `../index`, nothing. An import there is paid for by every caller: it used to import `getMainWindow` from `src/main/index.ts` so it could broadcast to the renderer itself, so a test of a pure function three layers away had to stub the logger and `db/client` just to *load* — and a file that fails to load reports as a **smaller test count**, not as a failure (importing `kit/validator.ts` into one pure test dropped the suite 991 → 977 with nothing to point at).
- **The renderer broadcast is a sink, installed from the entry point.** `logger.ts` exposes `setLogSink(fn | null)`; `logger/broadcast.ts` holds the Electron half and takes the window getter **as an argument** — importing `getMainWindow` there would move the cycle rather than cut it. `index.ts` owns the window, so `index.ts` supplies it. `broadcast.ts`'s only import is type-only and erased at compile time.
- **Apply the same test to any new cross-cutting module.** If most of `src/main/` will import it, it may not import anything that reaches `index.ts` or `electron` at runtime. `src/main/sync/identity.ts` and `src/shared/kit/manifest.ts` are held to this for the same reason.
- Full detail: [Logger](../logger/logger.md) and [Logger — Technical Details](../logger/logger_tech.md).

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
