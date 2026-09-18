# On-Demand MCP — Technical Details

## File Locations

### Main process

- `src/main/db/schema.ts` — `chatOnDemandMcps` table definition (Drizzle)
- `src/main/db/migrations/chats.ts` — `CREATE TABLE IF NOT EXISTS chat_on_demand_mcps` alongside `chat_mcp_providers`
- `src/main/db/chatOnDemandMcp.ts` — `chatOnDemandMcpRepo` data-access (CRUD + peek/clear)
- `src/main/services/chatService.ts` — `listOnDemandMcps`, `addOnDemandMcp`, `removeOnDemandMcp`
- `src/main/services/conductorBridge.ts` unions baseline/on-demand connected MCP providers and refreshes the injected endpoint on chat/tool changes.
- `src/main/ipc/chat.ipc.ts` — IPC handlers for the three on-demand channels
- `src/main/db/chatMcp.ts` — baseline (chat-mode) MCP attachments; referenced by the union builder
- `src/main/db/mcpProviders.ts` — provider lookup used to resolve names for the announce prefix
- `src/main/mcp/manager.ts` — `mcpManager.getToolsForProviders()` consumes the unioned id list

### Preload

- `src/preload/index.ts` — adds `chat.listOnDemandMcps`, `chat.addOnDemandMcp`, `chat.removeOnDemandMcp` to the typed `window.api.chat` namespace

### Renderer

- `src/renderer/src/hooks/useMcp.ts` — `useChatOnDemandMcps`, `useAddOnDemandMcp`, `useRemoveOnDemandMcp` (React Query hooks with scoped `on-demand-mcp` logger on error)
- `src/renderer/src/hooks/useNewChatFlow.ts` — `startNewChat` flushes the new-chat MCP buffer onto the freshly-created chat (via the `useAddOnDemandMcp` mutation, so the chips' query key is invalidated and failures are logged) before the first send dispatches
- `src/renderer/src/components/layout/ChatWorkspace.tsx` — reads `pendingMcpIds` from the profile/surface draft and owns the toggle/remove callbacks passed into ChatInput; the source buffer survives navigation and only unchanged submitted selections clear after confirmed dispatch
- `src/renderer/src/components/chat/ChatInput.tsx` — owns trigger detection, filtered agent + MCP lists, combined keyboard nav; routes MCP selections to either the DB mutation (active chat) or the parent's pending buffer (new chat)
- `src/renderer/src/components/chat/AgentMcpMentionPopup.tsx` — listbox with `role="group"` sections per "Agents" and "MCP"
- `src/renderer/src/components/chat/ActiveMcpChips.tsx` — the strip rendered alongside `OnDemandAgentChips` below the composer. Draws the chat's **whole** active MCP set: mode-owned `baselineIds` first (locked, no `×`), then the on-demand engagements (removable), de-duplicated by id with the baseline winning. The on-demand half has two modes — DB-backed (`chatId` prop) and buffer-backed (`pendingIds` + `onRemovePending` props). Fixed accent color + connector (`Plug`) icon; connection health is shown only on problems via a red `McpStatusDot` (hover-card detail) after the name when `status !== 'connected'`

## Database Schema

Table: `chat_on_demand_mcps` (see `src/main/db/migrations/chats.ts`)

- `chat_id` (TEXT, FK `chats.id ON DELETE CASCADE`)
- `mcp_provider_id` (TEXT, FK `mcp_providers.id ON DELETE CASCADE`)
- `pending_announce` remains schema/API compatibility state; ACP tool discovery does not consume it.
- `created_at` (INTEGER, unix seconds)
- Primary key: `(chat_id, mcp_provider_id)`

## IPC Channels

- `chat:on-demand-mcp-list` — `(chatId: string) => Array<{ mcpProviderId: string; pendingAnnounce: boolean }>`
- `chat:on-demand-mcp-add` — `(chatId: string, mcpProviderId: string) => { success: true }`
- `chat:on-demand-mcp-remove` — `(chatId: string, mcpProviderId: string) => { success: true }`

All three require `userActivation.requireActivated()` and use `getProfileScopeUserId()` (chats are profile-scoped, MCP providers are settings-scoped).

## Services & Key Methods

- `chatService.listOnDemandMcps(userId, chatId)` — ownership-checks the chat, returns rows from `chatOnDemandMcpRepo.list`
- `chatService.addOnDemandMcp(userId, chatId, mcpProviderId)` — ownership-checks chat + verifies MCP exists in settings scope (`mcpProviderRepo.getOwned`), then `chatOnDemandMcpRepo.add` (upsert that re-arms `pendingAnnounce`)
- `chatService.removeOnDemandMcp(userId, chatId, mcpProviderId)` — ownership-checks then `chatOnDemandMcpRepo.remove`
- `src/main/services/conductorBridge.ts` unions baseline/on-demand connected MCP providers and refreshes the injected endpoint on chat/tool changes.

## Renderer Components

- `ChatInput` — when `chatId` is set, switches the `@` popup from `AgentMentionPopup` to `AgentMcpMentionPopup`. Owns the flat `triggerIndex` that spans agents-then-MCPs and routes Enter/Tab to either `selectAgent` or `selectMcp`.
- `AgentMcpMentionPopup` — `role="listbox"` containing one `role="group"` per non-empty section. Single `selectedIndex` highlights one row across the flattened list; option ids are `${listboxId}-opt-${flatIndex}` matching the index ChatInput maintains.
- `ActiveMcpChips` — reads `useChatOnDemandMcps` + `useMcpProviders` directly so the strip stays in sync with whichever path mutated the table; the baseline half arrives as the `baselineIds` prop, resolved once in `ChatInput` (`useChatMcpProviders` for an active chat, the `baselineMcpIds` prop from `ChatWorkspace` on the new-chat screen) and shared with `useCapabilityPicker` so chips and picker can't disagree.
- `ChatInput`'s `baselineIds` is always the chat's baseline (`useChatMcpProviders` for an active chat, the `baselineMcpIds` prop before it exists) and shows up locked in both the chips and the picker. There used to be a gate (`showsChatControls`) that emptied it while the per-chat `ChatControls` toggle pills were on screen; both are gone.

## Configuration

None. No env vars, no settings. The feature is always available inside an active chat that has at least one enabled MCP in settings.

## Security

- Renderer never sees raw provider data beyond what `mcp:list` already exposes (`McpProviderData` — no auth tokens). The on-demand IPC channels only move provider ids around.
- Ownership: every IPC entry calls `userActivation.requireActivated()` then routes through `chatService` which always calls `requireOwnedChat` before any read or write.
- `addOnDemandMcp` rejects unknown MCP ids via `mcpProviderRepo.getOwned(getSettingsScopeUserId(), id)` so a renderer cannot poke arbitrary ids past the FK.
- Endpoint credentials stay in main; the runtime sees tool descriptions and its own scoped bridge descriptor.
- Cascade deletes (chats → on-demand rows, MCP providers → on-demand rows) keep the table from leaking stale rows when either side is deleted.

## Implementation Notes

- **Why a second listbox component instead of extending `MentionPopup`**: `MentionPopup<T>` is a flat single-section primitive used by four call sites (agents, prompts, commands, chat modes). Adding grouping to it would complicate every caller; `AgentMcpMentionPopup` inlines the same surface treatment with section grouping local to itself.
