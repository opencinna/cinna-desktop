# On-Demand MCP — Technical Details

## File Locations

### Main process
- `src/main/db/schema.ts` — `chatOnDemandMcps` table definition (Drizzle)
- `src/main/db/migrations/chats.ts` — `CREATE TABLE IF NOT EXISTS chat_on_demand_mcps` alongside `chat_mcp_providers`
- `src/main/db/chatOnDemandMcp.ts` — `chatOnDemandMcpRepo` data-access (CRUD + peek/clear)
- `src/main/services/chatService.ts` — `listOnDemandMcps`, `addOnDemandMcp`, `removeOnDemandMcp`
- `src/main/services/chatStreamingService.ts` — union of baseline + on-demand MCPs, prefix resolution, deferred flag flip
- `src/main/ipc/chat.ipc.ts` — IPC handlers for the three on-demand channels
- `src/main/db/chatMcp.ts` — baseline (chat-mode) MCP attachments; referenced by the union builder
- `src/main/db/mcpProviders.ts` — provider lookup used to resolve names for the announce prefix
- `src/main/mcp/manager.ts` — `mcpManager.getToolsForProviders()` consumes the unioned id list

### Preload
- `src/preload/index.ts` — adds `chat.listOnDemandMcps`, `chat.addOnDemandMcp`, `chat.removeOnDemandMcp` to the typed `window.api.chat` namespace

### Renderer
- `src/renderer/src/hooks/useMcp.ts` — `useChatOnDemandMcps`, `useAddOnDemandMcp`, `useRemoveOnDemandMcp` (React Query hooks with scoped `on-demand-mcp` logger on error)
- `src/renderer/src/hooks/useNewChatFlow.ts` — `startNewChat` flushes the new-chat MCP buffer onto the freshly-created chat (via `window.api.chat.addOnDemandMcp`) before the first send dispatches
- `src/renderer/src/components/layout/MainArea.tsx` — owns the `pendingMcpIds` state for the new-chat screen and the toggle/remove callbacks passed into ChatInput
- `src/renderer/src/components/chat/ChatInput.tsx` — owns trigger detection, filtered agent + MCP lists, combined keyboard nav; routes MCP selections to either the DB mutation (active chat) or the parent's pending buffer (new chat)
- `src/renderer/src/components/chat/AgentMcpMentionPopup.tsx` — listbox with `role="group"` sections per "Agents" and "MCP"
- `src/renderer/src/components/chat/OnDemandMcpChips.tsx` — removable strip rendered alongside `OnDemandAgentChips` below the composer; two modes — DB-backed (`chatId` prop) and buffer-backed (`pendingIds` + `onRemovePending` props). Fixed accent color + connector (`Plug`) icon; connection health is shown only on problems via a red `McpStatusDot` (hover-card detail) after the name when `status !== 'connected'`

## Database Schema

Table: `chat_on_demand_mcps` (see `src/main/db/migrations/chats.ts`)

- `chat_id` (TEXT, FK `chats.id ON DELETE CASCADE`)
- `mcp_provider_id` (TEXT, FK `mcp_providers.id ON DELETE CASCADE`)
- `pending_announce` (INTEGER, boolean, default `1`) — owes the one-shot system-note hint
- `created_at` (INTEGER, unix seconds)
- Primary key: `(chat_id, mcp_provider_id)`

Relationship: layered alongside `chat_mcp_providers` (chat-mode baseline). Both tables are unioned at stream time by `chatStreamingService`.

## IPC Channels

- `chat:on-demand-mcp-list` — `(chatId: string) => Array<{ mcpProviderId: string; pendingAnnounce: boolean }>`
- `chat:on-demand-mcp-add` — `(chatId: string, mcpProviderId: string) => { success: true }`
- `chat:on-demand-mcp-remove` — `(chatId: string, mcpProviderId: string) => { success: true }`

