# Mention Popups

## Purpose

Trigger-driven floating picker family that appears above the chat input when the user types `@`, `#`, `/`, or `?` at a word boundary. All four popups share one presentational primitive so they look, feel, and behave identically — only the data source, icon, and label differ.

## Core Concepts

- **Trigger character** — `@`, `#`, `/`, or `?` typed at the start of the input or after whitespace. Each maps to a distinct picker (agents, example prompts, CLI commands, notes).
- **Trigger filter** — the substring typed after the trigger char, used to narrow the picker list.
- **Mention popup** — the floating listbox itself: header, scrollable item list, accent-tinted glassy surface.
- **Item slots** — every row has the same shape: icon, primary label, optional meta tag (right-aligned), optional secondary line (truncated or 2-line clamped).
- **Anchor** — the textarea owning the popup; clicks inside it do not close the popup.

## User Flows

### `@` — Agent picker (new chat) / Agent + MCP picker (active chat)

1. User types `@` at the start of the input or after a space.
2. **New chat**: popup lists enabled agents matching the filter. Selection binds the agent to the new chat.
3. **Active chat**: popup gains a second section labelled "MCP" alongside the agent section. Selecting an agent row switches the chat's active agent (see [Multi-Agent Chats](../multi_agent/multi_agent.md)). Selecting an MCP row attaches that MCP to the chat's on-demand set (see [On-Demand MCP](../../mcp/on_demand/on_demand.md)).
4. Arrow keys traverse the flattened list across both sections; Enter / Tab applies the highlighted row and removes the `@token` from the input; Esc closes without applying.

### `#` — Example prompt picker

1. User types `#`; popup lists `example_prompts` from the prompt-source agent (bound agent in an active chat, or the selected agent on the new-chat screen).
2. Selecting an entry replaces the `#token` with the prompt's full text. No auto-send.

### `/` — CLI command picker

1. User types `/`; popup lists `cinna.run.*` commands declared by the prompt-source agent's card.
2. Selecting an entry replaces the `/token` with the invocation string (e.g. `/run:status`). No auto-send.

### `?` — Note picker

1. User types `?`; popup lists profile notes filtered by **title** only.
2. Selecting an entry removes the `?token` and inserts a note badge in the composer's attachment row. The note is materialized into a synthetic `.md` attachment at send time. See [Note Attachments](../note_attachments/note_attachments.md).

### `~` — Chat mode picker (shortcut)

1. User types `~` into an empty chat input. The chat-modes popup opens **above the textarea** (same anchoring as `@` / `#` / `/`) — distinct from the popup that opens above the `+` button when ChatConfigMenu is clicked.
2. **Arrow Up / Down** navigates the mode list; **Enter** / **Tab** applies the highlighted mode AND wipes the `~` from the textarea.
3. **Continuing to type a non-nav character**: the popup closes and the `~` stays in place — the user is interpreted as having meant to type the character.
4. **Esc**: closes the popup, leaves the `~` in place.
5. **Outside click**: closes the popup, leaves the `~` in place.
6. **Backspace removing the `~`**: closes the popup.

The trigger fires only when input transitions from empty to exactly `~` — `~` typed anywhere else (mid-text, after other characters) is just a regular character.

## Business Rules

- **Gating** — `@` only opens before a chat exists (`!chatId`). `#` and `/` open whenever the source agent declares prompts or commands; gating is the parent's responsibility, not the popup's. `?` opens whenever the profile has at least one note. `~` opens only when the input transitions from empty to exactly `~` (sole-character rule) and the chat-modes feature has at least one mode available.
- **Filter scope** — each picker chooses what fields match its filter token. Agents match name/protocol; example prompts match label/body; CLI commands match only the **signature** (`slug`, `command`) so typing `/status` does not pull in commands whose description happens to contain the word; notes match only the **title** so body content doesn't balloon the result list.
- **Empty state** — popups render nothing when the filtered list is empty. The trigger state stays open so continued typing can re-populate it.
- **Outside click** — closes the popup unless the click lands inside the textarea (anchor) or the popup itself.
- **Keyboard navigation** — ArrowUp/Down cycle the selection within the active popup; Enter/Tab apply; Esc closes. Wiring is owned by the parent textarea (combobox role) — see [Keyboard Shortcuts](../../ui/keyboard_shortcuts/keyboard_shortcuts.md).
- **Theming** — selected item uses an accent gradient (denser left, fading right). Dark theme uses higher opacities; light theme reduces them so the accent reads as a tint rather than a solid pill. Text on the active surface is white in dark theme and black in light theme.

## Architecture Overview

```
User keystroke or click on selector trigger
  -> ChatInput (trigger-token state, filtered list, keyboard handling)
       -> AgentMentionPopup | ExamplePromptPopup | CliCommandPopup | NoteMentionPopup  (thin wrapper)
  -> ChatConfigMenu (mouse-driven `+` button)
       -> direct MentionPopup<ChatModeData> usage
            -> MentionPopup<T>  (shared listbox shell, item layout, theming)
```

The four text-trigger wrappers exist only to bind their data shape (`AgentData`, `ExamplePrompt`, `CliCommand`, `NoteData`) to the generic `MentionPopup<T>` and declare the icon, header label, width, and field accessors. `ChatConfigMenu` is the fifth consumer — mouse-driven rather than keystroke-driven, and supplies a per-mode colored dot via `renderIcon` instead of a Lucide icon.

## Integration Points

- [Example Prompts](../example_prompts/example_prompts.md) — owns the `#` data source (`extractExamplePrompts(agent)` and `ExamplePromptTags`).
- [CLI Commands](../cli_commands/cli_commands.md) — owns the `/` data source (agent-card-driven `cinna.run.*` skills, fetched via `useCliCommands`).
- [Agents](../../agents/agents/agents.md) — owns the `@` data source (the enabled agents list).
- [Note Attachments](../note_attachments/note_attachments.md) — owns the `?` data source (profile notes via `useNoteList`) and the post-selection composer state.
- [Keyboard Shortcuts](../../ui/keyboard_shortcuts/keyboard_shortcuts.md) — documents the input-popup navigation contract (Arrow / Enter / Tab / Esc).
