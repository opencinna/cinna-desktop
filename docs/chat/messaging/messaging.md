# Chat Messaging

## Purpose

Full conversation management — creating chats, sending messages, streaming LLM responses in real-time, and executing tool calls through MCP servers. This is the core user-facing feature of Cinna.

## Core Concepts

- **Chat** — A persisted conversation bound to a specific LLM provider + model, with optional MCP servers enabled
- **Message** — A single turn in a conversation (roles: user, assistant, tool_call, error)
- **Streaming** — LLM responses arrive as incremental deltas via MessagePort, not as a single IPC response
- **Tool-call loop** — Centralized in `chatStreamingService` (not in adapters). When the LLM emits tool calls, the service executes them via MCP and feeds results back to the LLM for continuation. Every message (assistant + tool_call) is saved to DB incrementally as it happens.

## User Stories / Flows

### New chat flow
1. User clicks "+ New Chat" or types in the default screen input
2. System creates a chat bound to the default LLM provider and its default model
3. First user message is sent; chat title is auto-set to the first message (truncated to 50 chars)
4. LLM response streams back in real-time with a bouncing-dots indicator

### Sending a message in an existing chat
1. User types in the input box and presses Send
2. Renderer invokes `run:start` with a typed `RunSendPayload`; its selected-chat watch independently receives output
3. Main resolves the chat router through the shared executor. The model path calls `messageRoutingService.prepareLlmSend()` (persists the user row + assembles `wireContent`), then hands off to `chatStreamingService.stream()`
4. The streaming service loads full chat history, patches the most recent user turn with `wireContent` (so the on-demand announce prefix is in scope for this call only, never persisted), and gathers MCP + agent tools for the chat
5. The service enters the tool-call loop (up to 10 rounds):
   - Calls the LLM adapter's `stream()` — adapter returns a `StreamResult` (content + tool calls)
   - Saves assistant message to DB (with `toolCalls` if any)
   - If no tool calls, loop ends
   - Otherwise, executes each tool call via MCP, saves each `tool_call` message to DB
   - Appends messages to history, continues the loop
6. Events stream back through the port in the one vocabulary every chat uses ([Stream Event Typing](../../development/stream_event_typing/stream_event_typing_llm.md)): `request-id` -> `delta` (kind `text`) -> `tool_use` -> `tool_result` -> `done`. An agent called as a tool streams its own work as `child` events

### Sending while a turn runs
1. User sends a message while the chat's turn is still running
2. Main hands it to the running turn when that turn's engine takes mid-turn messages and the message is for its agent; otherwise main queues it until the turn ends
3. A completed turn drains the queue as a new turn; a stopped, failed or out-of-budget turn gives the queued text back to the composer. See [Pending Messages](../pending_messages/pending_messages.md)

### Tool-call flow
1. LLM adapter returns tool calls in the `StreamResult`
2. `chatStreamingService` notifies renderer via port (`tool_use` event with tool name, input, and MCP provider name)
3. Renderer immediately shows an animated tool call block: provider badge, shimmer progress bar, pending spinner
4. `chatStreamingService` calls `mcpManager.callTool()` with the tool name and input
5. Tool result (or error) is saved as a `tool_call` message in DB and sent back through the port
6. Tool results are appended to the message history and fed back to the LLM for continuation
7. On reload, the full tool-call history renders from DB — no data is lost

