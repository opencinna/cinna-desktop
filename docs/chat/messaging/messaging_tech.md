# Chat Messaging — Technical Details

## File Locations

### Main Process
- `src/main/db/schema.ts` — `chats`, `messages`, `chatMcpProviders` table definitions
- `src/main/db/client.ts` — SQLite init, Drizzle instance, inline migrations for chat/message tables
- `src/main/db/messages.ts` — `messageRepo` — centralized message persistence (user, assistant, tool_call, error messages + chat timestamp updates)
- `src/main/ipc/chat.ipc.ts` — Chat CRUD handlers: list, get, create, delete, update, add-message, set/get-mcp-providers
- `src/main/ipc/llm.ipc.ts` — Streaming handler, centralized tool-call loop (up to 10 rounds), delegates message persistence to `messageRepo`, adapter factory (`createAdapter()`)

### Preload
- `src/preload/index.ts` — Exposes `window.api.chat.*` methods via contextBridge

### Renderer
- `src/renderer/src/stores/chat.store.ts` — activeChatId, streamingBlocks (ephemeral, cleared on stop), isStreaming
- `src/renderer/src/hooks/useChat.ts` — useChatList, useChatDetail, useCreateChat, useDeleteChat, useSendMessage (streaming handler with provider field)
- `src/renderer/src/components/layout/MainArea.tsx` — Default-screen send handler (creates chat + sends first message); has its own streaming event handler that must mirror `useSendMessage` (including `provider` in `addToolCall`); auto-enables all active MCP providers on mount
- `src/renderer/src/components/chat/ChatInput.tsx` — Textarea with controls row
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
| `messages` | Chat messages | id, chat_id, role (user\|assistant\|tool_call\|error), content, tool_call_id, tool_name, tool_input (json), tool_calls (json), tool_error (boolean), tool_provider, sort_order |
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

- `src/main/db/messages.ts` — `messageRepo`: centralized message persistence: `saveUser()`, `saveAssistant()`, `saveToolCall()`, `saveError()`, `touchChat()`. Single source of truth for all message writes.
- `src/main/ipc/llm.ipc.ts` — `ipcMain.on('llm:send-message')` handler: receives MessagePort, delegates message persistence to `messageRepo`, loads history (filtering out `role: 'error'`), gathers tools, runs centralized tool-call loop. On error, persists via `messageRepo.saveError()`.
- `src/main/ipc/llm.ipc.ts:createAdapter()` — Factory that instantiates the correct LLM adapter based on provider type
- `src/main/ipc/chat.ipc.ts` — All `ipcMain.handle('chat:*')` handlers for CRUD operations

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
