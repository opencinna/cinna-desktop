# Orchestrated Agents — Technical Details

## Runner-owned coordinator turns

`src/main/services/coordinatorToolProvider.ts` supplies fixed controls only through internal runner admission. `chatStreamingService` places it first in the tool union, preserving its names over MCP collisions, and omits the ordinary synthesized agent providers for these turns. `describeCall` gives delegate calls the existing agent sub-thread presentation; returned specialist controls are stripped. End-of-turn controls settle all later tool pairs without running them. See [autonomous implementation](../../jobs/tasks/autonomous_tasks_tech.md); the ordinary provider path below remains unchanged.

## File Locations

### Main process
- `src/main/llm/toolProvider.ts` — `ToolProvider` (display identity, optional static `attribution`, trusted `eventSink`, dynamic `describeCall`, tools and execution), result/options types, and `McpToolProvider`.
- `src/main/services/a2aAsMcpProvider.ts` — `A2AAsMcpProvider` (implements `ToolProvider`, one per attached agent), `buildAgentToolProviders` factory, `sanitizeToolSlug`, collision-suffix logic
- `src/main/services/a2aStreamingService.ts` — `runAgentTurn` (port-free dual-output core) + `streamToAgent` (thin direct-A2A wrapper driving `runAgentTurn`) + `cancel`
- `src/main/services/chatStreamingService.ts` — builds the tool-routing map, rebuilds attributed history, dispatches through provider methods/sinks and persists tool results/parts. Only trusted coordinator controls may end a coordinator turn.
- `src/main/services/chatService.ts` — `listOnDemandAgents`, `addOnDemandAgent` (validates via `agentService.findAgent`), `removeOnDemandAgent`, `setRouter` (the transition on and off `'coordinator'`)
- `src/main/services/agentService.ts` — `findAgent` (dual-scope resolve), `resolveEndpointIfNeeded`, `resolveAccessToken` (reused by the agent provider); `syncRemoteAgents` carries `target.mcp` into `remote_metadata.cinna_mcp`
- `src/main/db/schema.ts` — `chatOnDemandAgents` table; `messages.toolAgentId` column; `chats.router` (`'coordinator'` is this feature; the legacy mirror is retired — see [Chat Routing](../chat_routing/chat_routing_tech.md))
- `src/main/db/migrations/chat-router.ts` backfills chats.router from the legacy flag; `src/main/db/migrations/retire-chat-mirror.ts` drops the flag afterward. messages.tool_agent_id remains in the messages migration.
- `src/main/db/migrations/chats.ts` — `CREATE TABLE IF NOT EXISTS chat_on_demand_agents`
- `src/main/db/migrations/messages.ts` — `ALTER TABLE messages ADD COLUMN tool_agent_id`
- `src/main/db/chatOnDemandAgent.ts` — `chatOnDemandAgentRepo` (add/remove/list/listAgentIds/peekPending/clearPending). `list` orders by `created_at, agent_id`: without it SQLite returns composite-primary-key order — by a nanoid — which a `human` chat's "first attached answers" fallback made user-visible
- `src/main/db/messages.ts` — `saveToolCall` accepts `toolAgentId` + `parts` (rich sub-thread payload on the tool_call row)
- `src/main/db/agents.ts` — `a2aSessionRepo.getByChatAndAgent` / `upsert` (per-`(chat, agent)` continuity used by `runAgentTurn`)
- `src/main/ipc/chat.ipc.ts` — `chat:on-demand-agent-{list,add,remove}` and `chat:set-router` handlers
- `src/main/ipc/run.ipc.ts` → `src/main/services/runExecutionService.ts` — the shared executor resolves the answerer; `{ kind: 'model' }` is what reaches `chatStreamingService.stream` here
- `src/main/mcp/manager.ts` — `getToolsForProviders` now tags tools `providerType: 'mcp'`