All three require `userActivation.requireActivated()` and use `getProfileScopeUserId()` (chats are profile-scoped, MCP providers are settings-scoped).

## Services & Key Methods

- `chatService.listOnDemandMcps(userId, chatId)` — ownership-checks the chat, returns rows from `chatOnDemandMcpRepo.list`
- `chatService.addOnDemandMcp(userId, chatId, mcpProviderId)` — ownership-checks chat + verifies MCP exists in settings scope (`mcpProviderRepo.getOwned`), then `chatOnDemandMcpRepo.add` (upsert that re-arms `pendingAnnounce`)
- `chatService.removeOnDemandMcp(userId, chatId, mcpProviderId)` — ownership-checks then `chatOnDemandMcpRepo.remove`
- `chatOnDemandMcpRepo.peekPending(chatId)` — reads pending ids without mutating; called at stream setup
- `chatOnDemandMcpRepo.clearPending(chatId, ids)` — bulk-flips `pendingAnnounce=false` for the supplied ids; called only after the adapter's first stream resolves
- `chatStreamingService.stream(input)` — builds tool list from union of baseline (`chatMcpRepo.listProviderIds`) and on-demand (`chatOnDemandMcpRepo.listProviderIds`), resolves announce via the module-private `resolvePendingAnnounce`, threads the ids into `_runStreamLoop` for deferred flip
- `chatStreamingService._runStreamLoop(...)` — on `round === 0` post-`adapter.stream` success, calls `chatOnDemandMcpRepo.clearPending` and logs `on-demand mcp announce consumed`

## Renderer Components

- `ChatInput` — when `chatId` is set, switches the `@` popup from `AgentMentionPopup` to `AgentMcpMentionPopup`. Owns the flat `triggerIndex` that spans agents-then-MCPs and routes Enter/Tab to either `selectAgent` or `selectMcp`.
- `AgentMcpMentionPopup` — `role="listbox"` containing one `role="group"` per non-empty section. Single `selectedIndex` highlights one row across the flattened list; option ids are `${listboxId}-opt-${flatIndex}` matching the index ChatInput maintains.
- `OnDemandMcpChips` — reads `useChatOnDemandMcps` + `useMcpProviders` directly (no props beyond `chatId`) so the strip stays in sync with whichever path mutated the table.

## Configuration

None. No env vars, no settings. The feature is always available inside an active chat that has at least one enabled MCP in settings.

## Security

- Renderer never sees raw provider data beyond what `mcp:list` already exposes (`McpProviderData` — no auth tokens). The on-demand IPC channels only move provider ids around.
- Ownership: every IPC entry calls `userActivation.requireActivated()` then routes through `chatService` which always calls `requireOwnedChat` before any read or write.
- `addOnDemandMcp` rejects unknown MCP ids via `mcpProviderRepo.getOwned(getSettingsScopeUserId(), id)` so a renderer cannot poke arbitrary ids past the FK.
- The announce prefix only resolves provider *names* (`McpProviderRow.name`) — no credentials, URLs, or tokens reach the LLM.
- Cascade deletes (chats → on-demand rows, MCP providers → on-demand rows) keep the table from leaking stale rows when either side is deleted.

## Implementation Notes

- **Why peek + clear instead of a single consume**: a transactional read-and-flip would lose the one-shot announcement to any pre-flight failure (provider auth bad, network down). Splitting lets `_runStreamLoop` flip only after the LLM has actually consumed the prefix in its first round.
- **Why a second listbox component instead of extending `MentionPopup`**: `MentionPopup<T>` is a flat single-section primitive used by four call sites (agents, prompts, commands, chat modes). Adding grouping to it would complicate every caller; `AgentMcpMentionPopup` inlines the same surface treatment with section grouping local to itself.
- **Wire-content patching**: `_runStreamLoop` patches the most recent in-memory `user` message with the prefix-augmented `wireContent` so the LLM sees the announce prefix while the persisted `messages` row keeps the user's original text untouched.
