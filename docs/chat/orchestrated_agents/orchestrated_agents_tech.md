# Orchestrated Agents — Technical Details

## File Locations

### Main process
- `src/main/llm/toolProvider.ts` — `ToolProvider` interface (`providerType`, `displayName`, optional `agentId`, `getTools`, `callTool`), `ToolCallOptions`/`ToolExecutionResult` types, and `McpToolProvider` (wraps one connected MCP provider, delegates to `mcpManager.callTool`)
- `src/main/services/a2aAsMcpProvider.ts` — `A2AAsMcpProvider` (implements `ToolProvider`, one per attached agent), `buildAgentToolProviders` factory, `sanitizeToolSlug`, collision-suffix logic
- `src/main/services/a2aStreamingService.ts` — `runAgentTurn` (port-free dual-output core) + `streamToAgent` (thin direct-A2A wrapper driving `runAgentTurn`) + `cancel`
- `src/main/services/chatStreamingService.ts` — orchestrator: builds `ToolProvider[]`, unions tools + routing map, combined announce (`resolvePendingAnnounce`), dispatch loop routing by `providerType`, sub-event forwarding, parts persistence, depth guard (`MAX_TOOL_ROUNDS`)
- `src/main/services/chatService.ts` — `listOnDemandAgents`, `addOnDemandAgent` (validates via `agentService.findAgent`), `removeOnDemandAgent`
- `src/main/services/agentService.ts` — `findAgent` (dual-scope resolve), `resolveEndpointIfNeeded`, `resolveAccessToken` (reused by the agent provider); `syncRemoteAgents` carries `target.mcp` into `remote_metadata.cinna_mcp`
- `src/main/db/schema.ts` — `chatOnDemandAgents` table; `messages.toolAgentId` column; `chats.orchestrated` flag
- `src/main/db/migrations/chats.ts` / `migrations/messages.ts` — `ALTER TABLE` for `chats.orchestrated` / `messages.tool_agent_id`
- `src/main/db/migrations/chats.ts` — `CREATE TABLE IF NOT EXISTS chat_on_demand_agents`
- `src/main/db/migrations/messages.ts` — `ALTER TABLE messages ADD COLUMN tool_agent_id`
- `src/main/db/chatOnDemandAgent.ts` — `chatOnDemandAgentRepo` (add/remove/list/listAgentIds/peekPending/clearPending)
- `src/main/db/messages.ts` — `saveToolCall` accepts `toolAgentId` + `parts` (rich sub-thread payload on the tool_call row)
- `src/main/db/agents.ts` — `a2aSessionRepo.getByChatAndAgent` / `upsert` (per-`(chat, agent)` continuity used by `runAgentTurn`)
- `src/main/ipc/chat.ipc.ts` — `chat:on-demand-agent-{list,add,remove}` handlers
- `src/main/mcp/manager.ts` — `getToolsForProviders` now tags tools `providerType: 'mcp'`

### Shared
- `src/shared/agentMetadata.ts` — `CinnaMcpDescriptor` type + `RemoteAgentMetadata.cinna_mcp`
- `src/shared/llmStreamEvents.ts` — `LlmToolSubEvent` variant (`tool_subevent`), `LlmToolUseEvent.providerType` + `providerAgentId`, guard `isLlmStreamEvent`
- `src/shared/messageParts.ts` — `MessagePart` shape reused for the persisted/streamed sub-thread
- `src/main/llm/types.ts` — `ToolDefinition.providerType`
- `src/main/mcp/types.ts` — `McpTool.providerType: 'mcp'`

### Preload
- `src/preload/index.ts` — `window.api.chat.{listOnDemandAgents,addOnDemandAgent,removeOnDemandAgent}`; `MessageData.toolAgentId`

