# Keyboard Shortcuts

## Purpose

Catalog of every keyboard shortcut exposed by the app — both global (window-level menu accelerators) and in-context (focused input, open overlay). A single reference so contributors can discover, reuse, and avoid collisions when adding new bindings.

## Core Concepts

- **Global shortcut** — Registered as an Electron `Menu` accelerator in the main process. Active whenever the window has focus, regardless of which element is focused. Broadcast to the renderer via `webContents.send`.
- **Context shortcut** — Handled in a React component via `onKeyDown` on a specific element, or a `window.addEventListener('keydown', ...)` gated on some open-state flag (e.g. `logsOpen`, `agentStatusOpen`). Only fires when that context is active.
- **Chord shortcut** — A double-press within a short time window (currently only ESC–ESC at 400 ms, which clears the agent selection on the new-chat screen and stops a running turn in an existing chat). Tracked via a `useRef` timestamp so consecutive presses can be correlated without re-rendering.
- **Trigger character** — Not a keyboard shortcut per se, but a single-character input in the chat textarea (`@`, `#`, `/`) that opens a popup. Documented here for completeness because the popup then hijacks certain keys (`↑ ↓ Enter Tab Esc`).
- **Sole-character shortcut** — `~` typed into an empty chat input opens the chat-modes selector (`MentionPopup`). Unlike trigger characters, `~` is not a filter — it is consumed as a shortcut only when it is the lone character. Typing past it commits to a literal `~` and closes the popup.

## Shortcut Registry

### Global (always active when window focused)

| Combo | Action |
|-------|--------|
| `⌘` / `⌃`` | Toggle the App Logs overlay (`Logger`). Registered as a visible menu accelerator so macOS does not consume it for window cycling. No-op when the logger toggle is disabled in Settings. |
| `⌘⇧` / `⌃⇧`` | Alt accelerator for the same toggle, registered hidden so the shortcut still fires when `⇧` is held. |

### Chat input — `ChatInput` (new-chat screen or active chat)

| Combo | Action | When |
|-------|--------|------|
| `Enter` | Send the message. While a turn runs, the text is taken into that turn or queued behind it — see [Pending Messages](../../chat/pending_messages/pending_messages.md). | Input focused, no popup open. |
| `Enter` | Save the edit to a recalled queued message instead of sending a new one. | Editing a queued message. |
| `Shift + Enter` | Insert a newline. | Input focused. |
| `Esc` (double-press within 400 ms) | Reset the new-chat input's settings — currently deselects the selected agent. | New-chat screen only (`chatId === null`), no popup open. |
| `Esc` (double-press within 400 ms) | Stop the running turn, exactly as the Stop button does. A single `Esc` only arms it. Stop's tooltip reads "Stop (Esc Esc)" and the running placeholder "Send a follow-up · Esc Esc to stop". | Existing chat with a turn running, no popup open, not editing a queued message. |
| `Esc` | Leave edit mode and empty the input. Does not arm the stop chord. | Editing a queued message. |
| `↑` / `↓` | Step back / forward through the user's own messages in this chat: saved ones, then those the running turn took in, then queued ones (newest). A recalled queued message opens in edit mode; a recalled delivered one is sent as a new message. Past the newest entry the input empties. | Existing chat, no popup open, no modifier held, and the input empty or still holding the recalled text unchanged. `↑` also needs the caret on the input's first line, `↓` on its last. |

### Chat input — trigger popups (`AgentMentionPopup` / `ExamplePromptPopup` / `CliCommandPopup`)

Typing `@` opens the agent mention popup (new-chat screen only). Typing `#` opens the example-prompts popup (when the active agent exposes prompts). Typing `/` opens the CLI-command popup (when the active agent exposes `cinna.run.*` skills). While a popup is open, keys are routed to the popup:

| Combo | Action |
|-------|--------|
| `↓` / `↑` | Move selection within the popup. |
| `Enter` / `Tab` | Accept the highlighted item. |
| `Esc` | Close the popup without selecting. Also resets any pending double-ESC timer so it cannot chain with a later stray press. |

