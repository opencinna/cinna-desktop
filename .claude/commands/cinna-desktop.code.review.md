---
description: Review Electron app architecture for proper layering, separation of concerns, and best practices.
---

## User Input

```text
$ARGUMENTS
```

Optional: Domain name (e.g., "chat", "auth"), file paths, or feature area to review.

## Context Detection

Determine review scope in this order:

1. **Explicit Arguments** - If user provides domain, file paths, or feature area, review those files
2. **Conversation History** - If recent implementation work exists, review those files
3. **Git Changes** - If no context, run `git diff --name-only` to find modified files

Map files to their architectural layer:
- `src/main/ipc/*.ts` - IPC handlers (controller layer)
- `src/main/db/` - Database schema, client, migrations, repositories
- `src/main/llm/` - LLM adapters and registry
- `src/main/mcp/` - MCP connection manager
- `src/main/auth/` - Authentication and session management
- `src/main/agents/` - A2A client and remote sync
- `src/main/security/` - Keystore (safeStorage encryption)
- `src/main/logger/` - Centralized logging
- `src/preload/` - contextBridge API surface
- `src/renderer/src/hooks/` - React Query hooks (data fetching)
- `src/renderer/src/stores/` - Zustand stores (UI state)
- `src/renderer/src/components/` - React components (view layer)

## Review Checklist

### 1. Service Layer & IPC Handler Discipline

IPC handlers must be **thin controllers** — extract params, call a service, return the result. All business logic belongs in dedicated service classes.

**Flag these patterns in IPC handlers:**
- Direct Drizzle queries (any `db.select/insert/update/delete` call)
- Conditional business logic (if/else rules, state transitions, default-clearing)
- Multi-step orchestration (e.g., persist + encrypt + register adapter in one handler)
- Data transformation or computation beyond simple mapping
- Multiple service/system calls coordinated together

**What a clean IPC handler looks like:**
```
ipcMain.handle('domain:action', async (_event, args) => {
  userActivation.requireActivated()
  return domainService.action(getCurrentUserId(), args)
})
```

**Service classes should:**
- Own all business rules and orchestration
- Accept userId and typed input, return typed output
- Be testable without Electron (no ipcMain dependency)
- Use repository layer for data access
- Raise domain-specific errors

### 2. Repository / Data Access Layer

Database queries should be encapsulated in repository objects or classes, not scattered across IPC handlers or services.

**Flag these patterns:**
- `getDb()` called outside of a repository module
- Drizzle query chains in IPC handlers or service methods
- Same query pattern repeated across multiple handlers (e.g., "get entity + check ownership")
- Missing `userId` filter in WHERE clauses (authorization gap)
- No transaction wrapping for multi-step writes

**Reference implementation:** `src/main/db/messages.ts` (`messageRepo`) — the only existing repository abstraction. All domains should follow this pattern.

**Repository should provide:**
- Typed CRUD methods per entity (e.g., `chatRepo.list(userId)`, `chatRepo.getOwned(userId, chatId)`)
- Ownership verification built into retrieval methods (always filter by userId)
- Transaction-wrapped multi-step operations
- No business logic — pure data access with ownership scoping

### 3. Authorization & Ownership Checks

Every data operation must verify the requesting user owns or has access to the resource.

**Flag these patterns:**
- `chat:update`, `chat:delete` etc. without `eq(entity.userId, userId)` in WHERE
- Handlers that accept an entity ID from renderer without verifying ownership
- Missing `userActivation.requireActivated()` at handler entry
- Row-level access checks absent — only session-level auth present

**Correct pattern:** Every query that reads/modifies a specific entity must include `eq(entity.userId, getCurrentUserId())` or use a repository method that does this automatically.

### 4. Error Handling Consistency

Errors must cross the IPC boundary in a predictable, typed structure.

**Flag these patterns:**
- Mixed return styles: some handlers return `{ success, error }`, others throw, others use port messages
- Raw `throw new Error(msg)` in handlers (custom error fields lost during serialization)
- Missing try/catch in handlers that call external services (LLM SDKs, HTTP, MCP)
- Error swallowing: `catch(err) {}` or `catch(err) { console.log(err) }` without re-throw or user notification
- No distinction between user-facing message and technical detail

**Recommended pattern:**
- Define domain error classes (e.g., `ProviderError`, `ChatError`) with `code` and `message`
- IPC handlers catch domain errors and return `{ success: false, error: { code, message } }`
- Streaming handlers send errors via port with `{ type: 'error', error: shortMsg, errorDetail: fullMsg }`
- All errors logged with full context before returning

### 5. Logger Integration

All external communication and significant operations must be logged with the scoped logger.

**Flag these patterns:**
- HTTP/SDK calls without request/response logging (LLM API calls, MCP connections, A2A requests, OAuth flows)
- Missing `createLogger(scope)` in a module that performs I/O or business logic
- Sensitive data in logs: API keys, tokens, passwords, full request bodies with credentials
- Logger used in main process modules but specific operations not traced (e.g., which model was called, response time, token usage)
- No error logging before returning error to renderer

**What should be logged:**
- External API calls: method, endpoint/provider, duration, status, error details
- State transitions: user login/logout, provider enable/disable, MCP connect/disconnect
- Business operations: chat create/delete, agent registration, mode switching
- Errors: full stack trace + operation context + relevant IDs

### 6. Separation of Concerns (Renderer)

