# Keyboard Shortcuts

## Purpose

Catalog of every keyboard shortcut exposed by the app — both global (window-level menu accelerators) and in-context (focused input, open overlay). A single reference so contributors can discover, reuse, and avoid collisions when adding new bindings. It also owns the one set of shortcuts the user assigns: the per-agent `⌘1`–`⌘9` digits.

## Core Concepts

- **Global shortcut** — Registered as an Electron `Menu` accelerator in the main process. Active whenever the window has focus, regardless of which element is focused. Broadcast to the renderer via `webContents.send`.
- **Chat-starting shortcut** — `⌘N`, `⇧⌘N` and `⌘1`–`⌘9`. Global shortcuts from the **File** menu that all end on the new-chat screen; they share one main → renderer event, and the renderer decides what the key means on the screen the user is looking at.
- **Agent shortcut** — A digit 1–9 the user binds to one agent on that agent page's **Interface** tab (Settings mode). Per profile: one digit per agent, one agent per digit. `⌘<digit>` starts a new chat with that agent from any screen.
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
| `⌘N` / `⌃N` | **File → New Chat.** The new-chat screen, exactly as the TopBar `+` does: the active chat and any job highlight are left behind, no agent is preselected. |
| `⇧⌘N` / `⌃⇧N` | **File → New Chat with This Agent.** A new chat with the agent of what is on screen: the agent of an open **direct** chat, or the agent of an open agent page. Anywhere else — the new-chat screen, a coordinator or human-routed chat, a direct chat with the model, Settings, a job — or when that agent is disabled, internal or no longer listed, it behaves as `⌘N`. |
| `⌘1`–`⌘9` / `⌃1`–`⌃9` | A new chat with the agent bound to that digit (hidden menu items). An unbound digit does nothing. A bound agent that is disabled shows the toast "*Name* is disabled"; one that is gone, "The agent for ⌘*n* is no longer available". Neither navigates. |

When `⇧⌘N` or a digit has an agent to start, it lands where every "chat with this agent" button lands — the new-chat screen with the agent preselected and the sidebar on Chats. All the chat-starting keys do nothing while a modal dialog is open, and nothing on the login or onboarding screens.

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

After right-clicking selected transcript text, Copy text receives focus; with no selection under the pointer, only a right-click on code opens it, over the whole code. Pointer movement and keys share the same focused highlight.

| Key | Action |
|-----|--------|
| `↓` / `↑` | Move between enabled Copy text and Save to Notes actions, wrapping at either end. |
| `Home` / `End` | Focus the first / last action. |
| `Enter` / `Space` | Activate the focused button. |
| `Esc` / `Tab` / `PageUp` / `PageDown` | Close the menu; restore the previous connected control when focus was still in the menu. These keys are consumed. |

