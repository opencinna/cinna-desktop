# Chat Modes

## Purpose

Let users define named presets that bundle an LLM provider + model, a set of MCP servers, and a color scheme — so they can start new chats for different workflows in one click instead of manually configuring each time.

## Core Concepts

- **Chat Mode** — A saved configuration preset with a name, optional LLM provider/model, a set of MCP providers, and a color from 10 presets
- **Default Chat Mode** — At most one mode per user can be flagged `isDefault`. The new-chat screen auto-applies it whenever the user lands there without an explicit choice — this is the only implicit fallback when routing a message; there is no longer a "default LLM provider" concept
- **Color Preset** — One of 10 named color themes (slate, indigo, violet, rose, amber, emerald, cyan, sky, orange, fuchsia) that visually distinguish modes in the UI
- **Mode Selection** — Choosing a mode from the **Chat mode** sub-menu of the left-side `[+]` composer menu (`ComposerPlusMenu`), or via the `~` sole-character keyboard shortcut; available on both the new-chat screen and active chats that were created with a mode. (The standalone `ChatConfigMenu` `+` button was retired — its modes list now lives inside the unified `[+]` menu.)

## User Stories / Flows

### Creating a chat mode
1. User navigates to Settings > Chats (first tab)
2. User clicks "Add Chat Mode"
3. Inline form appears: user enters a name, picks a color, selects an LLM provider + model, and toggles MCP providers
4. User clicks "Create Mode" — mode is saved immediately
5. Mode appears as a card in the list; all further edits auto-save

### Editing a chat mode
1. User expands a mode card in Settings > Chats
2. Any change (color, provider, model, MCP toggles) saves automatically
3. Name saves on blur or Enter key press

### Starting a chat with a mode
1. User is on the new-chat screen ("What can I help with?")
2. User clicks the `[+]` button below the chat input and chooses **Chat mode**
3. The sub-menu shows all defined modes as colored rows with name, model, and MCP summary
4. Hover highlights the card with the mode's color tint and a left border accent
5. User clicks a mode — popup closes, the input border and background tint to the mode's color
6. User types a message and sends — chat is created with the mode's provider, model, and MCP configuration
7. Mode resets after the chat is created

### Deselecting a mode (new-chat screen)
1. User reopens the `[+]` → **Chat mode** sub-menu and clicks the already-selected mode
2. Mode deselects — input returns to default styling. Without a mode (and without a selected agent) the next send raises an inline "can't determine destination" error banner above the input; the user has to pick a mode or an agent to send

### Switching mode on an active chat
1. User is in a chat that was created with a mode — the input border/background and the `[+]` button show the mode's color
2. User opens the `[+]` → **Chat mode** sub-menu and selects a different mode
3. The chat's provider, model, and MCP configuration update to match the new mode
4. Input styling changes to the new mode's color
5. Subsequent messages use the new mode's configuration

### Deselecting a mode on an active chat
1. User opens the `[+]` → **Chat mode** sub-menu and clicks the currently active mode
2. Mode clears — `modeId` is removed from the chat, input returns to default styling
3. The chat falls back to standard ChatControls (model picker + MCP toggles) for manual configuration

## Business Rules

- A chat mode's provider and model are optional — if neither the mode nor the user explicitly selects a provider on the new-chat screen, sending fails with a "can't determine destination" error (no implicit provider fallback exists)
- A chat mode's MCP list can be empty — if so, the app falls back to all enabled MCP providers
- At most one mode per user is `isDefault`. Marking a mode as default in Settings clears the flag on any previously default mode (single-default invariant, enforced in the same transaction)
- The default chat mode auto-applies whenever the user lands on the new-chat screen with nothing chosen. Deselecting it via the popup keeps it cleared for the rest of that new-chat session; it reapplies the next time the user returns to the new-chat screen
- Mode selection is available on the new-chat screen and on active chats that were created with a mode
- Active chats with a `mode_id` show the mode selector instead of separate model/MCP controls
- Switching modes on an active chat updates its provider, model, and MCP configuration immediately
- Deselecting a mode on an active chat clears `modeId` and reverts to manual model/MCP controls
- The `mode_id` is persisted on the chat record so the app knows which mode was used to create it
- Color presets are fixed (10 options) — they are not user-definable
- Mode name must be non-empty
- Deleting a mode does not affect existing chats that were created with it

## Architecture Overview

```
Settings UI (ChatModesSection / ChatModeCard / ChatModeForm)
  -> window.api.chatModes.upsert/delete/list
  -> IPC chatmode:* handlers
  -> SQLite chat_modes table

New Chat Screen (MainArea -> ChatInput -> ComposerPlusMenu "Chat mode" sub-menu)
  -> User selects mode from the sub-menu (or via the `~` shortcut popup)
  -> Mode's provider/model/MCPs are applied to the new chat
  -> Chat input border/bg + `[+]` button tint to mode color
  -> On send: chat created with mode_id, provider, model, MCPs

Active Chat (MainArea -> ChatInput -> ComposerPlusMenu "Chat mode" sub-menu)
  -> Chat has mode_id -> "Chat mode" sub-menu offered; ChatControls hidden
  -> Chat without mode_id -> no "Chat mode" item; ChatControls shown (model + MCP)
  -> User switches mode -> chat's provider/model/MCPs updated
  -> Chat input border/bg tint to active mode color
  -> Deselecting mode -> modeId cleared, falls back to ChatControls
```

## Integration Points

- [Messaging](../messaging/messaging.md) — Chat creation flow applies mode's provider/model/MCPs to the new chat
- [LLM Adapters](../../llm/adapters/adapters.md) — Mode references a provider ID and model ID from the LLM provider system
- [MCP Connections](../../mcp/connections/connections.md) — Mode stores a list of MCP provider IDs to enable for the chat
- [Settings](../../ui/settings/settings.md) — "Chats" tab in settings is the management UI for modes