### Renderer
- `src/shared/commPattern.ts` — `derivePattern(agentIds, mcpIds): 'A2A' | 'AI'` (single source of truth, shared by renderer + main; moved here from the renderer util so the job runner can import it too)
- `src/renderer/src/components/chat/CommPatternBadge.tsx` — badge + hover tooltip, left of the Cog
- `src/renderer/src/components/chat/OnDemandAgentChips.tsx` — removable agent chips, two modes: DB-backed (`chatId` prop, active chat) and buffer-backed (`pendingIds` + `onRemovePending`, new chat) — mirrors `OnDemandMcpChips`
- `src/renderer/src/hooks/useAgents.ts` — `useChatOnDemandAgents`, `useAddOnDemandAgent`, `useRemoveOnDemandAgent` (React Query hooks, cache key `['chat-on-demand-agent', chatId]`, scoped `on-demand-agent` logger on error)
- `src/renderer/src/components/chat/AgentContribution.tsx` — reusable parts renderer (name label + hash color + thinking/tool/tool_result/text/command_result blocks). Builds a `RenderNode[]` and runs it through the shared `groupConsecutiveCollapsibles` (from `CollapsibleGroup.tsx`) so consecutive auxiliary steps fold into dots in compact mode; renders every part inline in verbose. Takes a `verbose` prop threaded from `AgentToolSubThread`.
- `src/renderer/src/components/chat/CollapsibleGroup.tsx` — dots-group component + shared `RenderNode` type and `groupConsecutiveCollapsibles` helper, used by both this sub-thread and the main transcript (`MessageStream`)
- `src/renderer/src/components/chat/AgentToolSubThread.tsx` — expandable wrapper (header: agent badge, `· {n} steps · {status}` appended in verbose mode; hash-colored inset, auto-expand/collapse). Threads `verbose` into `AgentContribution`.
- `src/renderer/src/components/chat/MessageStream.tsx` — renders `AgentToolSubThread` for persisted tool_call rows with `parts` and for streaming blocks with `providerType === 'agent'`
- `src/renderer/src/components/chat/ChatInput.tsx` — `@`-mention agent picks route to `onTogglePendingAgent`; renders chips + badge (new-chat)
- `src/renderer/src/components/layout/MainArea.tsx` — owns `pendingAgentIds`, computes `combinedAgentIds` + `commPatternInfo`, applies the destination check
- `src/renderer/src/hooks/useNewChatFlow.ts` — `startNewChat(agentIds[], ...)` decision rule + on-demand agent flush
- `src/renderer/src/hooks/useChatStream.ts` — `handleLlm` routes `tool_subevent` to `appendToolSubEvent`, passes `providerType`/`providerAgentId` to `addToolCall`
- `src/renderer/src/stores/chat.store.ts` — `ToolCallBlock.{providerType,agentId,subParts}`, `appendToolSubEvent`, `appendAgentDeltaPart` merge helper
- `src/renderer/src/utils/agentColors.ts` — `presetForAgentId` hash color (reused by the sub-thread)

## Database Schema

Table: `chat_on_demand_agents` (see `src/main/db/migrations/chats.ts`) — verbatim mirror of `chat_on_demand_mcps`.
- `chat_id` (TEXT, FK `chats.id ON DELETE CASCADE`)
- `agent_id` (TEXT, FK `agents.id ON DELETE CASCADE`)
- `pending_announce` (INTEGER, boolean, default `1`)
- `created_at` (INTEGER, unix seconds)
- Primary key: `(chat_id, agent_id)`

Column: `messages.tool_agent_id` (TEXT, nullable; see `src/main/db/migrations/messages.ts`) — agent id backing an orchestrated agent tool call; drives the sub-thread's hash color and stays null for MCP/non-tool rows. The rich agent `parts[]` are stored on the existing `messages.parts` column (same one assistant messages use).

`a2a_sessions` (`src/main/db/schema.ts`) is reused unchanged — `runAgentTurn` keys continuity by `(chat_id, agent_id)`.

## IPC Channels

- `chat:on-demand-agent-list` — `(chatId: string) => Array<{ agentId: string; pendingAnnounce: boolean }>`
- `chat:on-demand-agent-add` — `(chatId: string, agentId: string) => { success: true }`
- `chat:on-demand-agent-remove` — `(chatId: string, agentId: string) => { success: true }`

All require `userActivation.requireActivated()` and use `getProfileScopeUserId()`. The `llm:send-message` MessagePort stream gains the `tool_subevent` event variant (validated by `isLlmStreamEvent` at the contextBridge boundary in `src/preload/index.ts`).

## Services & Key Methods

- `chatStreamingService.stream(input)` — builds `McpToolProvider`s for connected MCPs, calls `buildAgentToolProviders(chatId, settingsUserId, profileUserId, reservedNames)`, unions `getTools()` into `tools[]` + `toolRouting: Map<name, ToolProvider>`, resolves combined announce, threads pending ids into `_runStreamLoop`
- `chatStreamingService._runStreamLoop(...)` — dispatch routes via `provider.callTool(name, input, { onEvent, signal })`; agent providers get an `onEvent` that posts `{ type: 'tool_subevent', toolCallId, event }`; persists `saveToolCall({ ..., toolAgentId, parts })`; clears both MCP + agent pending sets on `round === 0`
- `buildAgentToolProviders(...)` (`a2aAsMcpProvider.ts`) — reads `chatOnDemandAgentRepo.listAgentIds`, resolves each via `agentService.findAgent`, skips unresolved/no-card-url with a warn, assigns collision-free slugs (id-derived suffix), constructs providers
- `A2AAsMcpProvider.getTools()` — synthesizes one tool from `remote_metadata.cinna_mcp` (description/input_schema) or a fallback `{ message }` schema from name/description/example_prompts; `mcpProviderId` field set to the agent id (unused for routing, never shown to LLM)
- `A2AAsMcpProvider.callTool(name, { message }, opts)` — resolves endpoint+token (`agentService`), runs `runAgentTurn`, returns `{ content: text, parts }` or `{ content: error, parts, isError }`. Captures the SDK client + task id via `onClient`/`onTaskId` and, on `signal` abort, calls `client.cancelTask` so the remote agent stops too
- `runAgentTurn(input)` (`a2aStreamingService.ts`) — port-free A2A pump: creates client, streams via `StreamPartsAccumulator`, upserts `a2aSessionRepo`, returns `{ text, parts, notices, contextId, taskId, taskState, error? }`; honors `signal`, forwards delta/status via `onEvent`, surfaces client/taskId via `onClient`/`onTaskId`
- `a2aStreamingService.streamToAgent(input)` — direct-A2A wrapper: registers the request for `cancel`, drives `runAgentTurn`, persists notices + assistant message, posts port events, reports job completion (behavior preserved byte-for-byte)
- `chatService.addOnDemandAgent(userId, chatId, agentId)` — `requireOwnedChat` + `agentService.findAgent` existence check, then `chatOnDemandAgentRepo.add`
- `agentService.syncRemoteAgents` — merges `target.mcp` into `metadata.cinna_mcp` on the upsert

