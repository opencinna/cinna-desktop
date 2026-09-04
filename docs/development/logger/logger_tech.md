# Logger — Technical Details

## File Locations

### Main Process
- `src/main/logger/logger.ts` — Ring buffer, `logEntry()`, `createLogger(scope)`, `getLogEntries()`, `clearLogEntries()`, `setLogSink()`. **This file has zero imports, by rule.** It used to import `BrowserWindow` from `electron` and `getMainWindow` from `../index` so `push` could broadcast to the renderer itself; the broadcast is now an installed **sink**. Keep it importless — an import here is paid for by every caller. **109 files import `logger/logger` at `12686f0`, 76 of them non-test modules under `src/main/`** (counted by grep on 4 Sep 2026; the larger number includes test files, which is the population that actually paid the cost)
- `src/main/logger/broadcast.ts` — `installLogBroadcast(getWindow)`. The Electron half, kept out of `logger.ts`. It holds `BROADCAST_CHANNEL = 'logger:entry'` and registers a sink that sends to `getWindow()` while a live, non-destroyed window exists. **The window getter arrives as an argument, not as an import** — importing `getMainWindow` here would only move the cycle rather than cut it. Its one import is type-only and erased at compile time, so neither module creates a runtime edge to `electron` or to the entry point
- `src/main/index.ts:25` — the single `installLogBroadcast(getMainWindow)` call, made as early in startup as possible
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

- `src/main/logger/logger.ts:logEntry(level, scope, source, message, data?)` — Assigns id, timestamps, serializes data, pushes to buffer, hands the entry to the sink if one is installed, mirrors to `console.*`
- `src/main/logger/logger.ts:setLogSink(next | null)` — Installs (or, with `null`, removes) the destination for live entries. `index.ts` installs the renderer broadcast at startup via `logger/broadcast.ts`; tests pass `null` to put it back
- `src/main/logger/broadcast.ts:installLogBroadcast(getWindow)` — Registers the sink. Call once, as early as possible; entries logged before it are already buffered and reach the renderer through `logger:get-all`
- `src/main/logger/logger.ts:createLogger(scope)` — Returns `{debug, info, warn, error}` bound to `logEntry(..., source='main', ...)`
- `src/main/logger/logger.ts:serializeData(data)` — Converts `Error` to `{name, message, stack}`; **every other value is walked by `redact()` first** — any key matching `/(api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization|bearer|secret|token|cookie)/i` with a non-empty value becomes `'[REDACTED]'`, cycles become `'[Circular]'` — and only then goes through `JSON.parse(JSON.stringify(...))`, with a `String(data)` fallback
- `src/renderer/src/stores/logger.store.ts:subscribe()` — Guards against double-subscription; seeds state with `getAll()`, then wires `onEntry` listener
- `src/renderer/src/stores/logger.store.ts:createLogger(scope)` — Renderer convenience; each call goes through `window.api.logger.log`
- `src/renderer/src/stores/ui.store.ts:setLoggerEnabled(enabled)` — Writes `cinna-logger-enabled` localStorage key; forces `logsOpen: false` when disabling

## Renderer Components

- `LogsOverlay` — Reads `logsOpen`, `setLogsOpen` from `ui.store`; `entries`, `subscribe`, `clear` from `logger.store`. Subscribes on first open. Keyboard: `Escape` clears the selection if non-empty, otherwise closes; `⌘`` / `⌘~` handled via `onToggleOverlay` IPC listener (not DOM keydown). Drag selection is finalized by a single `window` `mouseup` listener that clears the `dragRef`.
- `LogRow` — Row body is a `<div>` (not a `<button>`) so `mouseenter` fires while a mouse button is held down — that's how drag-extend works. Three pointer paths: chevron click → `onChevronClick` toggles `expandedIds`; row `mousedown` → `onMouseDown` mutates `selected` based on `shift` / `meta|ctrl` modifiers and seeds `dragRef`; row `mouseenter` while `dragRef` is set → `onMouseEnter` recomputes the range `[min(anchor,i), max(anchor,i)]` against `filteredRef.current` and unions it with the base selection. The chevron's `mousedown` stops propagation so toggling expand never starts a selection drag. Selection IDs are stable across filter/level changes because the row identity is the `LogEntry.id`, not its filtered index.
- `DevelopmentSettingsSection` — Reads/writes `loggerEnabled` via `ui.store`; toggle styling matches `LLMProviderCard` / `AgentCard` switches

## Known gaps

Each entry carries the date it was checked and the method.

- **A permanently broken sink is swallowed silently and forever.** `push` wraps the sink call in a bare `catch`, so a sink that throws on every entry is retried on every entry and reported nowhere — the overlay would simply stop updating while the app looked healthy. Deliberate: the alternative is logging about the logger, and the only sink that exists is three lines in `broadcast.ts` whose failure mode is a window that is going away anyway. `75e5ce8` made the comment say so rather than changing the behaviour. Revisit if a second sink appears. Confirmed at `12686f0` on 4 Sep 2026 by reading `src/main/logger/logger.ts` `push`.
- **The `installLogBroadcast` call at `src/main/index.ts:25` is deliberately uncovered.** Removing *both* it and its import passes typecheck, tests and build. A test for it would have to stand up the entry point behind an Electron double, reintroducing exactly the coupling the inversion removed. **The effect if it is ever dropped:** the log overlay opens fully populated from the ring buffer (`logger:get-all` still works) and then never updates again — not a dark panel, a plausible one that has silently stopped. Confirmed at `12686f0` on 4 Sep 2026 by reading `index.ts` and `broadcast.test.ts`.
- **`installLogBroadcast` has never executed in a real Electron process.** `src/main/logger/broadcast.test.ts` (3) drives it with a fake window object; `src/main/logger/logger.test.ts` (9) covers the buffer, the sink contract, redaction and the swallowing catch. No live app has been observed broadcasting.

## Configuration

- `MAX_ENTRIES = 2000` (hard-coded in both `src/main/logger/logger.ts` and `src/renderer/src/stores/logger.store.ts`)
- `BROADCAST_CHANNEL = 'logger:entry'` — now in `src/main/logger/broadcast.ts`, not `logger.ts`
- `LOGGER_KEY = 'cinna-logger-enabled'` (localStorage key in `ui.store.ts`)
- `data` payloads on `[cinna-oauth]` / `[a2a-client]` HTTP error logs are trimmed to 2000 chars to keep the buffer bounded

## Security

- Log entries may contain sensitive fragments (URLs, user emails, partial response bodies). The buffer is **in-memory only** and is never persisted; disabling the logger does not clear the main buffer, but a full relaunch does.
- Access tokens, refresh tokens, and API keys are **not** logged. Two independent reasons, and the second is the one that survives a mistake: the scoped loggers in `cinna-oauth.ts` and `cinna-tokens.ts` log lifecycle info and HTTP outcomes rather than bearer strings, **and** `redact()` in `logger.ts` masks any matching key in the structured `data` payload of every entry from every scope before it is buffered. Redaction is key-name based, so a secret passed as a bare string message, or under a key the pattern does not match, is not caught.
- The renderer-side `createLogger` sends every entry over IPC; messages and data are untrusted from the main process's perspective (same trust boundary as any other preload-exposed API) and are only used for display.
