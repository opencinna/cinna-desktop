# Chat Modes — Technical Details

## File Locations

### Main process
- `src/main/db/schema.ts` — `chatModes` table schema (including the `isDefault` boolean column); `chats.modeId` column
- `src/main/db/migrations/chat-modes.ts` — `chat_modes` table creation + `is_default` column migration (guarded by `hasColumn`)
- `src/main/db/migrations/chats.ts` — `mode_id` column migration on `chats`
- `src/main/db/chatModes.ts` — `chatModeRepo` — pure CRUD primitives (`list`, `getOwned`, `clearDefaults`, `insert`, `update`, `delete`); each accepts an optional `DbOrTx` so a service-level transaction can drive them
- `src/main/services/chatModeService.ts` — `chatModeService` — owns the single-default-per-user invariant inside `getDb().transaction(...)`: clears other defaults, then inserts/updates; throws `ChatModeError` on update of a non-existent mode
- `src/main/errors.ts` — `ChatModeError` + `ChatModeErrorCode` (`not_found`)
- `src/main/ipc/chatmode.ipc.ts` — CRUD IPC handlers for chat modes (wrapped with `ipcHandle()`, gated by `requireActivated()`, delegate to `chatModeService`); `chatmode:upsert` accepts `isDefault?: boolean`
- `src/main/ipc/index.ts` — `registerChatModeHandlers()` registration

### Preload
- `src/preload/index.ts` — `ChatModeData` interface (includes `isDefault: boolean`); `window.api.chatModes` namespace (list, get, upsert, delete); `upsert` payload accepts `isDefault?: boolean`

### Renderer
- `src/renderer/src/constants/chatModeColors.ts` — `COLOR_PRESETS` array (10 presets), `getPreset()`, `ColorPreset` interface, `ChatModeData` type alias
- `src/renderer/src/hooks/useChatModes.ts` — `useChatModes()`, `useUpsertChatMode()`, `useDeleteChatMode()`, `useDefaultChatMode()` (renderer-side filter that picks the single mode with `isDefault: true`)
- `src/renderer/src/stores/chat.store.ts` — `sendError: string | null` slot + `setSendError()`; cleared automatically on `setActiveChatId`, `startStreaming`, and `reset`
- `src/renderer/src/components/settings/ChatModesSection.tsx` — Settings section listing modes with add button
- `src/renderer/src/components/settings/ChatModeCard.tsx` — Expandable card for editing a single mode (auto-save); header includes a star toggle that flips `isDefault`
- `src/renderer/src/components/settings/ChatModeForm.tsx` — Inline form for creating a new mode
- `src/renderer/src/components/chat/ChatConfigMenu.tsx` — `+` button popup showing mode cards with hover effects
- `src/renderer/src/components/chat/ChatInput.tsx` — `modeColor` prop for dynamic border/background tint
- `src/renderer/src/components/layout/MainArea.tsx` — Mode selection state, auto-applies `defaultMode` on new-chat entry, renders the shared `sendErrorBanner` above the chat input in both new-chat and active-chat views
- `src/renderer/src/hooks/useChatStream.ts` — On stream `error` events (LLM + agent), writes the error string into `chat.store.sendError` so the banner surfaces during active-chat sends, not just on the new-chat screen

## Database Schema

### `chat_modes` table
- `id` TEXT PK
- `user_id` TEXT NOT NULL DEFAULT `__default__` — scope key (default-scope shared resource)
- `name` TEXT NOT NULL
- `provider_id` TEXT — references `llm_providers.id` (nullable, no FK constraint)
- `model_id` TEXT — model identifier string (nullable)
- `mcp_provider_ids` TEXT — JSON array of MCP provider ID strings, default `'[]'`
- `color_preset` TEXT NOT NULL — one of the 10 preset IDs, default `'slate'`
- `is_default` INTEGER NOT NULL DEFAULT 0 — single-default-per-user invariant (enforced in `chatModeService.upsert`)
- `created_at` INTEGER NOT NULL — unix timestamp

### `chats` table addition
- `mode_id` TEXT — references the chat mode used to create this chat (nullable, no FK constraint)

## IPC Channels

