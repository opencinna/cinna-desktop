# Chat Messaging

## Purpose

Full conversation management — creating chats, sending messages, streaming LLM responses in real-time, and executing tool calls through MCP servers. This is the core user-facing feature of Cinna.

## Core Concepts

- **Chat** — A persisted conversation bound to a specific LLM provider + model, with optional MCP servers enabled
- **Message** — A single turn in a conversation (roles: user, assistant, tool_call, error)
- **Streaming** — LLM responses arrive as incremental deltas via MessagePort, not as a single IPC response
- **Tool-call loop** — Centralized in the IPC handler (not in adapters). When the LLM emits tool calls, the IPC handler executes them via MCP and feeds results back to the LLM for continuation. Every message (assistant + tool_call) is saved to DB incrementally as it happens.

## User Stories / Flows

### New chat flow
1. User clicks "+ New Chat" or types in the default screen input
2. System creates a chat bound to the default LLM provider and its default model
3. First user message is sent; chat title is auto-set to the first message (truncated to 50 chars)
4. LLM response streams back in real-time with a bouncing-dots indicator

### Sending a message in an existing chat
1. User types in the input box and presses Send
2. Renderer creates a MessageChannel, sends port2 + payload to main via `postMessage`
3. Main saves user message to DB, loads full chat history, gathers MCP tools for the chat
4. IPC handler enters the tool-call loop (up to 10 rounds):
   - Calls the LLM adapter's `stream()` — adapter returns a `StreamResult` (content + tool calls)
   - Saves assistant message to DB (with `toolCalls` if any)
   - If no tool calls, loop ends
   - Otherwise, executes each tool call via MCP, saves each `tool_call` message to DB
   - Appends messages to history, continues the loop
5. Deltas stream back through the port: `request-id` -> `delta` -> `tool_use` -> `tool_result` -> `done`

### Tool-call flow
1. LLM adapter returns tool calls in the `StreamResult`
2. IPC handler notifies renderer via port (`tool_use` event with tool name, input, and MCP provider name)
3. Renderer immediately shows an animated tool call block: provider badge, shimmer progress bar, pending spinner
4. IPC handler calls `mcpManager.callTool()` with the tool name and input
5. Tool result (or error) is saved as a `tool_call` message in DB and sent back through the port
6. Tool results are appended to the message history and fed back to the LLM for continuation
7. On reload, the full tool-call history renders from DB — no data is lost

### Cancellation
1. User clicks cancel during streaming
2. Renderer calls `llm:cancel` IPC
3. Main process aborts the in-flight request via AbortSignal

## Business Rules

- Each chat is bound to exactly one LLM provider + model (set at creation, can be changed)
- A chat can have zero or more MCP servers enabled (junction table)
- Messages are ordered by `sort_order` within a chat
- Chat title defaults to the first user message, truncated to 50 chars
- The default provider is the one marked `is_default`; the default model is the provider's `default_model_id` (or first available)
- Streaming errors are parsed by the adapter's `parseError()` into user-friendly short + raw detail messages, then persisted to DB as `role: 'error'` messages so they survive navigation
- Tool calls are only available when MCP servers are connected and enabled for the chat

## Architecture Overview

```
User -> ChatInput (renderer) -> MessageChannel -> ipcMain.on('llm:send-message')
  -> Save user message to DB
  -> Load full chat history from DB
  -> Gather MCP tools for chat
  -> Tool-call loop (in IPC handler, up to 10 rounds):
     -> LLM Adapter .stream() -> returns StreamResult {content, toolCalls}
     -> Save assistant message to DB (with toolCalls)
     -> If toolCalls: execute via MCPManager.callTool()
        -> Save each tool_call message to DB
        -> Notify renderer via port (tool_use, tool_result/tool_error)
     -> Continue loop until no tool calls
  -> Stream deltas back via MessagePort throughout
```

## Integration Points

- [LLM Adapters](../../llm/adapters/adapters.md) — Each provider adapter handles the actual streaming and tool-use protocol
- [MCP Connections](../../mcp/connections/connections.md) — Tool aggregation and execution via MCPManager
- Database — Chats, messages, and chat-MCP junction persisted in SQLite