### Shared
- `src/shared/agentMetadata.ts` — `CinnaMcpDescriptor` type + `RemoteAgentMetadata.cinna_mcp`
- `src/shared/runEvents.ts` — `RunChildEvent` (`child { toolCallId, agentId, event }`), `RunToolUseEvent.providerType` + `providerAgentId`, guard `isRunEvent`. See [Stream Event Typing](../../development/stream_event_typing/stream_event_typing_llm.md)
- `src/shared/partMerge.ts` — `continuesPart`, the merge rule `appendAgentDeltaPart` shares with the main-process accumulator
- `src/shared/messageParts.ts` — `MessagePart` shape reused for the persisted/streamed sub-thread
- `src/main/llm/types.ts` — `ToolDefinition.providerType`
- `src/main/mcp/types.ts` — `McpTool.providerType: 'mcp'`

### Preload
- `src/preload/index.ts` — `window.api.chat.{listOnDemandAgents,addOnDemandAgent,removeOnDemandAgent}`; `MessageData.toolAgentId`

### Renderer
- `src/shared/chatRouting.ts` — the routing rule, shared by renderer + main. `newChatRouter` answers `'coordinator'` for any agent mixed with an MCP server, and for the composer's explicit toggle
- `src/renderer/src/components/chat/RouterBadge.tsx` — the three-value badge; **Model routes** is this feature's value
- `src/renderer/src/components/chat/OnDemandAgentChips.tsx` — removable agent chips, two modes: DB-backed (`chatId` prop, active chat) and buffer-backed (`pendingIds` + `onRemovePending`, new chat) — mirrors `ActiveMcpChips`
- `src/renderer/src/hooks/useAgents.ts` — `useChatOnDemandAgents`, `useAddOnDemandAgent`, `useRemoveOnDemandAgent` (React Query hooks, cache key `['chat-on-demand-agent', chatId]`, scoped `on-demand-agent` logger on error)
- `src/renderer/src/components/chat/AgentContribution.tsx` — reusable parts renderer (name label + hash color + thinking/tool/tool_result/text/command_result blocks). Builds a `RenderNode[]` and runs it through the shared `groupConsecutiveCollapsibles` (from `CollapsibleGroup.tsx`) so consecutive auxiliary steps fold into dots in compact mode; renders every part inline in verbose. Takes a `verbose` prop threaded from `AgentToolSubThread`.
- `src/renderer/src/components/chat/CollapsibleGroup.tsx` — dots-group component + shared `RenderNode` type and `groupConsecutiveCollapsibles` helper, used by both this sub-thread and the main transcript (`MessageStream`)
- `src/renderer/src/components/chat/AgentToolSubThread.tsx` — expandable wrapper (header: agent badge, `· {n} steps · {status}` appended in verbose mode; hash-colored inset, auto-expand/collapse). Threads `verbose` into `AgentContribution`.
- `src/renderer/src/components/chat/MessageStream.tsx` — renders `AgentToolSubThread` for persisted tool_call rows with `parts` and for streaming blocks with `providerType === 'agent'`
- `src/renderer/src/components/chat/ChatInput.tsx` — `@`-mention agent picks route to `onTogglePendingAgent` (new chat) or `useAttachAgentToChat` (active chat); renders chips, badge and the `[+]` coordinate toggle
- `src/renderer/src/components/layout/MainArea.tsx` — owns `pendingAgentIds`, computes `combinedAgentIds` + `routerInfo`, and requires a model only when the selection resolves to `'coordinator'` (or names no agent at all)
- `src/renderer/src/hooks/useNewChatFlow.ts` — `startNewChat(agentIds[], ...)` decision rule + on-demand agent flush
- `src/renderer/src/hooks/useChatStream.ts` — `handleRun` passes `providerType`/`providerAgentId` to `addToolCall` and routes a `child` event: a nested `needs_input` / `input_resolved` to the chat store's `inputRequests`, tagged with the `toolCallId`; a `child` inside a `child` is dropped; everything else goes to `appendToolSubEvent`. `tool_result` / `tool_error` drop that call's asks (`dropInputRequestsFor`)
- `src/renderer/src/stores/chat.store.ts` — `ToolCallBlock.{providerType,agentId,subParts}`, `appendToolSubEvent`, `appendAgentDeltaPart` merge helper (calls `continuesPart`), `dropInputRequestsFor`
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

