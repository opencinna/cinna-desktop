# Chat Messaging — Technical Details

## File Locations

### Shared (cross-process types)
- `src/shared/messageParts.ts` — `ContentKind` and `MessagePart` types used by main (DB schema, repo, A2A accumulator) and renderer (store, hook, MessageStream, ThinkingBlock, ToolNarrationBlock). Type-only module; included by both `tsconfig.node.json` and `tsconfig.web.json`

### Main Process
- `src/main/db/schema.ts` — `chats`, `messages`, `chatMcpProviders` table definitions (`messages.parts` typed as `MessagePart[]`)
- `src/main/db/client.ts` — SQLite init, Drizzle instance, inline migrations for chat/message tables
- `src/main/db/chats.ts` — `chatRepo` — chat CRUD, soft-delete/trash, message history loading, all scoped by `userId`
- `src/main/db/messages.ts` — `messageRepo` — centralized message persistence (user, assistant, tool_call, error messages + chat timestamp updates)
- `src/main/db/chatMcp.ts` — `chatMcpRepo` — chat-MCP junction table (`replaceForChat()` runs in a transaction)
- `src/main/services/chatService.ts` — `chatService` — chat CRUD orchestration, throws `ChatError` for missing rows
- `src/main/services/messageRoutingService.ts` — `messageRoutingService` — single chokepoint for "user just sent a routed message": persists the user row (with `addressedAgentId` on the agent path) and fires background title generation. Called by both `agent:send-message` and `llm:send-message` so the side-effects stay consistent. `wireContent` is just the user content (the orchestrated announce prefix is prepended later, inside `chatStreamingService`)
- `src/main/services/chatStreamingService.ts` — LLM tool-call loop only: receives the pre-assembled `wireContent`, rebuilds history from `messages`, drives the up-to-10-round tool-call loop, persists `assistant` / `tool_call` / `error` rows via `messageRepo`, fans out MessagePort events. **No longer persists the user message** — that happens up-stream in `messageRoutingService.prepareLlmSend`
- `src/main/llm/factory.ts` — `createAdapter(type, apiKey, providerId)` + `isProviderType()` (extracted from `llm.ipc.ts`)
- `src/main/ipc/chat.ipc.ts` — Thin `chat:*` handlers, all wrapped with `ipcHandle()` and gated by `userActivation.requireActivated()`, delegate to `chatService`
- `src/main/ipc/llm.ipc.ts` — `llm:send-message` (`ipcMain.on` + MessagePort) — thin controller: receives `LlmSendPayload`, checks activation, calls `messageRoutingService.prepareLlmSend()` then hands `wireContent` to `chatStreamingService.stream()`. `llm:cancel` invokes `chatStreamingService.cancel(requestId)`
- `src/shared/ipcPayloads.ts` — `LlmSendPayload` / `AgentSendPayload` named-object types for the streaming channels (replacing the legacy positional-tuple style)
- `src/main/errors.ts` — `ChatError` + `ChatErrorCode` (`not_found`, `not_configured`, `adapter_unavailable`, `not_activated`)

### Preload
- `src/preload/index.ts` — Exposes `window.api.chat.*` methods via contextBridge

### Renderer
- `src/renderer/src/stores/chat.store.ts` — activeChatId, streamingBlocks (ephemeral, cleared on stop; text blocks include a `segments: string[]` per-delta array for chunk-level animation), isStreaming, streamedIncrementallyChatId (per-chat flag used by MessageStream to skip the block-level reveal on the DB-saved assistant message when its chunks already animated during streaming)
- `src/renderer/src/hooks/useChat.ts` — useChatList, useChatDetail, useCreateChat, useDeleteChat, useUpdateChat, trash hooks, `useSendMessage` (looks up A2A session via `agents.getSession`, routes to LLM or agent stream)
- `src/renderer/src/hooks/useChatStream.ts` — `useChatStream()` — owns the LLM + agent MessagePort event handlers (`startLlm`, `startAgent`, `cancel`); single source of truth for stream-event-to-store fan-out
- `src/renderer/src/hooks/useNewChatFlow.ts` — `useNewChatFlow()` — orchestrates "create chat → set provider/model/MCPs (or agent) → send first message"; exports `resolveModel()` helper for picking a model that exists for a provider
- `src/renderer/src/hooks/useChatModes.ts` — `useDefaultChatMode()` — picks the user's default chat mode (the one with `isDefault: true`); replaces the removed `useDefaultProvider` hook
- `src/renderer/src/hooks/useMcp.ts` — `useChatMcpProviders()`, `useSetChatMcpProviders()` — chat-MCP junction queries/mutations
- `src/renderer/src/components/layout/MainArea.tsx` — Composes `useNewChatFlow` (new-chat send), `useChatDetail` + `useChatModes` (active chat mode resolution), and renders the new-chat / active-chat layouts. No longer owns streaming event handling — that lives in `useChatStream`.
- `src/renderer/src/components/chat/ChatInput.tsx` — Textarea with controls row; auto-focuses the textarea on mount and whenever `chatId` changes, so navigating to a chat (including after the first-message send from the default screen) lands the caret in the input
- `src/renderer/src/components/chat/ChatControls.tsx` — Model dropdown + MCP toggle pills; active MCP IDs re-fetched when provider list changes (prevents stale FK references after provider deletion)
- `src/renderer/src/components/chat/ChatConfigMenu.tsx` — [+] button with LLM/MCP provider submenus
- `src/renderer/src/components/chat/MessageStream.tsx` — Scrollable message list with auto-scroll
- `src/renderer/src/components/chat/MessageBubble.tsx` — User/assistant message with markdown, avatar, metadata popup
- `src/renderer/src/components/chat/ToolCallBlock.tsx` — Animated collapsible tool call display: provider-first badge layout, shimmer progress bar during pending, CSS grid expand/collapse animation, structured JSON input/result rendering with MCP content block unwrapping
- `src/renderer/src/components/chat/ChatList.tsx` — Sidebar chat list
- `src/renderer/src/components/chat/ChatItem.tsx` — Single chat row (click to select, hover to delete)

