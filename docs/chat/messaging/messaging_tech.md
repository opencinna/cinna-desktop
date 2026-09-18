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
- `src/main/services/runExecutionService.ts` dispatches every conversational turn to an agent driver; `src/main/services/conductorBridge.ts` serves runtime tools and `src/main/services/conductorTranscript.ts` handles replacement-session history. SDK adapter calls are limited to AI Functions.
- `src/main/services/runExecutionService.ts` dispatches every conversational turn to an agent driver; `src/main/services/conductorBridge.ts` serves runtime tools and `src/main/services/conductorTranscript.ts` handles replacement-session history. SDK adapter calls are limited to AI Functions.
- `src/main/llm/factory.ts` — `createAdapter(type, apiKey, providerId)` + `isProviderType()` (extracted from `llm.ipc.ts`)
- `src/main/ipc/chat.ipc.ts` — Thin `chat:*` handlers, all wrapped with `ipcHandle()` and gated by `userActivation.requireActivated()`, delegate to `chatService`
- `src/main/ipc/run.ipc.ts` — `run:start` command and owned `run:watch` subscription; the lower-level run:send port route shares the executor; old agent/model forwards are removed. `src/main/ipc/llm.ipc.ts` retains model listing and `llm:cancel`.
- `src/main/services/runQueueService.ts` — what `run:start` does when the chat already has a turn running: steer the message into it or queue it; see [Pending Messages tech](../pending_messages/pending_messages_tech.md)
- `src/shared/ipcPayloads.ts` — RunSendPayload is the single routed send input; the old agent/model-specific payload types are removed. `RunStartResult` and `RunQueueView` are what `run:start` and the queue channels return
- `src/main/errors.ts` — `ChatError` + `ChatErrorCode` (`not_found`, `not_configured`, `adapter_unavailable`, `not_activated`)

### Preload

- `src/preload/index.ts` — Exposes `window.api.chat.*` methods via contextBridge

### Renderer