## Renderer Components

- `MainArea` — `combinedAgentIds = dedupe([selectedAgent?.id, ...pendingAgentIds])`; `commPatternInfo = { pattern, agentName?, modelName? }` (agentName only when exactly one agent; modelName from resolved chat-mode model); destination check: A2A always OK, else requires a resolvable model
- `ChatInput` — new-chat `@` agent pick calls `onTogglePendingAgent`; an active-chat `@` agent pick calls `useAttachAgentToChat(chatId)`, which promotes the chat (`chat:promote-to-orchestrated`) when not already orchestrated and then `addOnDemandAgent`; renders `OnDemandAgentChips` (DB mode in active chats, buffer mode on new-chat) and the on-demand MCP chips; `CommPatternBadge` renders on the right, left of the `[+]` attach button (new-chat only); `selectedAgent` still drives example prompts via the agent selector
- `useChatComposer.submit` — reads the chat snapshot and dispatches: agent-rooted + not orchestrated → `startAgent` (direct A2A); otherwise → `startLlm` (orchestrator)
- `useNewChatFlow.startNewChat` — `isA2A = agentIds.length === 1 && onDemandMcpIds.length === 0`; A2A binds `agentId` + `startAgent`; else flushes `addOnDemandMcp` + `addOnDemandAgent` then `startLlm`
- `chat.store.appendToolSubEvent(toolCallId, event)` — only `delta` events (skips `notice`); merges into `ToolCallBlock.subParts` via `appendAgentDeltaPart` (mirrors the main accumulator's `appendToList` merge rules)
- `AgentToolSubThread` — colors by `presetForAgentId(agentId ?? agentName)`; `useEffect` collapses on the live→done transition (verbose keeps open); renders `AgentContribution` (passing `verbose`) or a "Working…" placeholder when `parts` empty + pending
- `AgentContribution` — maps `MessagePart[]` to block components, then `groupConsecutiveCollapsibles` folds consecutive thinking/tool/tool_result into dots (compact) / renders inline (verbose); optional name label + `askMessage` first line; streaming cursor on the last part

## Configuration

None. No env vars, no settings. Orchestrated mode is available whenever the selection resolves to `AI` *and* a chat-mode provider + model are configured.

## Security

- Tokens/endpoints stay main-side: `A2AAsMcpProvider` resolves them through `agentService.resolveAccessToken` / `resolveEndpointIfNeeded` at call time; the orchestrator LLM and renderer never see them.
- The orchestrator LLM only ever receives `{ message }` for an agent tool — no `context_id`, no credentials. Continuity is injected by the desktop via `a2a_sessions`.
- Ownership: the on-demand-agent IPC channels call `requireActivated()` then route through `chatService` which calls `requireOwnedChat`; `addOnDemandAgent` rejects unknown agent ids via `agentService.findAgent` before the FK.
- Cascade deletes (chats → on-demand agent rows, agents → on-demand agent rows) prevent stale rows.
- The combined announce prefix only exposes agent/MCP *display names* to the LLM — no URLs or tokens.

## Implementation Notes

- **Why emulate in the desktop instead of connecting to the backend's MCP endpoint**: avoids a second OAuth/DCR consent per agent, can target a specific shared-route/identity agent deterministically, and keeps `context_id` continuity out of the orchestrator's context window. Execution reuses the external A2A surface the desktop already uses and its durable `a2a_sessions` table.
- **Why split `runAgentTurn` out of `streamToAgent`**: the port-bound cancellation/persistence machinery is request-scoped (direct A2A), while the orchestrator needs a port-free core returning dual output. `streamToAgent` stays a thin wrapper so the single-agent path is preserved exactly.
- **Why `a2aAsMcpProvider` lives in `services/` not `llm/`**: it orchestrates an A2A turn (a service concern). `toolProvider.ts` stays in `llm/` as a pure contract; keeping the provider in `services/` avoids an `llm/ → services/` layering inversion.
- **Compact vs rich split**: only the agent's final text re-enters orchestrator context each round (token safety, no runaway recursion); the rich `parts[]` are persisted/streamed for the UI only — the reason `runAgentTurn` returns dual output.
- **Notices excluded from sub-thread parts**: `runAgentTurn` returns notices separately (not in `parts[]`), and `appendToolSubEvent` drops `notice`-kind deltas, so the live sub-thread matches the reloaded one.
