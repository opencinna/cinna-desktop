# Logger

## Purpose

In-app debug logger for tracing activity across the main and renderer processes — especially communication with external services (Cinna OAuth, A2A agents, MCP servers) — surfaced through a toggleable full-window overlay in the app itself, so developers don't need the terminal open to see what's happening.

## Core Concepts

- **Log Entry** — A single record with `id`, `timestamp`, `level` (`debug`/`info`/`warn`/`error`), `scope` (e.g. `A2A`, `cinna-oauth`, `MCP`), `source` (`main` or `renderer`), `message`, and optional structured `data`
- **Scope** — A string tag identifying the subsystem that emitted the entry; created once per module via `createLogger(scope)` and reused for every call
- **Logger Enabled** — User-level toggle persisted in localStorage (`cinna-logger-enabled`); when off, the log icon and overlay are hidden and the keyboard shortcut is a no-op
- **Ring Buffer** — Both main and renderer cap stored entries at 2000; oldest entries are dropped on overflow
- **Logs Overlay** — Full-window (with ~5vmin padding) panel that renders entries terminal-style with filtering, auto-scroll, and clear

## User Stories / Flows

### Enabling the logger
1. User opens Settings > Development > Debug
2. Toggles "Enable Logger" on — a terminal icon appears in the sidebar footer (left of the theme switch)
3. Clicks the terminal icon (or presses ⌘` / ⌘~) to open the overlay
4. Interacts with the app; log entries stream into the overlay live

### Reading logs
1. Entries render with timestamp, level badge, `[source]`, `[scope]`, and message
2. User can type in the filter box to narrow by scope, source, or message text
3. Level toggles (DBG/INF/WRN/ERR) hide entries of that level
4. Clicking a row with attached `data` expands to show the JSON payload
5. Auto-scroll follows new entries; can be paused via the pause button

### Debugging an external service error
1. User enables logger, opens overlay, triggers the failing action (e.g. Cinna self-hosted login)
2. Entries scoped `cinna-oauth` / `auth` show: the exact URL requested, HTTP status, response body (trimmed), and any thrown error
3. User copies the relevant data and diagnoses the root cause

### Adding logging to a new subsystem
1. Developer imports `createLogger` from the logger module (main or renderer)
2. Creates a scoped logger at the top of the module: `const logger = createLogger('my-scope')`
3. Calls `logger.debug/info/warn/error(message, data?)` wherever useful
4. Entries flow through the same buffer and overlay with no extra wiring

## Business Rules

- The overlay is mounted regardless of `loggerEnabled` — it simply renders nothing until `logsOpen` is true
- The keyboard shortcut (`⌘`` / `⌘~`) is registered as a real Electron menu accelerator so that macOS does not consume it for "Cycle Through Windows"
- The shortcut is a no-op when the logger is disabled — turning the toggle off also closes the overlay if it's open
- The renderer-side store lazily subscribes to the main-process broadcast the first time the overlay is opened; before then, no IPC traffic happens for the logger
- Disabling the logger does **not** stop emitting entries in the main process — they still land in the main-process buffer and will become visible if the user re-enables the logger and opens the overlay
- The logger is **not** a persistence mechanism — entries live only in memory for the current session
- `console.log/warn/error/debug` is still called in parallel with every structured entry, so terminal-based dev workflows are unaffected
- Entries attach serialized `data` — Errors are reduced to `{name, message, stack}`; all other values go through `JSON.parse(JSON.stringify(...))` with a string fallback so circular references don't crash the logger

## Architecture Overview

```
Main subsystem -> createLogger('scope').info(msg, data)
  -> push to main ring buffer
  -> webContents.send('logger:entry', entry) -> Renderer
  -> also console.log for terminal

Renderer subsystem -> createLogger('scope').info(msg, data)
  -> ipcRenderer.invoke('logger:log', payload)
  -> Main: logEntry(source='renderer', ...) -> same ring buffer + broadcast

LogsOverlay (on first open)
  -> window.api.logger.getAll() -> seeds renderer ring buffer
  -> window.api.logger.onEntry(handler) -> appends new entries

Menu accelerator (⌘` / ⌘~)
  -> Main 'View' menu click handler
  -> webContents.send('logger:toggle-overlay')
  -> Renderer toggles ui.store.logsOpen (gated on loggerEnabled)
```

## Integration Points

- **UI / Settings** — Switch lives in the new `development` settings tab; see [Settings](../../ui/settings/settings.md)
- **Sidebar** — Terminal icon in footer is conditionally rendered on `loggerEnabled`
- **Existing subsystems** — `A2A`, `a2a-client`, `MCP`, `cinna-oauth`, `auth`, `remote-sync` scopes already route their operational logs through this module; see [MCP Connections](../../mcp/connections/connections.md), [Agents](../../agents/agents/agents.md), [Cinna Accounts](../../auth/cinna_accounts/cinna_accounts.md)
