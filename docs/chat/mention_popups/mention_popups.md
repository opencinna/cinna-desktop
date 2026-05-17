# Mention Popups

## Purpose

Trigger-driven floating picker family that appears above the chat input when the user types `@`, `#`, or `/` at a word boundary. All three popups share one presentational primitive so they look, feel, and behave identically — only the data source, icon, and label differ.

## Core Concepts

- **Trigger character** — `@`, `#`, or `/` typed at the start of the input or after whitespace. Each maps to a distinct picker (agents, example prompts, CLI commands).
- **Trigger filter** — the substring typed after the trigger char, used to narrow the picker list.
- **Mention popup** — the floating listbox itself: header, scrollable item list, accent-tinted glassy surface.
- **Item slots** — every row has the same shape: icon, primary label, optional meta tag (right-aligned), optional secondary line (truncated or 2-line clamped).
- **Anchor** — the textarea owning the popup; clicks inside it do not close the popup.

## User Flows

### `@` — Agent picker (new chat only)

1. User types `@` at the start of the new-chat input or after a space.
2. Popup lists enabled agents matching the filter.
3. Arrow keys move the selection; Enter / Tab binds the agent and removes the `@token` from the input; Esc closes without binding.
4. Selection feeds the new chat as the bound agent — the popup never reopens for the same chat (chat-bound agents are immutable).

### `#` — Example prompt picker

1. User types `#`; popup lists `example_prompts` from the prompt-source agent (bound agent in an active chat, or the selected agent on the new-chat screen).
2. Selecting an entry replaces the `#token` with the prompt's full text. No auto-send.

### `/` — CLI command picker

1. User types `/`; popup lists `cinna.run.*` commands declared by the prompt-source agent's card.
2. Selecting an entry replaces the `/token` with the invocation string (e.g. `/run:status`). No auto-send.

## Business Rules

- **Gating** — `@` only opens before a chat exists (`!chatId`). `#` and `/` open whenever the source agent declares prompts or commands; gating is the parent's responsibility, not the popup's.
- **Filter scope** — each picker chooses what fields match its filter token. Agents match name/protocol; example prompts match label/body; CLI commands match only the **signature** (`slug`, `command`) so typing `/status` does not pull in commands whose description happens to contain the word.
- **Empty state** — popups render nothing when the filtered list is empty. The trigger state stays open so continued typing can re-populate it.
- **Outside click** — closes the popup unless the click lands inside the textarea (anchor) or the popup itself.
- **Keyboard navigation** — ArrowUp/Down cycle the selection within the active popup; Enter/Tab apply; Esc closes. Wiring is owned by the parent textarea (combobox role) — see [Keyboard Shortcuts](../../ui/keyboard_shortcuts/keyboard_shortcuts.md).
- **Theming** — selected item uses an accent gradient (denser left, fading right). Dark theme uses higher opacities; light theme reduces them so the accent reads as a tint rather than a solid pill. Text on the active surface is white in dark theme and black in light theme.

## Architecture Overview

```
User keystroke
  -> ChatInput (trigger-token state, filtered list, keyboard handling)
    -> AgentMentionPopup | ExamplePromptPopup | CliCommandPopup  (thin wrapper)
      -> MentionPopup<T>  (shared listbox shell, item layout, theming)
```

The wrappers exist only to bind the data shape (`AgentData`, `ExamplePrompt`, `CliCommand`) to the generic `MentionPopup<T>` and to declare the icon, header label, width, and field accessors. They hold no state.

## Integration Points

- [Example Prompts](../example_prompts/example_prompts.md) — owns the `#` data source (`extractExamplePrompts(agent)` and `ExamplePromptTags`).
- [CLI Commands](../cli_commands/cli_commands.md) — owns the `/` data source (agent-card-driven `cinna.run.*` skills, fetched via `useCliCommands`).
- [Agents](../../agents/agents/agents.md) — owns the `@` data source (the enabled agents list).
- [Keyboard Shortcuts](../../ui/keyboard_shortcuts/keyboard_shortcuts.md) — documents the input-popup navigation contract (Arrow / Enter / Tab / Esc).
