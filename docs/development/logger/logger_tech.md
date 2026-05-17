# Logger — Technical Details

## File Locations

### Main Process
- `src/main/logger/logger.ts` — Ring buffer, `logEntry()`, `createLogger(scope)`, `getLogEntries()`, `clearLogEntries()`; broadcasts each entry on channel `logger:entry` via `getMainWindow().webContents.send`
- `src/main/ipc/logger.ipc.ts` — `registerLoggerHandlers()` — exposes `logger:get-all`, `logger:clear`, `logger:log`
- `src/main/ipc/index.ts` — Calls `registerLoggerHandlers()` first in `registerAllIpcHandlers()`
- `src/main/index.ts` — Builds the `View` application menu with two accelerators (`CommandOrControl+\``, `CommandOrControl+Shift+\``) that both `webContents.send('logger:toggle-overlay')`
- `src/main/auth/cinna-oauth.ts` — Scope `cinna-oauth` (fetch URLs, HTTP status, response bodies)
- `src/main/ipc/auth.ipc.ts` — Scope `auth` (register/login start + top-level catch)
- `src/main/ipc/agent_a2a.ipc.ts` — Scope `A2A` (fetch-card, test, send-message error paths)
- `src/main/agents/a2a-client.ts` — Scope `a2a-client` (raw card fetch, protocol resolution)
- `src/main/agents/remote-sync.ts` — Scope `remote-sync`
- `src/main/mcp/manager.ts` — Scope `MCP`

### Preload
- `src/preload/index.ts` — `window.api.logger.{getAll, clear, log, onEntry, onToggleOverlay}`; defines `LogEntry` and `LogLevel` types

### Renderer
- `src/renderer/src/stores/logger.store.ts` — Zustand `useLoggerStore`; holds entries + subscription state; `createLogger(scope)` for renderer code; `append`, `setAll`, `clear`, `log`, `subscribe`
- `src/renderer/src/stores/ui.store.ts` — `loggerEnabled`, `logsOpen`, `setLoggerEnabled`, `setLogsOpen`; persists `loggerEnabled` to `localStorage('cinna-logger-enabled')`
- `src/renderer/src/components/logger/LogsOverlay.tsx` — Overlay shell + header (filter input, level toggles, count, selection copy/clear, pause, clear, close); `LogRow` sub-component; subscribes to `onToggleOverlay` and handles `Escape`. Owns selection state (`selected: Set<id>`, `anchorIndex`, `dragRef`), expand state (`expandedIds: Set<id>`, lifted out of the row), and the `formatEntryForCopy` helper.
- `src/renderer/src/components/settings/DevelopmentSettingsSection.tsx` — "Debug" section with "Enable Logger" switch
- `src/renderer/src/components/settings/SettingsPage.tsx` — Wires `development` tab to `DevelopmentSettingsSection`
- `src/renderer/src/components/layout/Sidebar.tsx` — Adds `Development` menu item (before the Trash separator); renders terminal icon in footer when `loggerEnabled`
- `src/renderer/src/App.tsx` — Mounts `<LogsOverlay />` inside `AuthGate`

## Database Schema

None — logger is in-memory only.

## IPC Channels

| Channel | Type | Purpose |
|---------|------|---------|
| `logger:get-all` | invoke | Returns full main-process buffer (`LogEntry[]`); called once when overlay first opens |
| `logger:clear` | invoke | Clears the main-process buffer; renderer also clears its local copy |
| `logger:log` | invoke | Renderer-originated log entry; main tags it with `source: 'renderer'` and broadcasts |
| `logger:entry` | send (main → renderer) | Broadcast of a newly appended entry |
| `logger:toggle-overlay` | send (main → renderer) | Fired by the `View` menu accelerators (⌘` / ⌘~) |

## Services & Key Methods

- `src/main/logger/logger.ts:logEntry(level, scope, source, message, data?)` — Assigns id, timestamps, serializes data, pushes to buffer, broadcasts to renderer, mirrors to `console.*`
- `src/main/logger/logger.ts:createLogger(scope)` — Returns `{debug, info, warn, error}` bound to `logEntry(..., source='main', ...)`
- `src/main/logger/logger.ts:serializeData(data)` — Converts `Error` to `{name, message, stack}`; all other values via `JSON.parse(JSON.stringify(...))` with `String(data)` fallback for circular/non-serializable values
- `src/renderer/src/stores/logger.store.ts:subscribe()` — Guards against double-subscription; seeds state with `getAll()`, then wires `onEntry` listener
- `src/renderer/src/stores/logger.store.ts:createLogger(scope)` — Renderer convenience; each call goes through `window.api.logger.log`
- `src/renderer/src/stores/ui.store.ts:setLoggerEnabled(enabled)` — Writes `cinna-logger-enabled` localStorage key; forces `logsOpen: false` when disabling

## Renderer Components

- `LogsOverlay` — Reads `logsOpen`, `setLogsOpen` from `ui.store`; `entries`, `subscribe`, `clear` from `logger.store`. Subscribes on first open. Keyboard: `Escape` clears the selection if non-empty, otherwise closes; `⌘`` / `⌘~` handled via `onToggleOverlay` IPC listener (not DOM keydown). Drag selection is finalized by a single `window` `mouseup` listener that clears the `dragRef`.
- `LogRow` — Row body is a `<div>` (not a `<button>`) so `mouseenter` fires while a mouse button is held down — that's how drag-extend works. Three pointer paths: chevron click → `onChevronClick` toggles `expandedIds`; row `mousedown` → `onMouseDown` mutates `selected` based on `shift` / `meta|ctrl` modifiers and seeds `dragRef`; row `mouseenter` while `dragRef` is set → `onMouseEnter` recomputes the range `[min(anchor,i), max(anchor,i)]` against `filteredRef.current` and unions it with the base selection. The chevron's `mousedown` stops propagation so toggling expand never starts a selection drag. Selection IDs are stable across filter/level changes because the row identity is the `LogEntry.id`, not its filtered index.
- `DevelopmentSettingsSection` — Reads/writes `loggerEnabled` via `ui.store`; toggle styling matches `LLMProviderCard` / `AgentCard` switches

## Configuration

- `MAX_ENTRIES = 2000` (hard-coded in both `src/main/logger/logger.ts` and `src/renderer/src/stores/logger.store.ts`)
- `BROADCAST_CHANNEL = 'logger:entry'` (main-side constant)
- `LOGGER_KEY = 'cinna-logger-enabled'` (localStorage key in `ui.store.ts`)
- `data` payloads on `[cinna-oauth]` / `[a2a-client]` HTTP error logs are trimmed to 2000 chars to keep the buffer bounded

## Security

- Log entries may contain sensitive fragments (URLs, user emails, partial response bodies). The buffer is **in-memory only** and is never persisted; disabling the logger does not clear the main buffer, but a full relaunch does.
- Access tokens, refresh tokens, and API keys are **not** logged — scoped loggers in `cinna-oauth.ts` and `cinna-tokens.ts` log lifecycle info and HTTP outcomes but never the bearer strings themselves.
- The renderer-side `createLogger` sends every entry over IPC; messages and data are untrusted from the main process's perspective (same trust boundary as any other preload-exposed API) and are only used for display.