The renderer must only handle UI rendering and user interaction. Data fetching, caching, and mutations go through hooks. Persistent UI state goes through stores.

**Flag these patterns in components:**
- Direct `window.api.*` calls inside components (should go through hooks)
- Business logic or data transformation in components (should be in hooks or utils)
- Component state (`useState`) used for data that should be in a Zustand store (shared across components)
- Zustand store containing server state that should be managed by React Query
- Props drilled through 4+ component layers (use store or context instead)

**Correct layering:**
```
Component (renders UI, calls hook methods)
  -> Hook (useQuery/useMutation wrapping window.api calls)
    -> Store (Zustand, for local UI state: active chat, streaming state, sidebar toggle)
```

**React Query responsibilities:** Server state caching, background refetch, optimistic updates, loading/error states
**Zustand responsibilities:** UI-only state (active selections, toggles, streaming buffers, ephemeral UI state)

### 7. IPC Contract & Type Safety

IPC channels must be typed end-to-end: handler input -> handler output -> preload bridge -> renderer call site.

**Flag these patterns:**
- Untyped or `any`-typed IPC channel parameters
- Preload bridge methods with loose types that don't match handler signatures
- Missing input validation at handler entry (accepting arbitrary objects from renderer)
- IPC channel names as magic strings scattered through codebase (should be in a registry or typed constants)
- Handler accepting fields that get passed directly to DB without validation (mass assignment risk)

### 8. Security

**Flag these patterns (critical):**
- `nodeIntegration: true` or `contextIsolation: false` in BrowserWindow config
- `webSecurity: false` or `allowRunningInsecureContent: true`
- Raw `ipcRenderer` or `require` exposed via contextBridge
- API keys, tokens, or passwords in renderer-accessible state (should only have `hasApiKey: boolean`)
- `eval()`, `new Function()`, or `innerHTML` with user-controlled content
- Missing CSP headers or overly permissive CSP (`unsafe-inline`, `unsafe-eval`, wildcard origins)
- Credentials stored in plaintext (must use `safeStorage`)

### 9. External Communication Observability

All calls to external systems (LLM APIs, MCP servers, A2A agents, OAuth endpoints, Cinna backend) must be observable and debuggable.

**Flag these patterns:**
- HTTP/SDK calls without timing measurement (no way to debug latency)
- Missing correlation between a user action and the resulting API calls
- No retry logic for transient failures (network errors, 5xx, rate limits)
- External errors not surfaced to the user (silently swallowed)
- No way for user to inspect recent external calls in the logger UI

**What observability looks like:**
- Each external call logged: `logger.info('LLM request', { provider, model, chatId })` before, `logger.info('LLM response', { provider, model, duration, tokens })` after
- Errors logged with full context: `logger.error('LLM failed', { provider, model, chatId, error })`
- Logger UI (Cmd+`) shows chronological trace of all external calls with timing

## Output Format

Generate a review report with:

### Summary
Brief overview of findings (2-3 sentences). State the overall architectural health and top priorities.

### Critical Issues

For each issue:
```
**Issue:** [Brief description]
**Location:** [file:line_number]
**Category:** [Service Layer | Repository | Auth | Error Handling | Logger | Separation | IPC Types | Security | Observability]
**Pattern:** [What's wrong — the anti-pattern detected]
**Impact:** [Why this matters — security risk, maintainability, testability, reliability]
**Fix:** [Specific recommendation with target file/class name]
```

### Warnings
Same format as Critical Issues, for less severe concerns.

### Good Patterns Found
Acknowledge existing patterns that follow best practices (reinforces what to keep doing).

### Recommended Refactoring

Prioritized list of architectural improvements:

1. **[Priority] Description** - What to create/change, which files are affected, what the result looks like

### Architecture Scorecard

| Category | Score | Notes |
|----------|-------|-------|
| Service Layer | 1-5 | Are IPC handlers thin? |
| Repository Layer | 1-5 | Is DB access abstracted? |
| Authorization | 1-5 | Row-level ownership checks? |
| Error Handling | 1-5 | Consistent, typed, logged? |
| Logger Coverage | 1-5 | External calls traced? |
| Renderer Separation | 1-5 | Hooks/stores/components layered? |
| IPC Type Safety | 1-5 | End-to-end typed channels? |
| Security | 1-5 | Electron security hardened? |
| Observability | 1-5 | External calls debuggable? |

## Reference Implementations

**Good pattern (repository):** `src/main/db/messages.ts` — `messageRepo` encapsulates all message DB operations
**Good pattern (renderer):** `src/renderer/src/hooks/useChat.ts` — React Query wrapping window.api calls
**Good pattern (logger):** `src/main/logger/logger.ts` — scoped logger with UI broadcast
**Good pattern (security):** `src/main/security/keystore.ts` — safeStorage abstraction

## Execution Steps

1. **Identify Scope** - Determine files from arguments, history, or git diff
2. **Read IPC Handlers** - Check for business logic, direct DB access, missing auth
3. **Read DB Layer** - Check for repository abstractions, scattered queries
4. **Read Services** - Check if they exist, what they encapsulate
5. **Read Renderer** - Check hook/store/component layering
6. **Check Logger Usage** - Verify external calls are logged with context
7. **Check Security Config** - Verify Electron security flags and credential handling
8. **Score Each Category** - Rate 1-5 based on findings
9. **Generate Report** - List issues, warnings, good patterns, and refactoring plan

Do NOT make changes automatically. Present the review report and wait for user approval before implementing.