## Database Schema

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `chats` | Conversations | id, title, model_id, provider_id, created_at, updated_at |
| `messages` | Chat messages | id, chat_id, role (user\|assistant\|tool_call\|error\|agent_transition), content, tool_call_id, tool_name, tool_input (json), tool_calls (json), tool_error (boolean), tool_provider, parts (json — `MessagePart[]`, optional, set by A2A agents with `cinna.content_kind`-tagged parts), source_agent_id, sort_order. `agent_transition` rows hold agent-side system notices (e.g. startup pings) emitted as `cinna.content_kind: 'notice'` parts — never sent back to the LLM and excluded from history rebuilds |
| `chat_mcp_providers` | Junction: MCP servers active per chat | chat_id, mcp_provider_id (composite PK) |

DB location: `{userData}/cinna.db` (e.g., `~/Library/Application Support/cinna-desktop/cinna.db` on macOS).

## IPC Channels

| Channel | Type | Purpose |
|---------|------|---------|
| `chat:list` | invoke | List all chats (sorted by updatedAt desc) |
| `chat:get` | invoke | Get chat + its messages |
| `chat:create` | invoke | Create new empty chat |
| `chat:delete` | invoke | Delete chat (cascades to messages) |
| `chat:update` | invoke | Update title, modelId, providerId |
| `chat:add-message` | invoke | Add a message to a chat |
| `chat:set-mcp-providers` | invoke | Set active MCP providers for a chat |
| `chat:get-mcp-providers` | invoke | Get active MCP providers for a chat |
| `llm:send-message` | postMessage + MessagePort | Stream LLM response |
| `llm:cancel` | invoke | Abort in-flight request |

## Services & Key Methods

- `src/main/db/messages.ts` — `messageRepo`: centralized message persistence: `saveUser()`, `saveAssistant()` (accepts optional `parts: MessagePart[]` for A2A structured messages), `saveToolCall()`, `saveError()`, `touchChat()`, `insertRaw()`, `getById()`. Re-exports `MessagePart` from `src/shared/messageParts.ts`. Single source of truth for all message writes.
- `src/main/db/chats.ts` — `chatRepo`: `getOwned()`, `list()`, `listMessages()`, `listTrash()`, `create()`, `softDelete()`, `restore()`, `permanentDelete()`, `emptyTrash()`, `update()`. All writes scoped by `userId`.
- `src/main/db/chatMcp.ts` — `chatMcpRepo`: `list()`, `listProviderIds()`, `replaceForChat()` (transactional).
- `src/main/services/chatService.ts` — `chatService.list/get/create/delete/listTrash/restore/permanentDelete/emptyTrash/update/addMessage/setMcpProviders/getMcpProviders`. Throws `ChatError('not_found', ...)` for missing/unowned rows.
- `src/main/services/messageRoutingService.ts` — `prepareLlmSend({ userId, chatId, userContent, attachments? })` and `prepareAgentSend({ userId, chatId, agentId, userContent, attachments? })`. Each verifies ownership, persists the user row (agent path stamps `addressedAgentId`), and fires background title generation. Returns `{ wireContent, userMessageId }` where `wireContent === userContent`.
- `src/main/services/chatStreamingService.ts` — `chatStreamingService.stream({ userId, chatId, wireContent, port })`: validates ownership and configuration (throws `ChatError`), aggregates MCP tools, registers the `AbortController` in `activeAbortControllers`, fires the tool-call loop in the background (caller is not awaited), closes the port on completion. `chatStreamingService.cancel(requestId)` aborts the controller. The user message is already persisted before this is called.
- `src/main/llm/factory.ts:createAdapter(type, apiKey, providerId)` — Factory that instantiates the correct LLM adapter based on provider type. Used by `chatStreamingService` (via the registry) and `providerService` (for `test`/`testKey`).
- `src/main/ipc/chat.ipc.ts` — Thin handlers: each `ipcHandle('chat:*', ...)` calls `userActivation.requireActivated()` then delegates to `chatService` with `getCurrentUserId()`.
- `src/main/ipc/llm.ipc.ts` — `ipcMain.on('llm:send-message')` handler: receives MessagePort, checks `userActivation.isActivated()` (sends error to port if not), persists via `messageRoutingService.prepareLlmSend()`, then hands `wireContent` to `chatStreamingService.stream()`. `llm:cancel` is wrapped with `ipcHandle()`.

