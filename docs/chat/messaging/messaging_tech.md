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
- `src/main/services/chatStreamingService.ts` — Streaming orchestration: ownership check, MCP tool aggregation, centralized tool-call loop (up to 10 rounds), message persistence via `messageRepo`, MessagePort fan-out
- `src/main/llm/factory.ts` — `createAdapter(type, apiKey, providerId)` + `isProviderType()` (extracted from `llm.ipc.ts`)
- `src/main/ipc/chat.ipc.ts` — Thin `chat:*` handlers, all wrapped with `ipcHandle()` and gated by `userActivation.requireActivated()`, delegate to `chatService`
- `src/main/ipc/llm.ipc.ts` — `llm:send-message` (`ipcMain.on` + MessagePort) — checks activation, delegates to `chatStreamingService.stream()`. `llm:cancel` invokes `chatStreamingService.cancel(requestId)`.
- `src/main/errors.ts` — `ChatError` + `ChatErrorCode` (`not_found`, `not_configured`, `adapter_unavailable`, `not_activated`)

### Preload
- `src/preload/index.ts` — Exposes `window.api.chat.*` methods via contextBridge

### Renderer
- `src/renderer/src/stores/chat.store.ts` — activeChatId, streamingBlocks (ephemeral, cleared on stop; text blocks include a `segments: string[]` per-delta array for chunk-level animation), isStreaming, streamedIncrementallyChatId (per-chat flag used by MessageStream to skip the block-level reveal on the DB-saved assistant message when its chunks already animated during streaming)
- `src/renderer/src/hooks/useChat.ts` — useChatList, useChatDetail, useCreateChat, useDeleteChat, useUpdateChat, trash hooks, `useSendMessage` (looks up A2A session via `agents.getSession`, routes to LLM or agent stream)
- `src/renderer/src/hooks/useChatStream.ts` — `useChatStream()` — owns the LLM + agent MessagePort event handlers (`startLlm`, `startAgent`, `cancel`); single source of truth for stream-event-to-store fan-out
- `src/renderer/src/hooks/useNewChatFlow.ts` — `useNewChatFlow()` — orchestrates "create chat → set provider/model/MCPs (or agent) → send first message"; exports `resolveModel()` helper for picking a model that exists for a provider
- `src/renderer/src/hooks/useDefaultProvider.ts` — `useDefaultProviderId()` — picks the user's default LLM provider (enabled + has API key, prefers `isDefault`)
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
| `messages` | Chat messages | id, chat_id, role (user\|assistant\|tool_call\|error), content, tool_call_id, tool_name, tool_input (json), tool_calls (json), tool_error (boolean), tool_provider, parts (json — `MessagePart[]`, optional, set by A2A agents with `cinna.content_kind`-tagged parts), sort_order |
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
- `src/main/services/chatStreamingService.ts` — `chatStreamingService.stream({ userId, chatId, userContent, port })`: validates ownership and configuration (throws `ChatError`), aggregates MCP tools, registers the `AbortController` in `activeAbortControllers`, fires the tool-call loop in the background (caller is not awaited), closes the port on completion. `chatStreamingService.cancel(requestId)` aborts the controller.
- `src/main/llm/factory.ts:createAdapter(type, apiKey, providerId)` — Factory that instantiates the correct LLM adapter based on provider type. Used by `chatStreamingService` (via the registry) and `providerService` (for `test`/`testKey`).
- `src/main/ipc/chat.ipc.ts` — Thin handlers: each `ipcHandle('chat:*', ...)` calls `userActivation.requireActivated()` then delegates to `chatService` with `getCurrentUserId()`.
- `src/main/ipc/llm.ipc.ts` — `ipcMain.on('llm:send-message')` handler: receives MessagePort, checks `userActivation.isActivated()` (sends error to port if not), delegates the entire stream to `chatStreamingService.stream()`. `llm:cancel` is wrapped with `ipcHandle()`.

## Streaming Protocol

Events sent through the MessagePort from main to renderer:

1. `{ type: 'request-id', requestId }` — Identifies the stream for cancellation
2. `{ type: 'delta', text }` — Incremental text chunk
3. `{ type: 'tool_use', id, name, input, provider }` — LLM requests a tool call (provider = MCP connector display name)
4. `{ type: 'tool_result', id, result }` — Tool call completed successfully
5. `{ type: 'tool_error', id, error }` — Tool call failed
6. `{ type: 'done' }` — Stream finished
7. `{ type: 'error', error, errorDetail }` — Error (adapter-parsed short + raw detail). Also persisted to DB as a `role: 'error'` message by `messageRepo.saveError()` so it survives navigation. Renderer handles by calling `stopStreaming()` and invalidating the chat query.

## Renderer Components

- `src/renderer/src/components/chat/MessageStream.tsx` — Renders message list, manages auto-scroll to bottom
- `src/renderer/src/components/chat/MessageBubble.tsx` — Renders a single message with react-markdown + remark-gfm + rehype-highlight; info icon shows metadata popup on hover
- `src/renderer/src/components/chat/ToolCallBlock.tsx` — Animated collapsible block: provider badge shown first (accent-colored with Plug icon) followed by muted tool name; chevron rotates on expand; CSS grid `gridTemplateRows` animation (150ms); shimmer progress bar on top during pending state; structured JSON input/result view with MCP content block unwrapping
- `src/renderer/src/components/chat/ChatInput.tsx` — Input textarea; controls row below: [+] config on left, model/MCP center, send on right
