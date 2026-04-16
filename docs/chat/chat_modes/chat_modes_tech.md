# Chat Modes — Technical Details

## File Locations

### Main process
- `src/main/db/schema.ts` — `chatModes` table schema, `chats.modeId` column
- `src/main/db/migrations/chat-modes.ts` — `chat_modes` table creation migration
- `src/main/db/migrations/chats.ts` — `mode_id` column migration on `chats`
- `src/main/ipc/chatmode.ipc.ts` — CRUD IPC handlers for chat modes
- `src/main/ipc/index.ts` — `registerChatModeHandlers()` registration

### Preload
- `src/preload/index.ts` — `ChatModeData` interface, `window.api.chatModes` namespace (list, get, upsert, delete)

### Renderer
- `src/renderer/src/constants/chatModeColors.ts` — `COLOR_PRESETS` array (10 presets), `getPreset()`, `ColorPreset` interface, `ChatModeData` type alias
- `src/renderer/src/hooks/useChatModes.ts` — `useChatModes()`, `useUpsertChatMode()`, `useDeleteChatMode()` TanStack Query hooks
- `src/renderer/src/components/settings/ChatModesSection.tsx` — Settings section listing modes with add button
- `src/renderer/src/components/settings/ChatModeCard.tsx` — Expandable card for editing a single mode (auto-save)
- `src/renderer/src/components/settings/ChatModeForm.tsx` — Inline form for creating a new mode
- `src/renderer/src/components/chat/ChatConfigMenu.tsx` — `+` button popup showing mode cards with hover effects
- `src/renderer/src/components/chat/ChatInput.tsx` — `modeColor` prop for dynamic border/background tint
- `src/renderer/src/components/layout/MainArea.tsx` — Mode selection state, wiring mode to chat creation flow

## Database Schema

### `chat_modes` table
- `id` TEXT PK
- `name` TEXT NOT NULL
- `provider_id` TEXT — references `llm_providers.id` (nullable, no FK constraint)
- `model_id` TEXT — model identifier string (nullable)
- `mcp_provider_ids` TEXT — JSON array of MCP provider ID strings, default `'[]'`
- `color_preset` TEXT NOT NULL — one of the 10 preset IDs, default `'slate'`
- `created_at` INTEGER NOT NULL — unix timestamp

### `chats` table addition
- `mode_id` TEXT — references the chat mode used to create this chat (nullable, no FK constraint)

## IPC Channels

- `chatmode:list` — Returns all chat modes
- `chatmode:get(id)` — Returns a single mode or null
- `chatmode:upsert(data)` — Creates (no `id`) or updates (with `id`) a mode; returns `{ id, success }`
- `chatmode:delete(id)` — Deletes a mode; returns `{ success }`

## Services & Key Methods

- `src/main/ipc/chatmode.ipc.ts:registerChatModeHandlers()` — Registers all four IPC handlers using Drizzle ORM against `chatModes` schema
- `src/main/db/migrations/chat-modes.ts:migrateChatModes()` — Checks `hasTable('chat_modes')` and creates if absent
- `src/main/db/migrations/chats.ts:migrateChats()` — Adds `mode_id` column via `hasColumn` check

## Renderer Components

### Settings
- `ChatModesSection` — Lists `useChatModes()` data, renders `ChatModeCard` per mode + `ChatModeForm` toggle
- `ChatModeCard` — Expandable card; all fields except name auto-save on change via `useUpsertChatMode()`; name uses local draft state with onBlur save
- `ChatModeForm` — Inline creation form with name, color, provider, model, MCP checkboxes; calls `upsert` then `onClose`

### Chat
- `ChatConfigMenu` — Popup anchored to `+` button; renders mode cards with `getPreset()` for colors; hover state tracked via `hoveredId`; selecting a mode calls `onSelectMode` and closes popup
- `ChatInput` — Accepts optional `modeColor: ColorPreset | null`; when set, overrides the input wrapper's `borderColor` and `backgroundColor` via inline style
- `MainArea` — Holds `activeMode` state; passes it to `ChatConfigMenu` and derives `modeColorPreset` for `ChatInput`; on `handleNewChat`, writes `modeId` to chat updates and applies mode's provider/model/MCPs

## Configuration

- Color presets are hardcoded in `src/renderer/src/constants/chatModeColors.ts` — each preset defines `id`, `name`, `border` (primary color), `bg` (8% opacity tint), `card` (solid dark bg), `text` (light text for active card)

## Security

- No sensitive data — chat modes store only IDs and a color string; no keys or tokens
- MCP provider IDs stored in the mode are validated at chat creation time when `setMcpProviders` is called