- `chat:set-router` — `(chatId, 'coordinator' | 'human' | 'direct') => { success: true }`; see [Chat Routing](../chat_routing/chat_routing_tech.md)

All require `userActivation.requireActivated()` and use `getProfileScopeUserId()`. The `run:send` MessagePort stream carries a sub-turn's events wrapped in `child` (validated by `isRunEvent` at the contextBridge boundary in `src/preload/index.ts`). `llm:send-message` still reaches the same code as a forward, for one phase.

## Services & Key Methods

- `chatStreamingService.stream(input)` — builds `McpToolProvider`s for connected MCPs, calls `buildAgentToolProviders(chatId, settingsUserId, profileUserId, reservedNames)`, unions `getTools()` into `tools[]` + `toolRouting: Map<name, ToolProvider>`, resolves combined announce, threads pending ids into `_runStreamLoop`
- `chatStreamingService._runStreamLoop(...)` — invokes `provider.eventSink(toolCallId, publish)` when supplied, passes it with the abort signal to `callTool`, and persists result identity/parts. Static history attribution uses `provider.attribution`; dynamic `describeCall` targets only describe the current call. The loop does not choose framing from `providerType`.
- `buildAgentToolProviders(...)` (`a2aAsMcpProvider.ts`) — reads `chatOnDemandAgentRepo.listAgentIds`, resolves each via `agentService.findAgent`, skips unresolved/no-card-url with a warn, assigns collision-free slugs (id-derived suffix), constructs providers
- `A2AAsMcpProvider.attribution` supplies the attached agent’s stable ID/name. Its `eventSink` wraps raw driver events once as `child { toolCallId, agentId, event }`. `getTools()` synthesizes the descriptor or fallback tool as before.
- `A2AAsMcpProvider.callTool(name, input, opts)` — refuses re-entry if this agent already has an open next-message request in this chat, returning a tool error that directs the coordinator to wait for the human’s Inbox answer. Otherwise calls `driverFor(agent).run` with signal/events and returns compact content plus rich parts. Driver-owned endpoint/token and cancellation details stay behind that seam.
- `runAgentTurn(input)` (`a2aStreamingService.ts`) — port-free A2A pump: creates client, streams via `StreamPartsAccumulator`, upserts `a2aSessionRepo`, returns `{ text, parts, notices, contextId, taskId, taskState, error? }` — a thrown failure returns empty `text` / `parts` / `notices` beside the `error`, **except** when the turn had already been stopped: then the throw is how the stop ended (a server dropping the connection after `tasks/cancel`), and what the accumulator streamed is returned so the stopped text is kept (golden `a2a/canceled_then_stream_error`); honors `signal`, forwards delta/status via `onEvent`, surfaces client/taskId via `onClient`/`onTaskId`
- `a2aStreamingService.streamToAgent(input)` — direct-A2A wrapper: registers the request for `cancel`, drives `runAgentTurn`, persists notices + assistant message, posts port events, reports job completion, which defers while durable next-message requests remain
- `chatService.addOnDemandAgent(userId, chatId, agentId)` — `requireOwnedChat` + `agentService.findAgent` existence check, then `chatOnDemandAgentRepo.add`
- `agentService.syncRemoteAgents` — merges `target.mcp` into `metadata.cinna_mcp` on the upsert

## Renderer Components