- `src/renderer/src/stores/chat.store.ts` — selected chat, run ID, projection version, baseline message IDs, streaming blocks, input requests and optimistic user message. A matching successful terminal read replaces the projection with persisted messages; see [live-run state](live_runs.md#implementation-and-ownership).
- `src/renderer/src/hooks/useChat.ts` — useChatList, useChatDetail, useCreateChat, useDeleteChat, useUpdateChat, trash hooks, `useSetChatRouter` (moves a chat between routers; replaced `usePromoteToOrchestrated`). The old `useSendMessage`, which looked up an A2A session to decide where a message went, is gone — main resolves that now
- `src/renderer/src/hooks/useChatStream.ts` — `startRun` issues `run.start`; `useRunEventHandler` projects events only. `src/renderer/src/hooks/useLiveRunWatch.ts` owns the selected-chat subscription, replay and guarded terminal settlement, mounted once by `MainArea`. See [Live Run Attachment and Replay](live_runs.md).
- `src/renderer/src/hooks/useNewChatFlow.ts` — `useNewChatFlow()` — orchestrates "create chat → set provider/model/MCPs (or agent) → send first message"; exports `resolveModel()` helper for picking a model that exists for a provider. Optional `isCurrent` protects entry-page/account lifetime across awaits and uses the `useCreateChat` mutation with `{ select: false }` until preparation succeeds. Same-account orphan cleanup soft-deletes and refreshes Chats/Trash only after success; account switches skip cleanup. Ordinary unguarded callers keep immediate selection. See [build-entry lifecycle](../../agents/local_dev/build_sessions_tech.md#first-chat-lifecycle)
- `src/renderer/src/hooks/useChatModes.ts` — `useDefaultChatMode()` — picks the user's default chat mode (the one with `isDefault: true`); replaces the removed `useDefaultProvider` hook
- `src/renderer/src/hooks/useMcp.ts` — `useChatMcpProviders()`, `useSetChatMcpProviders()` — chat-MCP junction queries/mutations
- `src/renderer/src/components/layout/MainArea.tsx` — Routes the active view and mounts `useLiveRunWatch` once, including while an agent landing page is open; event projection remains in `useRunEventHandler`.
- `src/renderer/src/components/layout/ChatWorkspace.tsx` — Composes `useNewChatFlow` (new-chat send), `useChatDetail` + `useChatModes` (active chat mode resolution), and the new-chat / active-chat layouts. Agent pages embed its new-chat branch with their agent preselected; see [Shared workspace](../../ui/app_shell/app_shell_tech.md#shared-chat-workspace).
- `src/renderer/src/components/chat/ChatInput.tsx` — Textarea with controls row; auto-focuses the textarea on mount and whenever `chatId` changes, so navigating to a chat (including after the first-message send from the default screen) lands the caret in the input
- `src/renderer/src/components/chat/ComposerPlusMenu.tsx` — `[+]` button consolidating attach-files, chat-mode, and add-agents/MCP (replaced the retired `ChatConfigMenu`)
- `src/renderer/src/components/chat/MessageStream.tsx` — Scrollable message list. Follows the bottom of a streaming reply only while the user has not scrolled away from it (`useStickToBottom`); an arriving chunk never pulls the view back. See [Transcript Scrolling](../conversation_ui/scroll_following.md)
- `src/renderer/src/components/chat/MessageBubble.tsx` — User/assistant message with markdown, avatar, metadata popup
- `src/renderer/src/components/chat/ToolCallBlock.tsx` — Animated collapsible tool call display: provider-first badge layout, spinner during pending, CSS grid expand/collapse animation, structured JSON input/result rendering with MCP content block unwrapping
- `src/renderer/src/components/chat/ChatList.tsx` — Sidebar chat list
- `src/renderer/src/components/chat/ChatItem.tsx` — Selectable chat row with running spinner/interrupt action or stopped unread-result/delete action; mutations stay in useChat hooks. [Sidebar status details](../session_status/session_status_tech.md)

## Database Schema

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `chats` | Conversations | id, title, model_id, provider_id, created_at, updated_at |
| `chat_run_results` | Latest local sidebar outcome | chat_id (PK, cascade from chats), run_id (result identity), status, unread; [ownership and acknowledgement](../session_status/session_status_tech.md#database-schema) |
| `messages` | Chat messages | id, chat_id, role (user\|assistant\|tool_call\|error\|agent_transition), content, tool_call_id, tool_name, tool_input (json), tool_calls (json), tool_error (boolean), tool_provider, parts (json — `MessagePart[]`, optional, set by A2A agents with `cinna.content_kind`-tagged parts), source_agent_id, sort_order. `agent_transition` rows hold agent-side system notices (e.g. startup pings) emitted as `cinna.content_kind: 'notice'` parts — never sent back to the LLM and excluded from history rebuilds |
| `chat_mcp_providers` | Junction: MCP servers active per chat | chat_id, mcp_provider_id (composite PK) |

DB location: `{userData}/cinna.db` (e.g., `~/Library/Application Support/cinna-desktop/cinna.db` on macOS).

## IPC Channels

| Channel | Type | Purpose |
|---------|------|---------|
| `chat:list` | invoke | List visible chats (sorted by updatedAt desc), including activeRunId and lastRunResult |
| `chat:get` | invoke | Get owned chat + saved messages, activeRunId and lastRunResult; does not acknowledge reading |
| `chat:mark-result-read` | invoke | Mark the owned chat's matching result ID read; stale IDs cannot clear a newer result |
| `chat:create` | invoke | Create new empty chat |
| `chat:delete` | invoke | Soft-delete stopped chat; active work refuses with run_active until interrupted. Permanent deletion performs cascade cleanup |
| `chat:update` | invoke | Update title, modelId, providerId |
| `chat:add-message` | invoke | Add a message to a chat |
| `chat:set-mcp-providers` | invoke | Set active MCP providers for a chat |
| `chat:get-mcp-providers` | invoke | Get active MCP providers for a chat |
| `run:start` | invoke | Start a main-owned turn, or steer into / queue behind a running one; returns `RunStartResult` |
| `run:watch` | postMessage + MessagePort | Snapshot and subsequent selected-chat run events |
| `run:cancel-chat` | invoke | Cancel owned active chat, including before transport request ID |
| `run:queue-list` / `run:queue-take` / `run:queue-remove` / `run:queue-edit` | invoke | A chat's queued messages; see [Pending Messages tech](../pending_messages/pending_messages_tech.md#ipc-channels) |
| `run:queue-changed` | main → renderer | `{ chatId, view }` after every queue change |
| run:send | postMessage + MessagePort | Lower-level routed send through shared executor |
| `llm:cancel` | invoke | Abort in-flight request |

## Services & Key Methods

- `src/main/db/messages.ts` — `messageRepo`: centralized message persistence: `saveUser()`, `saveAssistant()` (accepts optional `parts: MessagePart[]` for A2A structured messages), `saveToolCall()`, `saveError()`, `touchChat()`, `insertRaw()`, `getById()`. Re-exports `MessagePart` from `src/shared/messageParts.ts`. Single source of truth for all message writes.
- `src/main/db/chats.ts` — `chatRepo`: `getOwned()`, `list()`, `listMessages()`, `listTrash()`, `create()`, `softDelete()`, `restore()`, `permanentDelete()`, `emptyTrash()`, `update()`. All writes scoped by `userId`.
- `src/main/db/chatMcp.ts` — `chatMcpRepo`: `list()`, `listProviderIds()`, `replaceForChat()` (transactional).
- `src/main/services/chatService.ts` — `chatService.list/get/create/delete/listTrash/restore/permanentDelete/emptyTrash/update/addMessage/setMcpProviders/getMcpProviders`. Throws `ChatError('not_found', ...)` for missing/unowned rows.
- `src/main/services/messageRoutingService.ts` — `prepareLlmSend({ userId, chatId, userContent, attachments? })` and `prepareAgentSend({ userId, chatId, agentId, userContent, attachments? })`. Each verifies ownership, persists the user row (agent path stamps `addressedAgentId`), and fires background title generation. Returns `{ wireContent, userMessageId }` where `wireContent === userContent`.
- `src/main/services/runExecutionService.ts` dispatches every conversational turn to an agent driver; `src/main/services/conductorBridge.ts` serves runtime tools and `src/main/services/conductorTranscript.ts` handles replacement-session history. SDK adapter calls are limited to AI Functions.
- `src/main/services/runExecutionService.ts` dispatches every conversational turn to an agent driver; `src/main/services/conductorBridge.ts` serves runtime tools and `src/main/services/conductorTranscript.ts` handles replacement-session history. SDK adapter calls are limited to AI Functions.
- `src/main/ipc/chat.ipc.ts` — Thin handlers: each `ipcHandle('chat:*', ...)` calls `userActivation.requireActivated()` then delegates to `chatService` with `getCurrentUserId()`.
- `src/main/ipc/run.ipc.ts` — activated command/subscription boundary; renderer observation is independent of turn lifetime. The generic run.send native-port entry remains available. Full [IPC contract](live_runs.md#architecture-and-ipc).

## Streaming Protocol

Events are `RunEvent`s (`src/shared/runEvents.ts`), the one vocabulary every chat's port carries — see [Stream Event Typing](../../development/stream_event_typing/stream_event_typing_llm.md). What an LLM chat posts:

1. `{ type: 'request-id', requestId }` — Identifies the stream for cancellation
2. `{ type: 'delta', kind: 'text', text }` — Incremental text chunk
3. `{ type: 'tool_use', id, name, input, provider, providerType, providerAgentId }` — LLM requests a tool call (`provider` = MCP connector or agent display name; `providerType: 'agent'` renders as a sub-thread)
4. `{ type: 'tool_result', id, result }` — Tool call completed successfully
5. `{ type: 'tool_error', id, error }` — Tool call failed
6. `{ type: 'child', toolCallId, agentId, event }` — One event of an agent called as a tool, streamed into that call's sub-thread (see [Orchestrated Agents tech](../orchestrated_agents/orchestrated_agents_tech.md))
7. `{ type: 'done', stopReason }` — Stream finished: `end_turn`, or `canceled` whenever a stop ended the turn, wherever the stop landed (see [Cancellation](#cancellation))
8. `{ type: 'error', error, errorDetail }` — Error (adapter-parsed short + raw detail). Also persisted to DB as a `role: 'error'` message by `messageRepo.saveError()` so it survives navigation. The projector finishes streaming; authoritative hub closure starts a fresh transcript read and guarded cleanup. A failed read preserves the projection for recovery.

An agent turn can also post `{ type: 'user_message', text }` where its engine took a message the user sent mid-turn; see [Pending Messages](../pending_messages/pending_messages.md).

## Optimistic user-message lifecycle

The user's bubble is shown the instant they send — before the persisted row arrives via the `['chat', chatId]` refetch — and must stay continuously visible across the optimistic→persisted handoff (no flicker, no vanishing while the assistant streams). Mirrors the `streamingBlocks` "no visual gap" pattern.

- **Store field** — `src/renderer/src/stores/chat.store.ts` — `pendingUserMessage: { content, baselineUserCount, attachments? } | null` (type `PendingUserMessage`). `baselineUserCount` snapshots how many persisted `role: 'user'` rows the chat already had at send time. `attachments?: MessageAttachment[]` carries the turn's already-ingested file attachments so the optimistic bubble shows its badges immediately.
- **Set on send** — `startRun` snapshots the cached chat’s persisted user count and stores the optimistic message only for the selected chat. Attachments are the resolved `MessageAttachment[]` passed to `window.api.run.start`; the new-chat flow resolves them before sending. No optimistic message is set when the chat already has a turn running (cached `activeRunId`, or this chat streaming): it would render above the live turn. See [Pending Messages tech](../pending_messages/pending_messages_tech.md#usechatstreamstartrun).
- **Rendered** — `src/renderer/src/components/chat/MessageStream.tsx` shows the optimistic bubble while `persistedUserCount <= baselineUserCount`, passing `attachments={pendingUserMessage.attachments ?? null}`. Without this the file badges only appeared once the persisted row refetched, lagging the bubble itself until the stream ended. **Count-keyed, not content-keyed** — repeating the previous turn's exact text still shows a bubble (content-keyed dedup hid the second of two identical consecutive messages until its own row refetched). The optimistic bubble's user-turn prop set is kept in lockstep with the persisted bubble (`addressedAgent*` passed `null` — no persisted addressed-agent yet).
- **Cleared** — `useLiveRunWatch` retires the matching optimistic message and live blocks only after a successful fresh terminal transcript read. Failure keeps them until recovery; profile/chat/projection-version and pending-object checks prevent a stale read from clearing a newer send. Idle attachment after fast completion and replay-unavailable closure use the same settlement. Selecting a different chat, or `reset`, also clears pending state; re-selecting the chat on screen does not. See [live-run settlement](live_runs.md#user-flow-and-rules).
- **Send re-entrancy** — `src/renderer/src/components/chat/ChatInput.tsx` acquires `composerDraft.store.beginSend(key)` before new-chat preparation or active-chat note materialization and releases it in `finally`. The watch starts streaming only once main begins the turn, so it cannot guard these earlier awaits. The lock survives navigation/remount of that draft and does not block other drafts.
- **Draft consumption** — `useChatComposer.submit` and `useNewChatFlow.startNewChat` report a boolean dispatch outcome. Missing chat cache or failed preparation returns false; active attachment-only sends are valid. Confirmed dispatch consumes only unchanged submitted fields in the source draft, not newer edits or another visible composer. Run completion remains separate. See [Draft ownership](../conversation_ui/conversation_ui_tech.md#draft-ownership).

The persisted user content equals the optimistic `content` verbatim (`prepareAgentSend` passes the payload `content` straight to `messageRepo.saveUser`), so the handoff is exact.

## Renderer Components

- `src/renderer/src/components/chat/MessageStream.tsx` — Renders the message list and owns the scroll container; bottom-following is delegated to `useStickToBottom` (see [Transcript Scrolling tech](../conversation_ui/scroll_following_tech.md)), which also renders the "Jump to latest" pill state
- `src/renderer/src/components/chat/MessageBubble.tsx` — Renders a single message with react-markdown + remark-gfm + rehype-highlight; info icon shows metadata popup on hover
- `src/renderer/src/components/chat/ToolCallBlock.tsx` — Animated collapsible block: provider badge shown first (accent-colored with Plug icon) followed by muted tool name; chevron rotates on expand; CSS grid `gridTemplateRows` animation (150ms); shimmer progress bar on top during pending state; structured JSON input/result view with MCP content block unwrapping
- `src/renderer/src/components/chat/ChatInput.tsx` — Input textarea; controls row below: [+] config on left, model/MCP center, send on right

## Cancellation

The run owner aborts the driver and bridge calls. Driver settlement preserves streamed partial text and reports canceled; real failures remain failed. Nested specialist calls receive combined root/wire abort signals and expose an independent child Stop address. Completion remains independent of the renderer watch; final persistence precedes terminal transcript settlement. See `src/main/services/conductorMcpServer.test.ts`, `src/main/agents/drivers/acp/acpDriver.test.ts` and the A2A cancellation goldens.