### Cancellation
1. User clicks Stop during streaming
2. Renderer calls owned `run:cancel-chat`, including before the transport request ID exists
3. Main process aborts the in-flight request via AbortSignal; an agent sub-turn in flight is cancelled with it
4. Between adapter calls (for example while a tool runs), the loop stops and the turn ends normally. Tool calls in that round that had not run yet are recorded as not run, because a provider refuses a history with an unanswered tool call
5. Mid-reply — the usual case — the adapter rejects, and the text streamed so far in that round is saved as an ordinary assistant message, unless it is only whitespace
6. Either way `done` is posted with `stopReason: 'canceled'`: the chat leaves its streaming state, the partial reply stays in the transcript, and a job run is recorded as cancelled. See [Cancellation](messaging_tech.md#cancellation)

## Business Rules

- Sidebar rows show main-owned running activity across chat switches. Hover/focus offers **Interrupt session** while running; **Delete session** returns after execution stops. Background results persist until the matching conversation loads in the foreground; user cancellation has no unread icon. See [Sidebar Session Status](../session_status/session_status.md).
- Each chat is bound to exactly one LLM provider + model (set at creation, can be changed)
- A chat can have zero or more MCP servers enabled (junction table)
- Messages are ordered by `sort_order` within a chat
- Chat title defaults to the first user message, truncated to 50 chars
- The provider/model for a new chat comes from the active [chat mode](../chat_modes/chat_modes.md) (auto-applied default mode if the user hasn't picked one explicitly); the model defaults to the mode's `modelId`, falling back to the provider's `default_model_id` and finally the first available model. There is no provider-level "default" flag — if no mode or agent is chosen, sending raises an inline "can't determine destination" error
- Streaming errors are parsed by the adapter's `parseError()` into user-friendly short + raw detail messages, then persisted to DB as `role: 'error'` messages so they survive navigation
- A stop ends the turn and keeps what arrived: the reply so far is saved as an ordinary assistant message and the chat leaves its streaming state. The stop itself is never saved or shown as an error message — only a real failure is; the one error-flagged record a stop writes is the "not run" result of a tool call it skipped, which the next request needs. The renderer's Stop clears nothing itself, so a stop that posted no ending used to leave the chat stuck offering only Stop
- A running turn is not a reason to refuse a message: it is steered into that turn or queued behind it, text only. Files wait for a turn of their own. See [Pending Messages](../pending_messages/pending_messages.md)
- Tool calls are only available when MCP servers are connected and enabled for the chat
- The user's sent message renders instantly (an optimistic bubble) and stays visible without flicker through the entire streaming turn, swapping seamlessly to its persisted row once the chat refetches; sending the same text twice in a row still shows a distinct bubble for each turn (see the optimistic user-message lifecycle in `messaging_tech.md`)

## Architecture Overview

```
User -> ChatInput (renderer) -> useChatStream.startRun()
  -> run:start command (RunSendPayload); independent run:watch MessagePort
  -> runQueueService: start a turn, or — with one running — steer into it or queue behind it
  -> main resolves who answers from chats.router  (see docs/chat/chat_routing/)
     -> { kind: 'agent' } : the driver path
     -> { kind: 'model' } : below
  -> messageRoutingService.prepareLlmSend({ userId, chatId, userContent })
     -> chatRepo.getOwned() (verify ownership)
     -> messageRepo.saveUser()
     -> returns { wireContent }
  -> chatStreamingService.stream({ userId, chatId, wireContent, port })
     -> chatRepo.getOwned() (verify provider config) + chatMcpRepo.listProviderIds() + mcpManager.getToolsForProviders()
     -> Patch the latest user turn in the rebuilt history with wireContent
     -> Tool-call loop (up to 10 rounds):
        -> LLM Adapter .stream() -> returns StreamResult {content, toolCalls}
        -> messageRepo.saveAssistant() (with toolCalls)
        -> If toolCalls: mcpManager.callTool() per call
           -> messageRepo.saveToolCall()
           -> Notify renderer via port (tool_use, tool_result/tool_error)
        -> Continue loop until no tool calls
     -> Stream deltas back via MessagePort throughout
```

## Main-owned Continuations

The shared executor owns a turn after dispatch, even if its renderer port closes. An Inbox next-message answer runs through the same routing/persistence/driver path without opening a conversation. Task Continue creates a new direct chat and dispatches its goal/handoff prompt once in main, then navigates after acceptance. Acceptance saves the user message and settles its agent’s pending requests in one transaction; a refusal rolls back both. Later stream completion is a separate event. Opening the conversation attaches to its current run, replays retained output once and receives new events; switching away leaves execution running. A bounded replay cache and baseline message IDs prevent duplicated tool rounds, with saved-message polling when replay is unavailable. Stop works before the transport request ID exists. Closure retires the live projection only after a fresh saved read. See [Live Run Attachment and Replay](live_runs.md). Each ending also supplies a [typed turn outcome](turn_completion.md); a model that reaches its ten-round ceiling records a budget error instead of success. Explicit runner ownership can defer the whole-task decision, but automatic task loops remain separate. See [execution details](../chat_routing/chat_routing_tech.md#shared-turn-lifetime-and-acceptance).

## Integration Points

- [LLM Adapters](../../llm/adapters/adapters.md) — Each provider adapter handles the actual streaming and tool-use protocol
- [MCP Connections](../../mcp/connections/connections.md) — Tool aggregation and execution via MCPManager
- [Pending Messages](../pending_messages/pending_messages.md) — Messages sent while a turn runs: steered, queued, drained or handed back
- Database — Chats, messages, and chat-MCP junction persisted in SQLite
