# Boot Resilience

## Purpose

Make sure that any failure during app startup — or a renderer crash afterwards — produces a visible, debuggable signal to the user instead of a "ghost app" (menu visible, no window). Also enforce migration ordering so that fresh installs can't regress to the same class of silent crash.

## Core Concepts

| Term | Definition |
|------|-----------|
| **Ghost app** | The failure mode this feature exists to prevent: the application menu is visible but no window ever opens, because main-process startup threw silently before `createWindow()` ran |
| **Startup phase** | The window between `app.whenReady()` firing and `startupComplete = true` being set at the end of `startup()` — failures here are unrecoverable and end with a native error dialog + exit |
| **Post-startup phase** | Anything after `startupComplete = true` — unhandled errors are logged but the app keeps running, since transient failures from LLM/MCP/auto-updater shouldn't kill the app |
| **Fatal error log** | `cinna-errors.log` in the user data directory — append-only record of every routed unhandled error, with size-based rotation |
| **Renderer failure** | A crash or load failure in the renderer process — distinct from main-process failures because Node's exception handlers don't see it; surfaced through Electron `webContents` events |

## User Stories / Flows

### Fatal startup failure

1. User launches the app (often the very first launch on a fresh machine)
2. Something throws during DB init, IPC registration, or session setup
3. Instead of seeing only the menu bar with no window, the user gets a native error dialog: "Cinna Desktop failed to start" with the error message and the path to `cinna-errors.log`
4. Dialog is dismissed → app exits with code `1`
5. User can open `cinna-errors.log` to see the stack trace, or share it when reporting the issue

### Post-startup unhandled error

1. App is running normally
2. An async path throws an unhandled rejection (e.g. LLM SDK network blip, MCP server disconnect, auto-updater error)
3. Error is appended to `cinna-errors.log` and broadcast through the scoped logger (visible in the Cmd+\` overlay)
4. App keeps running — no dialog, no force-quit

### Renderer crash

1. Renderer process crashes, runs out of memory, or fails to load the initial HTML
2. Without this feature the user would see a blank window and have to force-quit
3. Dialog appears: "Cinna Desktop renderer failed" with the crash reason
4. In packaged builds the app exits afterwards; in dev mode it stays alive so DevTools / hot reload can recover

### Fresh install (no log, no DB)

1. App launches for the very first time — `userData/` is empty
2. Foreign-key enforcement is disabled for the duration of migrations (re-enabled immediately after), so table-creation order can't trip a `no such table` failure: SQLite resolves `ON DELETE CASCADE` chains at statement-prepare time, so an early migration that runs DML on a table whose FK points at a parent created by a *later* migration (e.g. `migrateChats`'s trashed-chat `DELETE` cascading through `chat_on_demand_agents → agents`) would otherwise throw even with zero rows
3. Migration ordering runs `users → providers → mcp → agents → chats → ...` and finally backfills `user_id` columns on legacy tables (now guarded by `hasTable`, so it skips tables that haven't been created yet on fresh installs)
4. Window opens normally

## Business Rules

- Startup failures are always fatal: log to disk + show native dialog + `app.exit(1)`
- Post-startup unhandled errors never kill the app — they're logged only
- The boundary between "startup" and "post-startup" is `startupComplete = true`, set at the very end of `startup()` after `createWindow()` and `initAutoUpdater()`
- `cinna-errors.log` is rotated to `.old` on next launch if it grew past 1 MB
- The native error dialog is best-effort: it may be unavailable before `whenReady`, in which case the error is still logged to disk and console
- Renderer crashes are distinct from main-process exceptions and require their own `webContents` listeners
- Renderer dev-mode failures don't auto-exit (preserves DevTools session)
- Migration ordering rule: any `ALTER TABLE` against a table not owned by the current migration must be guarded with `hasTable()` and must run **after** all table-creation migrations
- FK-safety rule: foreign-key enforcement is turned **off** for the whole migration pass and re-enabled afterward, so neither a forward FK reference in a `CREATE TABLE` nor a DML statement that triggers a cascade can fail when the referenced table is created by a later migration. Table-creation order (parents before children, e.g. `agents` before `chats`) is still maintained as defense-in-depth, not as the sole guard

## Architecture Overview

```
                     ┌─────────────────────────────────────────┐
                     │ process.on('uncaughtException'|         │
                     │             'unhandledRejection')       │
                     └────────────────────┬────────────────────┘
                                          │
                                          ▼
  ┌─────────────────────┐         ┌──────────────────┐         ┌───────────────────────┐
  │ app.whenReady()     │ throws  │   handleFatal    │         │ webContents.on(       │
  │   try { startup() } ├────────►│                  │◄────────┤   'render-process-gone'│
  │   catch(handleFatal)│         │  startupComplete?│         │   'did-fail-load')    │
  └─────────────────────┘         │   yes → log only │         │           │           │
                                  │   no  → dialog + │         │           ▼           │
                                  │         exit     │         │ handleRendererFailure │
                                  └────────┬─────────┘         │   log + dialog +      │
                                           │                   │   exit (prod only)    │
                                           ▼                   └───────────────────────┘
                                  ┌──────────────────┐
                                  │ append to        │
                                  │ cinna-errors.log │
                                  │ + bootLogger     │
                                  └──────────────────┘
```

## Integration Points

- **[Logger](../../development/logger/logger.md)** — post-startup errors are routed through `createLogger('boot')` so they appear in the Cmd+\` overlay
- **[Resource Activation](../resource_activation/resource_activation.md)** — startup phase ends *before* user activation runs; activation failures are post-startup and don't trigger the fatal path
- **[Setup](../../development/setup/setup.md)** — `cinna-errors.log` lives in the platform-specific Electron `userData` directory referenced in the dev guide