Outside pointer input, wheel/touch scrolling, window resize/blur and chat/profile navigation also close it. Programmatic transcript following leaves it open. See [Conversation UI](../../chat/conversation_ui/conversation_ui.md#reusing-message-text).

### Transcript — file references (`MarkdownCode` in `fileRefs.tsx`)

A resolved file reference in a folder agent's chat is a focusable `code` with `role="button"`, so `Tab` reaches it. See [File References](../../chat/file_references/file_references.md).

| Key | Action |
|-----|--------|
| `Enter` / `Space` | Preview the focused file; for a folder, show it in Finder. The preview grows from the modal's centre, since a key has no click point. `Space` does not scroll the page. |

### File preview modal (`FilePreviewModal`)

| Key | Action |
|-----|--------|
| `Esc` | Close the preview. It fades out as fast as it appeared. After a keyboard open, focus returns to the reference once the fade ends. Registered on `window` while a preview is open, and off during the fade. |
| `Tab` | After a keyboard open, focus starts on the card. Tab goes through the header path (click-to-copy), the CSV Filter toggle, the Contents toggle (long markdown), the ⋯ button, Close, then the scrolling body. |
| `Esc` / `Tab` (⋯ menu open) | Close the menu only, and focus its trigger. The preview stays; the next `Esc` closes it. Registered on `window` in the capture phase while the menu is open, and stopped there. |
| `↑` / `↓` / `Home` / `End` (⋯ menu open) | Move between the enabled items, wrapping. Opening the menu focuses the first enabled item. |

### Logs overlay (`LogsOverlay`)

| Combo | Action |
|-------|--------|
| `Esc` | Close the overlay. Registered on `window` and gated on `logsOpen`. |

### Agent status overlay (`AgentStatusOverlay`)

| Combo | Action |
|-------|--------|
| `Esc` | Back-navigate if an agent detail view is open; otherwise close the overlay. Registered on `window` and gated on `agentStatusOpen`. |

### Agent page — Interface tab (`AgentInterfaceTab`)

The last tab of an agent page's Settings mode, on folder agent pages and on every other agent page (A2A, Cinna, ACP, Managed). Development agents have none: their Settings opens Local Development instead. One **Shortcut** select: **None**, then `⌘1`–`⌘9`. A digit another agent holds names that agent beside it ("⌘3 · Research"), so choosing it reads as moving it — which is what it does. Saves on change; a failure shows beneath the select and leaves the saved binding as it was.

### Settings — Chat Mode card (`ChatModeCard`)

| Combo | Action |
|-------|--------|
| `Enter` | Blur the name input to commit the edit. |

## Business Rules

- **Menu accelerators are the preferred wiring for global shortcuts.** Registering the logs toggle as an Electron menu accelerator (rather than `globalShortcut.register` or a renderer-side window listener) is what keeps `⌘`` from being swallowed by macOS's built-in "Cycle Through Windows" binding. New global shortcuts should follow the same pattern — add them to the File/View/Window menus in `src/main/index.ts` and send an IPC event to the renderer from the `click` handler.
- **Main knows the key, the renderer knows what it means.** The menu is built once at startup and knows nothing about profiles, chats or bindings, so every chat-starting key sends only *which* key it was; the renderer resolves the screen, the chat and the binding at key time. That is also why the nine digit items are hidden: their labels would need per-profile data the menu does not have.
- **Chat-starting keys are ignored under a modal.** A menu accelerator fires regardless of focus, including over an open dialog. Leaving the view would unmount the dialog and throw away the form in it, so while any element with `aria-modal="true"` is in the document the key does nothing.
- **Chat-starting keys start nothing before the shell.** The listener is mounted in the signed-in, onboarded shell, after the login and onboarding gates, so on those screens the keys are inert rather than navigating behind them.
- **`⇧⌘N` carries over only one agent the user is talking to.** A direct chat has one. A coordinator chat's root is an internal conductor, and a human-routed chat has several agents and no single one to carry over, so both fall back to a plain new chat — as does any agent a new chat could not start with (disabled, internal, unlisted).
- **A bound digit that cannot start its agent says so and stays put.** Navigating to an empty new-chat screen would read as the key having worked. A disabled agent is named, because re-enabling it is the fix; a missing one is not, because there is nothing left to name.
- **Agent shortcuts are one-to-one, and choosing a taken digit moves it.** Refusing would make the user find and clear the other agent first; the select names the current holder instead, so the move is visible before it is made.
- **Context shortcuts must be gated.** A `window`-level `keydown` listener that is always live will fire inside text inputs and interfere with typing. Every context listener (`LogsOverlay`, `AgentStatusOverlay`) checks the relevant open-state flag first and only calls `preventDefault` when it actually handles the key.
- **Double-press windows use a ref, not state.** Chord timestamps (`lastEscapeAt`) are tracked in a `useRef` so consecutive presses don't trigger re-renders. The window length is 400 ms — short enough to avoid accidental triggers, long enough to survive a casual double-tap.
- **Popup keys take priority.** When a chat-input popup is open, `Esc` closes the popup and resets the double-ESC timer to 0. This prevents the sequence "popup Esc → typing delay → stray Esc" from accidentally firing a reset. Popups are also handled before history recall, the edit-mode `Esc` and the stop chord, so `↑` / `↓` inside a popup never recall a message.
- **History cycles only while the input is empty or unmodified.** In a message being written, the arrow keys move the caret; taking them over there would make multi-line editing impossible. Once a recalled message is edited, the arrows belong to the caret again. Inside a recalled message of several lines they belong to the caret too, except `↑` on the first line and `↓` on the last: that text is still unchanged, so without the exception the arrows could never move between its lines to start an edit.
- **Leaving an edit is its own `Esc`.** `Esc` while editing a queued message resets the chord timer, so leaving the edit and stopping the turn can never be one gesture.
- **The stop chord is taught where it applies.** The running composer's placeholder and Stop's tooltip name it; the rotating hints stay on the new-chat screen, where no turn runs.
- **Only the agent digits are user-configurable.** Which agent `⌘1`–`⌘9` start is the user's choice, per profile — see [Settings Scope](../../core/settings_scope/settings_scope.md). The keys themselves, and every other shortcut here, cannot be remapped; any change requires editing the relevant handler. Document new shortcuts in this file when adding them.
- **Agent bindings follow the agent, not its row.** Re-keying a folder agent (Stamp identity) moves every profile's binding to the new id. Deleting a hand-added connection releases its digit in every profile, and deleting a profile releases that profile's digits. A folder agent moved to the Trash and a Cinna agent that sync stops listing keep their digit — the folder may be restored and the remote agent re-synced under the same id — so until then that digit shows the "no longer available" toast and can be given to another agent.
- **Shortcuts are surfaced in-product by [Hints](../hints/hints.md).** The hint catalog (`src/renderer/src/constants/hints.ts`) is documentation shipped inside the UI. Changing a binding below means checking whether a hint teaches it — a stale hint is worse than no hint. Hints exist today for `?`, the `?`-then-Enter note expansion, `#`, `/`, `@`, `~`, the picker navigation keys, `Shift`+`Enter`, double-ESC, `⌘`/`⌃` + `` ` ``, `⌘N`, `⇧⌘N`, and binding and using `⌘1`–`⌘9`.
- **Modifier disambiguation.** Use `CommandOrControl` in Electron menu accelerators so bindings work on both macOS (`⌘`) and Linux/Windows (`⌃`). Context shortcuts that rely on raw DOM events should generally avoid modifier keys to keep behaviour predictable on every platform.

## Architecture Overview

```
Global shortcut
  Electron Menu accelerator (main process)
    └── click handler ── webContents.send(channel) ──► renderer
                                                          │
                                                          ▼
                                                 ui.store flag flips

Chat-starting shortcut (⌘N, ⇧⌘N, ⌘1–⌘9)
  File menu accelerator (main process)
    └── webContents.send('app:shortcut', { kind, slot? }) ──► useAppShortcuts (Shell)
          └── aria-modal open? → ignore
          └── resolve: screen's agent (⇧⌘N) / profile binding (⌘digit)
                └── new-chat screen, agent preselected — or a toast

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
- [Agents](../../agents/agents/agents.md) / [Agent Status](../../agents/agent_status/agent_status.md) — `Esc` handling for the agent status overlay lives alongside those features. The external agent page carries the Interface tab.
- [Agents Tab & Agent Page](../../agents/local_agents/agents_tab.md) — the folder agent page carries the Interface tab; Stamp identity is what moves a folder agent's bindings.
- [Settings Scope](../../core/settings_scope/settings_scope.md) — agent digit bindings are profile-bound data.
- [Messaging](../../chat/messaging/messaging.md) — `Enter` / `Shift+Enter` send/newline behaviour is part of the chat input.
- [Pending Messages](../../chat/pending_messages/pending_messages.md) — what a send, a recall and an edit do while a turn runs; Esc Esc stops that turn.
- [Example Prompts](../../chat/example_prompts/example_prompts.md) — `#` trigger + popup navigation keys.
- [CLI Commands](../../chat/cli_commands/cli_commands.md) — `/` trigger that opens the per-agent command picker.
- [Hints](../hints/hints.md) — Surfaces the shortcuts in this registry as rotating tips on the new-chat screen; its catalog must stay in sync with this file.
- [Settings](../settings/settings.md) — Houses the `ChatModeCard` `Enter`-to-commit behaviour and the logger enable toggle that gates `⌘` `.
