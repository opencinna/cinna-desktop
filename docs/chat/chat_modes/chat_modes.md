# Chat Modes

## Purpose

Let users define named presets that bundle an LLM provider + model, a set of MCP servers, and a color scheme — so they can start new chats for different workflows in one click instead of manually configuring each time.

## Core Concepts

- **Chat Mode** — A saved configuration preset with a name, optional LLM provider/model, a set of MCP providers, and a color from 10 presets
- **Color Preset** — One of 10 named color themes (slate, indigo, violet, rose, amber, emerald, cyan, sky, orange, fuchsia) that visually distinguish modes in the UI
- **Mode Selection** — Choosing a mode from the `+` popup below the chat input on the new-chat screen; this pre-configures the chat's provider, model, and MCP servers

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
2. User clicks the `+` button below the chat input
3. Popup shows all defined modes as colored cards with name, model, and MCP summary
4. Hover highlights the card with the mode's color tint and a left border accent
5. User clicks a mode — popup closes, the input border and background tint to the mode's color
6. User types a message and sends — chat is created with the mode's provider, model, and MCP configuration
7. Mode resets after the chat is created

### Deselecting a mode
1. User clicks the `+` button again and clicks the already-selected mode
2. Mode deselects — input returns to default styling, chat will use the default provider and all enabled MCPs

## Business Rules

- A chat mode's provider and model are optional — if not set, the default provider and its default model are used
- A chat mode's MCP list can be empty — if so, the app falls back to all enabled MCP providers
- Mode selection only applies to new chats (the new-chat screen); active chats keep their original configuration
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

New Chat Screen (MainArea + ChatConfigMenu popup)
  -> User selects mode from popup
  -> Mode's provider/model/MCPs are applied to the new chat
  -> Chat input border/bg tint to mode color
  -> On send: chat created with mode_id, provider, model, MCPs
```

## Integration Points

- [Messaging](../messaging/messaging.md) — Chat creation flow applies mode's provider/model/MCPs to the new chat
- [LLM Adapters](../../llm/adapters/adapters.md) — Mode references a provider ID and model ID from the LLM provider system
- [MCP Connections](../../mcp/connections/connections.md) — Mode stores a list of MCP provider IDs to enable for the chat
- [Settings](../../ui/settings/settings.md) — "Chats" tab in settings is the management UI for modes