## Streaming Protocol

Events sent through the MessagePort from main to renderer:

1. `{ type: 'request-id', requestId }` — Identifies the stream for cancellation
2. `{ type: 'delta', text }` — Incremental text chunk
3. `{ type: 'tool_use', id, name, input, provider }` — LLM requests a tool call (provider = MCP connector display name)
4. `{ type: 'tool_result', id, result }` — Tool call completed successfully
5. `{ type: 'tool_error', id, error }` — Tool call failed
6. `{ type: 'done' }` — Stream finished
7. `{ type: 'error', error, errorDetail }` — Error (adapter-parsed short + raw detail). Also persisted to DB as a `role: 'error'` message by `messageRepo.saveError()` so it survives navigation. Renderer handles by calling `stopStreaming()` and invalidating the chat query.

## Optimistic user-message lifecycle

The user's bubble is shown the instant they send — before the persisted row arrives via the `['chat', chatId]` refetch — and must stay continuously visible across the optimistic→persisted handoff (no flicker, no vanishing while the assistant streams). Mirrors the `streamingBlocks` "no visual gap" pattern.

- **Store field** — `src/renderer/src/stores/chat.store.ts` — `pendingUserMessage: { content, baselineUserCount } | null` (type `PendingUserMessage`). `baselineUserCount` snapshots how many persisted `role: 'user'` rows the chat already had at send time.
- **Set on send** — `src/renderer/src/hooks/useChatStream.ts` — `startLlm` / `startAgent` call `setPendingUserMessage({ content, baselineUserCount: snapshotUserCount(chatId) })`; `snapshotUserCount` counts `user` rows in the cached `['chat', chatId]` query.
- **Rendered** — `src/renderer/src/components/chat/MessageStream.tsx` shows the optimistic bubble while `persistedUserCount <= baselineUserCount`. **Count-keyed, not content-keyed** — repeating the previous turn's exact text still shows a bubble (content-keyed dedup hid the second of two identical consecutive messages until its own row refetched).
- **Cleared** — *Not* on the `request-id` (`startStreaming`) or `done` (`finishStreaming`) transitions: clearing there left a window where neither the optimistic bubble nor the not-yet-refetched persisted row was visible, so the user's message vanished while the reply streamed in. Instead retired in the `done` handler's `.finally` (after the `['chat']` refetch settles — its persisted row is already in `messages`, so the clear is gap-free), alongside `clearStreamingBlocks`. Also cleared on chat switch (`setActiveChatId`), `stopStreaming` (stream error / abort / synchronous send-throw — no persisted row is coming), and `reset`.
- **Send re-entrancy** — `src/renderer/src/components/chat/ChatInput.tsx` guards the active-chat send with an `activeSendInFlight` ref (set/reset in try/finally). `isStreaming` only flips on `request-id`, so it can't block a second Enter fired during the `attachNotesAsync` await; the ref prevents double-sending the same turn.

The persisted user content equals the optimistic `content` verbatim (both `prepareLlmSend` / `prepareAgentSend` pass the payload `content` straight to `messageRepo.saveUser`), so the handoff is exact.

## Renderer Components

- `src/renderer/src/components/chat/MessageStream.tsx` — Renders message list, manages auto-scroll to bottom
- `src/renderer/src/components/chat/MessageBubble.tsx` — Renders a single message with react-markdown + remark-gfm + rehype-highlight; info icon shows metadata popup on hover
- `src/renderer/src/components/chat/ToolCallBlock.tsx` — Animated collapsible block: provider badge shown first (accent-colored with Plug icon) followed by muted tool name; chevron rotates on expand; CSS grid `gridTemplateRows` animation (150ms); shimmer progress bar on top during pending state; structured JSON input/result view with MCP content block unwrapping
- `src/renderer/src/components/chat/ChatInput.tsx` — Input textarea; controls row below: [+] config on left, model/MCP center, send on right