### Chat input — chat-modes shortcut (`~`)

Typing `~` into an empty input opens the chat-modes picker above the textarea (same anchoring as the `@` / `#` / `/` popups — distinct from the Chat mode submenu inside `ComposerPlusMenu`). While the popup is in this state (textarea still holds the lone `~`):

| Combo | Action |
|-------|--------|
| `↓` / `↑` | Move selection within the popup. |
| `Enter` / `Tab` | Apply the highlighted mode AND wipe the `~` from the textarea. |
| `Esc` | Closes the popup, leaves the `~` in the textarea. |
| Any other character | Closes the popup and is appended to the input — the user is interpreted as having meant to type `~`. |
| Click a mode | Same as Enter — applies AND wipes the `~`. |

### Transcript context menu (`MessageContextMenu`)

After right-clicking a message body or selected transcript text, Copy text receives focus. Pointer movement and keys share the same focused highlight.

| Key | Action |
|-----|--------|
| `↓` / `↑` | Move between enabled Copy text and Save to Notes actions, wrapping at either end. |
| `Home` / `End` | Focus the first / last action. |
| `Enter` / `Space` | Activate the focused button. |
| `Esc` / `Tab` / `PageUp` / `PageDown` | Close the menu; restore the previous connected control when focus was still in the menu. These keys are consumed. |

Outside pointer input, wheel/touch scrolling, window resize/blur and chat/profile navigation also close it. Programmatic transcript following leaves it open. See [Conversation UI](../../chat/conversation_ui/conversation_ui.md#reusing-message-text).

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
- **Popup keys take priority.** When a chat-input popup is open, `Esc` closes the popup and resets the double-ESC timer to 0. This prevents the sequence "popup Esc → typing delay → stray Esc" from accidentally firing a reset. Popups are also handled before history recall, the edit-mode `Esc` and the stop chord, so `↑` / `↓` inside a popup never recall a message.
- **History cycles only while the input is empty or unmodified.** In a message being written, the arrow keys move the caret; taking them over there would make multi-line editing impossible. Once a recalled message is edited, the arrows belong to the caret again. Inside a recalled message of several lines they belong to the caret too, except `↑` on the first line and `↓` on the last: that text is still unchanged, so without the exception the arrows could never move between its lines to start an edit.
- **Leaving an edit is its own `Esc`.** `Esc` while editing a queued message resets the chord timer, so leaving the edit and stopping the turn can never be one gesture.
- **The stop chord is taught where it applies.** The running composer's placeholder and Stop's tooltip name it; the rotating hints stay on the new-chat screen, where no turn runs.
- **Shortcuts are not user-configurable.** There is no remapping UI; any change requires editing the relevant handler. Document new shortcuts in this file when adding them.
- **Shortcuts are surfaced in-product by [Hints](../hints/hints.md).** The hint catalog (`src/renderer/src/constants/hints.ts`) is documentation shipped inside the UI. Changing a binding below means checking whether a hint teaches it — a stale hint is worse than no hint. Hints exist today for `?`, the `?`-then-Enter note expansion, `#`, `/`, `@`, `~`, the picker navigation keys, `Shift`+`Enter`, double-ESC, and `⌘`/`⌃` + `` ` ``.
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
- [Pending Messages](../../chat/pending_messages/pending_messages.md) — what a send, a recall and an edit do while a turn runs; Esc Esc stops that turn.
- [Example Prompts](../../chat/example_prompts/example_prompts.md) — `#` trigger + popup navigation keys.
- [CLI Commands](../../chat/cli_commands/cli_commands.md) — `/` trigger that opens the per-agent command picker.
- [Hints](../hints/hints.md) — Surfaces the shortcuts in this registry as rotating tips on the new-chat screen; its catalog must stay in sync with this file.
- [Settings](../settings/settings.md) — Houses the `ChatModeCard` `Enter`-to-commit behaviour and the logger enable toggle that gates `⌘` `.
