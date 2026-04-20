# Keyboard Shortcuts

## Purpose

Catalog of every keyboard shortcut exposed by the app — both global (window-level menu accelerators) and in-context (focused input, open overlay). A single reference so contributors can discover, reuse, and avoid collisions when adding new bindings.

## Core Concepts

- **Global shortcut** — Registered as an Electron `Menu` accelerator in the main process. Active whenever the window has focus, regardless of which element is focused. Broadcast to the renderer via `webContents.send`.
- **Context shortcut** — Handled in a React component via `onKeyDown` on a specific element, or a `window.addEventListener('keydown', ...)` gated on some open-state flag (e.g. `logsOpen`, `agentStatusOpen`). Only fires when that context is active.
- **Chord shortcut** — A double-press within a short time window (currently only ESC–ESC at 400 ms). Tracked via a `useRef` timestamp so consecutive presses can be correlated without re-rendering.
- **Trigger character** — Not a keyboard shortcut per se, but a single-character input in the chat textarea (`@`, `#`, `/`) that opens a popup. Documented here for completeness because the popup then hijacks certain keys (`↑ ↓ Enter Tab Esc`).

## Shortcut Registry

### Global (always active when window focused)

| Combo | Action |
|-------|--------|
| `⌘` / `⌃`` | Toggle the App Logs overlay (`Logger`). Registered as a visible menu accelerator so macOS does not consume it for window cycling. No-op when the logger toggle is disabled in Settings. |
| `⌘⇧` / `⌃⇧`` | Alt accelerator for the same toggle, registered hidden so the shortcut still fires when `⇧` is held. |

### Chat input — `ChatInput` (new-chat screen or active chat)

| Combo | Action | When |
|-------|--------|------|
| `Enter` | Send the message. | Input focused, no popup open. |
| `Shift + Enter` | Insert a newline. | Input focused. |
| `Esc` (double-press within 400 ms) | Reset the new-chat input's settings — currently deselects the selected agent. | New-chat screen only (`chatId === null`), no popup open. |

### Chat input — trigger popups (`AgentMentionPopup` / `ExamplePromptPopup` / `CliCommandPopup`)

Typing `@` opens the agent mention popup (new-chat screen only). Typing `#` opens the example-prompts popup (when the active agent exposes prompts). Typing `/` opens the CLI-command popup (when the active agent exposes `cinna.run.*` skills). While a popup is open, keys are routed to the popup:

| Combo | Action |
|-------|--------|
| `↓` / `↑` | Move selection within the popup. |
| `Enter` / `Tab` | Accept the highlighted item. |
| `Esc` | Close the popup without selecting. Also resets any pending double-ESC timer so it cannot chain with a later stray press. |

### Logs overlay (`LogsOverlay`)

| Combo | Action |
|-------|--------|
| `Esc` | Close the overlay. Registered on `window` and gated on `logsOpen`. |

### Agent status overlay (`AgentStatusOverlay`)

| Combo | Action |
|-------|--------|
| `Esc` | Back-navigate if an agent detail view is open; otherwise close the overlay. Registered on `window` and gated on `agentStatusOpen`. |

### Settings — Chat Mode card (`ChatModeCard`)

| Combo | Action |
|-------|--------|
| `Enter` | Blur the name input to commit the edit. |

## Business Rules

- **Menu accelerators are the preferred wiring for global shortcuts.** Registering the logs toggle as an Electron menu accelerator (rather than `globalShortcut.register` or a renderer-side window listener) is what keeps `⌘`` from being swallowed by macOS's built-in "Cycle Through Windows" binding. New global shortcuts should follow the same pattern — add them to the View/Window menus in `src/main/index.ts` and send an IPC event to the renderer from the `click` handler.
- **Context shortcuts must be gated.** A `window`-level `keydown` listener that is always live will fire inside text inputs and interfere with typing. Every context listener (`LogsOverlay`, `AgentStatusOverlay`) checks the relevant open-state flag first and only calls `preventDefault` when it actually handles the key.
- **Double-press windows use a ref, not state.** Chord timestamps (`lastEscapeAt`) are tracked in a `useRef` so consecutive presses don't trigger re-renders. The window length is 400 ms — short enough to avoid accidental triggers, long enough to survive a casual double-tap.
- **Popup keys take priority.** When a chat-input popup is open, `Esc` closes the popup and resets the double-ESC timer to 0. This prevents the sequence "popup Esc → typing delay → stray Esc" from accidentally firing a reset.
- **Shortcuts are not user-configurable.** There is no remapping UI; any change requires editing the relevant handler. Document new shortcuts in this file when adding them.
- **Modifier disambiguation.** Use `CommandOrControl` in Electron menu accelerators so bindings work on both macOS (`⌘`) and Linux/Windows (`⌃`). Context shortcuts that rely on raw DOM events should generally avoid modifier keys to keep behaviour predictable on every platform.

## Architecture Overview

```
Global shortcut
  Electron Menu accelerator (main process)
    └── click handler ── webContents.send(channel) ──► renderer
                                                          │
                                                          ▼
                                                 ui.store flag flips

Context shortcut (component-scoped)
  Component mount
    └── window.addEventListener('keydown', handler)
          └── guard on open-state flag ── preventDefault ── store action

Chord shortcut
  onKeyDown on element
    └── compare Date.now() with lastPressAt (ref)
          └── within window → fire callback, clear ref
          └── outside window → set ref = now
```

## Integration Points

- [Logger](../../development/logger/logger.md) — Owns the `⌘` ` toggle; the shortcut is registered there, this doc only indexes it.
- [Agents](../../agents/agents/agents.md) / [Agent Status](../../agents/agent_status/agent_status.md) — `Esc` handling for the agent status overlay lives alongside those features.
- [Messaging](../../chat/messaging/messaging.md) — `Enter` / `Shift+Enter` send/newline behaviour is part of the chat input.
- [Example Prompts](../../chat/example_prompts/example_prompts.md) — `#` trigger + popup navigation keys.
- [CLI Commands](../../chat/cli_commands/cli_commands.md) — `/` trigger that opens the per-agent command picker.
- [Settings](../settings/settings.md) — Houses the `ChatModeCard` `Enter`-to-commit behaviour and the logger enable toggle that gates `⌘` `.
