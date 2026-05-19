# Boot Resilience — Technical Details

## File Locations

### Main Process

| Layer | File | Purpose |
|-------|------|---------|
| Entry | `src/main/index.ts` | `handleFatal`, `handleRendererFailure`, `rotateStartupLog`, `startupComplete` flag, `startup()` wrapper |
| DB Bootstrap | `src/main/db/client.ts` | `runMigrations()` — ordered migration sequence, `migrateUserIdColumns` runs last |
| Migrations | `src/main/db/migrations/users.ts` | `migrateUsers` (users table only) + `migrateUserIdColumns` (backfills `user_id` on legacy tables) |
| Migration helpers | `src/main/db/migrations/helpers.ts` | `hasTable`, `hasColumn` — guard against ALTER on non-existent tables |
| Logger | `src/main/logger/logger.ts` | `createLogger('boot')` instance used by `handleFatal` post-startup |

### Renderer

No renderer-side code — this feature is entirely main-process. Renderer crashes are detected by `webContents` listeners registered in `createWindow()`.

## Key Functions

### `src/main/index.ts`

- `handleFatal(err, phase)` — entry point for `process.on('uncaughtException')` and `'unhandledRejection'`, plus the explicit `try/catch` around `startup()`. Branches on `startupComplete`:
  - **Pre-startup** → `console.error` + `dialog.showErrorBox` + `app.exit(1)`
  - **Post-startup** → `bootLogger.error(...)` (which writes to console + buffer + renderer overlay)
  - Always tries to append to `cinna-errors.log` first
- `handleRendererFailure(reason, details)` — wired to `webContents.on('render-process-gone')` and `on('did-fail-load')`. Logs via `bootLogger.error('renderer-failure', …)`, shows a native dialog, and exits in production only (`!is.dev`)
- `rotateStartupLog()` — first call inside `startup()`. If `cinna-errors.log` exceeds `STARTUP_LOG_MAX_BYTES` (1 MB) it's renamed to `cinna-errors.log.old`
- `startup()` — extracted from the `whenReady` callback so the outer `try/catch` can catch synchronous throws. Sets `startupComplete = true` at the very end after `createWindow()` and `initAutoUpdater()`
- `startupLogPath()` — resolves `app.getPath('userData') + 'cinna-errors.log'`; called lazily so it tolerates being invoked before `whenReady`

### `src/main/db/client.ts`

- `runMigrations()` — fixed sequence:
  1. `migrateUsers` — creates the `users` table + Cinna account columns
  2. `migrateProviders` / `migrateMcp` / `migrateChats` / `migrateMessages` / `migrateChatModes` / `migrateAgents` / `migrateAgentOverrides` / `migrateA2aSessions` / `migrateChatAgentSessions` — table creation
  3. `migrateUserIdColumns` — **must run last**; backfills `user_id` on `llm_providers`, `mcp_providers`, `chats`, `chat_modes`, `agents`

### `src/main/db/migrations/users.ts`

- `migrateUsers(sqlite)` — creates `users` table, inserts `__default__` user if absent, adds Cinna account columns
- `migrateUserIdColumns(sqlite)` — for each of `llm_providers`, `mcp_providers`, `chats`, `chat_modes`, `agents`: skip if `hasTable()` returns false, else `ALTER TABLE … ADD COLUMN user_id` if `hasColumn()` returns false

## Event Listeners

| Event | Location | Routes to |
|-------|----------|-----------|
| `process.on('uncaughtException')` | `src/main/index.ts` | `handleFatal(err, 'uncaughtException')` |
| `process.on('unhandledRejection')` | `src/main/index.ts` | `handleFatal(reason, 'unhandledRejection')` |
| `webContents.on('render-process-gone')` | `src/main/index.ts` `createWindow()` | `handleRendererFailure` (skipped when `details.reason === 'clean-exit'`) |
| `webContents.on('did-fail-load')` | `src/main/index.ts` `createWindow()` | `handleRendererFailure` (skipped when `errorCode === -3` / `ERR_ABORTED`) |

## Configuration

| Constant | Default | Notes |
|----------|---------|-------|
| `STARTUP_LOG_NAME` | `cinna-errors.log` | File name inside the Electron `userData` directory |
| `STARTUP_LOG_MAX_BYTES` | `1024 * 1024` (1 MB) | Threshold for rotation to `.old` on next launch |

No environment variables — behavior is hardwired so it works on the very first launch.

## Security

- The error dialog and log include error messages and stack traces. The scoped logger (`createLogger('boot')`) runs the same `redact()` pipeline used elsewhere — sensitive keys (`api_key`, `access_token`, `password`, etc.) are masked when error objects carry structured data fields
- Direct stack-trace strings written to `cinna-errors.log` via `appendFileSync` are *not* redacted — file lives in user-owned `userData/` and is intended for local debugging; do not include credentials in error messages thrown from main-process code
- `app.exit(1)` is used (not `app.quit()`) for fatal paths to skip `will-quit` handlers that might themselves throw

## Failure Modes Covered

| Failure | Detection | Outcome |
|---------|-----------|---------|
| Throw inside `startup()` (sync) | Outer `try/catch` in `whenReady` callback | Native dialog + exit |
| Throw inside `startup()` (async / promise) | `process.on('unhandledRejection')` | Native dialog + exit (still pre-`startupComplete`) |
| Uncaught exception from later async work | `process.on('uncaughtException')` | Logged via `bootLogger`, app survives |
| Renderer process crash / OOM | `webContents.on('render-process-gone')` | Native dialog + exit (prod), log only (dev) |
| Renderer fails to load HTML / dev server down | `webContents.on('did-fail-load')` | Native dialog + exit (prod), log only (dev) |
| Fresh-install migration order | `hasTable` guard in `migrateUserIdColumns` + reordering | ALTER skipped on missing tables, runs after creation migrations |

## Reference Implementations

The renderer-failure handler doubles as a template for future "surface a fatal condition" paths — log + dialog + conditional exit. The dev-vs-prod split (`!is.dev`) is the convention to follow whenever the app needs to terminate based on a user-visible failure.