- `MainArea` — `combinedAgentIds = dedupe([selectedAgent?.id, ...pendingAgentIds])`; `routerInfo = { router, agentName?, answererName?, modelName? }` (modelName from the resolved chat-mode model); the send requires a resolvable model only for `'coordinator'` or a selection with no agent in it
- `ChatInput` — new-chat `@` agent pick calls `onTogglePendingAgent`; an active-chat `@` agent pick calls `useAttachAgentToChat(chatId)`, which moves the chat onto the router that shape needs (`chat:set-router` — `'coordinator'` only when the chat had no agent of its own) and then `addOnDemandAgent`; renders `OnDemandAgentChips` (DB mode in active chats, buffer mode on new-chat) and the on-demand MCP chips; `RouterBadge` renders at the right of the controls row, left of Send, in **both** new and active chats; `selectedAgent` still drives example prompts via the agent selector
- `useChatComposer.submit` — no longer picks a destination. It calls `startRun` on the one channel; main reads `chats.router` and reaches `chatStreamingService` for a coordinated chat. See [Chat Routing](../chat_routing/chat_routing_tech.md)
- `useNewChatFlow.startNewChat` — `newChatRouter(agentIds, onDemandMcpIds)`; a coordinated chat binds no root, flushes `addOnDemandMcp` + `addOnDemandAgent`, resolves a provider/model, and sends with `target = { kind: 'model' }`
- `chat.store.appendToolSubEvent(toolCallId, event)` — only `delta` events (skips `notice`); merges into `ToolCallBlock.subParts` via `appendAgentDeltaPart`, which calls `continuesPart` (`src/shared/partMerge.ts`) — the accumulator's own rule, so the live sub-thread splits exactly where the persisted one will. A nested `status`, `done` or `error` is dropped here, so a sub-turn ending never ends the outer turn
- Nested asks — `child` events reach the main Inbox observer with the child agent and parent-turn/tool-call identity, independently of the renderer’s transient sub-thread state. Reply asks use the driver’s live registry; next-message questions remain in the Inbox after the tool call ends. Its answer targets the asking agent through the shared executor even when the chat router is coordinator. Other agents’ asks remain open, and a repeated invocation gets a new address. `AgentToolSubThread` itself adds no separate answer controls; use [the Inbox](../../jobs/tasks/inbox.md).
- `AgentToolSubThread` — colors by `presetForAgentId(agentId ?? agentName)`; `useEffect` collapses on the live→done transition (verbose keeps open); renders `AgentContribution` (passing `verbose`) or a "Working…" placeholder when `parts` empty + pending
- `AgentContribution` — maps `MessagePart[]` to block components, then `groupConsecutiveCollapsibles` folds consecutive thinking/tool/tool_result into dots (compact) / renders inline (verbose); optional name label + `askMessage` first line; streaming cursor on the last part

## Configuration

None. No env vars, no settings. Coordination is available whenever a chat-mode provider + model are configured; without one, the switch onto `'coordinator'` is refused with `ChatError('not_configured', …)`.

## Security

- Provider contracts are trusted main-process wiring. `McpToolProvider` supplies no attribution or event sink and wraps manager output as content; result fields cannot select event identity or framing.
- Coordinator delegates already frame their events once inside `CoordinatorToolProvider.callTool`; its sink passes them through, while durable question events stay at the root. Specialists cannot return coordinator authority: delegate results strip their controls.
- `providerType` still describes transcript presentation and gates successful coordinator `exec.control`. Removing it from event delivery does not remove that authority check. Static attribution and dynamic target metadata are separate so a delegated call cannot rewrite historical attribution.

- Tokens/endpoints stay main-side: `A2AAsMcpProvider` runs the agent's driver (`driverFor(agent).run`). For an A2A agent, the driver's pre-flight resolves the token and endpoint at call time, through `resolveAccessToken` / `resolveEndpointIfNeeded` in `src/main/agents/drivers/a2aConnection.ts`; the orchestrator LLM and renderer never see them.
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

### Provider-contract regression coverage

`src/main/services/a2aAsMcpProvider.test.ts` checks the real agent wrapper’s static identity and one child envelope. `src/main/services/coordinatorToolProvider.test.ts` checks delegate framing through its actual sink. `src/main/services/chatStreamingService.stop.test.ts` checks sink-driven delivery independent of presentation type, static versus dynamic history attribution and refusal of coordinator control embedded in ordinary content.
