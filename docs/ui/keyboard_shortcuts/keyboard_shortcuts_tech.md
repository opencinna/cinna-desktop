# Keyboard Shortcuts — Technical Details

## File Locations

### Main process

| File | Role |
|------|------|
| `src/main/index.ts` | Registers the `View > Toggle App Logs` menu items with accelerators `CommandOrControl+`` (visible) and `CommandOrControl+Shift+`` (hidden with `acceleratorWorksWhenHidden: true`). The `click` handler calls `toggleLogsOverlay` which invokes `webContents.send('logger:toggle-overlay')`. |

### Renderer — Components

| File | Role |
|------|------|
| `src/renderer/src/components/chat/ChatInput.tsx` | `handleKeyDown` on the textarea. Handles popup navigation (`ArrowUp`/`ArrowDown`/`Enter`/`Tab`/`Escape` when a trigger popup is open), message send (`Enter` without `Shift`), and the double-`Escape` chord via `lastEscapeAt` ref + `DOUBLE_ESC_WINDOW_MS` (400 ms). Calls the optional `onDoubleEscape` prop when the chord fires. |
| `src/renderer/src/components/layout/MainArea.tsx` | Wires `onDoubleEscape={() => setSelectedAgent(null)}` on the new-chat `ChatInput` instance only. The active-chat instance omits the prop so the chord is inert there. |
| `src/renderer/src/components/logger/LogsOverlay.tsx` | `useEffect` attaches a `window` `keydown` listener gated on `logsOpen`; `Escape` closes the overlay via `setLogsOpen(false)`. |
| `src/renderer/src/components/agents/AgentStatusOverlay.tsx` | `useEffect` attaches a `window` `keydown` listener gated on `agentStatusOpen`; `Escape` back-navigates if `detailAgentId` is set, otherwise closes the overlay. |
| `src/renderer/src/components/settings/ChatModeCard.tsx` | Inline `onKeyDown` on the mode-name input: `Enter` calls `e.currentTarget.blur()` to commit the edit. |
| `src/renderer/src/components/chat/AgentMentionPopup.tsx` / `ExamplePromptPopup.tsx` | Render-only — they own no key handling. All navigation keys are processed by `ChatInput.handleKeyDown` and the popups receive `selectedIndex` / `onSelect` / `onClose` as props. |

### Renderer — Store

| File | Role |
|------|------|
| `src/renderer/src/stores/ui.store.ts` | Holds the open-state flags the context shortcuts gate on: `logsOpen`, `agentStatusOpen`, plus the persisted `loggerEnabled` toggle that gates the `⌘` ` menu-accelerator handler. |

### Preload

| File | Role |
|------|------|
| `src/preload/index.ts` | Exposes `window.api.logger.onToggleOverlay(handler)` which the renderer uses to receive the `logger:toggle-overlay` broadcast from the main-process menu `click`. |

## IPC Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `logger:toggle-overlay` | main → renderer | Fired from the `⌘` ` / `⌘⇧` ` menu accelerator; renderer flips `ui.store.logsOpen` when the logger is enabled. |

## Key Flows

### Global accelerator → overlay toggle

1. User presses `⌘` ` — macOS routes the keystroke to the focused window's menu.
2. Electron matches the accelerator on the `View > Toggle App Logs` menu item in `src/main/index.ts`.
3. The `click` handler invokes `toggleLogsOverlay`, which calls `BrowserWindow.getAllWindows()[0].webContents.send('logger:toggle-overlay')`.
4. The renderer listener registered via `window.api.logger.onToggleOverlay` flips `logsOpen` on `ui.store` — gated on `loggerEnabled` so the shortcut is a no-op when the logger is off.
5. `LogsOverlay` reacts to the flag and mounts / unmounts.

### Double-ESC → clear agent

1. User presses `Esc` in the new-chat `ChatInput` with no popup open.
2. `handleKeyDown` enters the `e.key === 'Escape' && onDoubleEscape` branch, calls `preventDefault`, reads `Date.now()`.
3. First press: `now - lastEscapeAt.current` is larger than `DOUBLE_ESC_WINDOW_MS`, so `lastEscapeAt.current = now`.
4. User presses `Esc` again within 400 ms: `now - lastEscapeAt.current <= DOUBLE_ESC_WINDOW_MS`, so `lastEscapeAt.current = 0` and `onDoubleEscape()` fires.
5. `MainArea`'s callback runs `setSelectedAgent(null)`, clearing the agent chip and reverting the input's left slot back to the `AgentSelector` default.

### Popup-ESC invalidation

1. `@` or `#` popup is open, `Esc` fires.
2. The popup branch runs first: `closeTrigger()` resets the popup state and sets `lastEscapeAt.current = 0`.
3. A subsequent `Esc` within 400 ms computes `now - 0`, which is always much greater than 400 ms — so it starts a fresh chord rather than completing the previous one.

### Context-scoped overlay close

1. Overlay opens → `logsOpen` / `agentStatusOpen` becomes `true` → its `useEffect` runs.
2. `useEffect` attaches `window.addEventListener('keydown', onKey)` and returns a cleanup.
3. `onKey` checks the gate flag, calls `preventDefault` and the close action when appropriate.
4. Overlay closes → `useEffect` cleanup removes the listener.

## Configuration

- `DOUBLE_ESC_WINDOW_MS` — module-level constant in `src/renderer/src/components/chat/ChatInput.tsx`. Tune if the chord window needs to be tighter or looser.
- Menu accelerators in `src/main/index.ts` — adding or changing global shortcuts means editing this menu. Prefer `CommandOrControl` over `Cmd`/`Ctrl` literals so bindings stay cross-platform.

## Security

- No raw `keydown` listeners in the preload or main process — all key handling happens either via Electron menu accelerators or inside the sandboxed renderer.
- The `logger:toggle-overlay` broadcast carries no payload — the renderer treats it as a pure "toggle" event and cannot be coerced into toggling other state.
- No shortcut writes to persistent storage directly; every effect is a store action that the renderer already gates (e.g. `loggerEnabled` prevents the toggle from running when the logger is off).
