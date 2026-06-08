# Composer `[+]` Menu — Technical Details

## File Locations

### Renderer — components
- `src/renderer/src/components/chat/ComposerPlusMenu.tsx` — the `[+]` button + popover. Owns `open` and `view: 'root' | 'modes'` state, outside-click / Esc close, and the chat-mode sub-view. Purely presentational — all data/handlers arrive via props.
- `src/renderer/src/components/agents/AgentPickerModal.tsx` — shared card-grid modal (portal-rendered, autofocused search, multi-select). Extended with the `activeFirst` prop for this feature; also used by Jobs (`JobEditForm`).
- `src/renderer/src/components/chat/ChatInput.tsx` — composer host. Renders `ComposerPlusMenu` as the first footer-left element and the `AgentPickerModal` (gated by `capabilityPickerOpen`); wires `pickAttachments`, `chatModeMenu`, and the capability picker.
- `src/renderer/src/components/layout/MainArea.tsx` — owns new-chat selection state and the chat-mode select handlers; passes `chatModeMenu` to both `ChatInput` instances.

### Renderer — hooks
- `src/renderer/src/hooks/useCapabilityPicker.ts` — builds the picker's `items` / `selectedIds` / `toggle` / `hasCapabilities`. Encapsulates the `@`-mirroring routing (new-chat pending buffers vs active-chat on-demand). Owns its own on-demand read/mutation instances.
- `src/renderer/src/hooks/useAgents.ts` — `useAttachAgentToChat` (promote + add on-demand agent), `useChatOnDemandAgents`, `useRemoveOnDemandAgent`, `usePromoteToOrchestrated`.
- `src/renderer/src/hooks/useMcp.ts` — `useMcpProviders`, `useAddOnDemandMcp`, `useChatOnDemandMcps`, `useRemoveOnDemandMcp`.
- `src/renderer/src/hooks/useChatAttachments.ts` — backs the **Attach files** action (`pick`).
- `src/renderer/src/hooks/useChatModes.ts` / `useDefaultChatMode` — chat-mode list + default for the **Chat mode** sub-menu.

### Removed (folded into this feature)
- `src/renderer/src/components/chat/AgentSelector.tsx` — old new-chat agent dropdown. <!-- nocheck -->
- `src/renderer/src/components/chat/ChatConfigMenu.tsx` — old chat-mode `+` button. <!-- nocheck -->
- `src/renderer/src/components/chat/AttachMenuPopup.tsx` — old right-side attach menu. <!-- nocheck -->

## Key Props / Interfaces

- `ComposerPlusMenu` props: `canAttachFiles`, `uploading`, `onAttachFiles`, `hasCapabilities`, `onOpenCapabilityPicker`, `modeMenu?` (`PlusModeMenu`), `activeModeColor?`.
- `PlusModeMenu` (exported from `ComposerPlusMenu.tsx`): `{ modes, activeId, onSelectMode(mode|null), renderIcon, composeSecondary }`. `onSelectMode(null)` deselects.
- `ChatInput` prop `chatModeMenu?: PlusModeMenu` — forwarded straight to `ComposerPlusMenu.modeMenu`. (Replaced the old `leftSlot` prop.)
- `AgentPickerModal` prop `activeFirst?: boolean` — enables the order snapshot + flat (ungrouped) card grid. Default `false` (Jobs caller unaffected).
- `useCapabilityPicker` args: `{ chatId, enabledAgents, enabledMcps, boundAgent, pendingAgentIds?, pendingMcpIds?, onTogglePendingAgent?, onTogglePendingMcp? }` → returns `CapabilityPicker { items, selectedIds, toggle, hasCapabilities }`.

## Active-First Ordering

Implemented in `AgentPickerModal.tsx`:
- `order: string[]` snapshot state; `selectedIdsRef` holds the live selection so toggling does not resort.
- A `useLayoutEffect` keyed on `[open, capSig, activeFirst]` recomputes the snapshot (stable sort, `selected` first) at open and when the item-set signature changes — runs before paint to avoid a reopen flash.
- `orderedItems` maps the snapshot back to items (appending any items added while open); `grouped` collapses to a single flat section when `activeFirst`.

## IPC Channels

This feature adds **no new IPC channels** — toggles route through existing ones (see the linked docs for signatures):
- On-demand agents/MCPs: `chat:on-demand-agent-add` / `-remove`, `chat:on-demand-mcp-add` / `-remove`, plus orchestration promotion — see [On-Demand MCP](../../mcp/on_demand/on_demand.md) and [Orchestrated Agents](../orchestrated_agents/orchestrated_agents.md).
- New-chat picks are renderer-only buffers flushed at creation — see `src/renderer/src/hooks/useNewChatFlow.ts`.
- Chat-mode application: `chat:update` + `chat:set-mcp-providers` via `MainArea.handleActiveChatModeChange` — see [Chat Modes](../chat_modes/chat_modes.md).
- Attachments: the `files:*` channels — see [File Attachments](../file_attachments/file_attachments.md).

## State Management

- **New chat** selection lives in `MainArea`: `pendingAgentIds` (single ordered agent list; primary agent derived as the first for example prompts + comm badge), `pendingMcpIds`, `activeMode`. `togglePendingMcp` / `togglePendingAgent` are true add-or-remove toggles.
- **Active chat** selection is server state read via `useChatOnDemandAgents` / `useChatOnDemandMcps` (React Query); the bound root agent comes from `chatData.agentId`.
- `ComposerPlusMenu` keeps only ephemeral UI state (`open`, `view`).

## Security

No new surface. Capability toggles and mode changes go through pre-existing, ownership-checked IPC handlers in the main process; the renderer never gains direct DB or credential access.