- `chatmode:list` — Returns all chat modes for the active user
- `chatmode:get(id)` — Returns a single mode or null
- `chatmode:upsert(data)` — Creates (no `id`) or updates (with `id`) a mode; `data.isDefault` triggers `chatModeRepo.clearDefaults` for other modes in the same transaction; returns `{ id, success }`
- `chatmode:delete(id)` — Deletes a mode; returns `{ success }`

## Services & Key Methods

- `src/main/db/chatModes.ts` — `chatModeRepo`:
  - `list(userId, db?)` — list all modes for user
  - `getOwned(userId, id, db?)` — fetch with ownership check
  - `clearDefaults(userId, db?)` — set `isDefault: false` on every mode for the user
  - `insert(userId, input, db?)` — generate id + insert row
  - `update(userId, id, input, db?)` — update row, falls back to existing `isDefault` if unspecified
  - `delete(userId, id, db?)` — scoped delete
- `src/main/services/chatModeService.ts` — `chatModeService`:
  - `list/get/delete` — direct repo passthroughs with logging
  - `upsert(userId, input)` — opens `getDb().transaction(...)`, conditionally calls `clearDefaults`, then dispatches to `update` or `insert`; throws `ChatModeError('not_found', ...)` when updating a missing mode
- `src/main/ipc/chatmode.ipc.ts:registerChatModeHandlers()` — Registers all four `chatmode:*` IPC handlers via `ipcHandle()`; each calls `requireActivated()` then delegates to `chatModeService`
- `src/main/db/migrations/chat-modes.ts:migrateChatModes()` — Creates table when missing (CREATE TABLE includes `is_default`); separately adds `is_default` via ALTER for legacy DBs

## Renderer Components

### Settings
- `ChatModesSection` — Lists `useChatModes()` data, renders `ChatModeCard` per mode + `ChatModeForm` toggle
- `ChatModeCard` — Expandable card; all fields except name auto-save on change via `useUpsertChatMode()`; name uses local draft state with onBlur save; header includes the `Star` button that toggles `isDefault` (mutation runs through `save({ isDefault: !mode.isDefault })`, which triggers the service-level invariant)
- `ChatModeForm` — Inline creation form with name, color, provider, model, MCP checkboxes; calls `upsert` then `onClose`

### Chat
- `ChatConfigMenu` — Popup anchored to `+` button; renders mode cards with `getPreset()` for colors; hover state tracked via `hoveredId`; selecting a mode calls `onSelectMode` and closes popup
- `ChatInput` — Accepts optional `modeColor: ColorPreset | null`; when set, overrides the input wrapper's `borderColor` and `backgroundColor` via inline style. When `leftSlot` is provided for an active chat, renders it instead of `ChatControls`
- `MainArea`:
  - `useDefaultChatMode()` provides the default mode; an effect keyed on `activeChatId` + `defaultMode?.id` calls `setActiveMode((current) => current ?? defaultMode)` so the default applies on every new-chat entry without overriding an explicit user selection
  - `handleNewChat` runs a pre-flight check (`hasDestination = !!selectedAgent || (!!effectiveProviderId && !!resolvedModelId)`) and writes a user-facing message into `chat.store.sendError` when no destination is determinable
  - Renders a shared `sendErrorBanner` element above the `ChatInput` in both the new-chat layout and the active-chat layout; the banner is sourced from `chat.store.sendError` so it covers stream-time errors too
  - For active chats, resolves `activeChatMode` from `chatData.modeId` via `useChatDetail` + `useChatModes`; `handleActiveChatModeChange` writes the chat's provider/model/MCP/modeId when switching modes (no implicit provider fallback any more)

## Configuration

- Color presets are hardcoded in `src/renderer/src/constants/chatModeColors.ts` — each preset defines `id`, `name`, `border` (primary color), `bg` (8% opacity tint), `card` (solid dark bg), `text` (light text for active card)

## Security

- No sensitive data — chat modes store only IDs and a color string; no keys or tokens
- MCP provider IDs stored in the mode are validated at chat creation time when `setMcpProviders` is called
- Ownership: every repo method filters by `userId`; settings UI runs at `getSettingsScopeUserId()` so chat modes live in the default (shared) scope
