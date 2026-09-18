# Chat Messaging

## Purpose

Full conversation management — creating chats, sending messages, streaming LLM responses in real-time, and executing tool calls through MCP servers. This is the core user-facing feature of Cinna.

## Core Concepts

- **Chat** — A persisted conversation with a router, optional runtime/agent root and attached capabilities
- **Message** — A single turn in a conversation (roles: user, assistant, tool_call, error)
- **Streaming** — LLM responses arrive as incremental deltas via MessagePort, not as a single IPC response
- **Tool-call loop** — owned by the ACP runtime. Main serves attached tools and persists their results; SDK adapters are reserved for one-shot AI Functions.

## User Stories / Flows

### New chat flow
1. User clicks "+ New Chat" or types in the default screen input
2. System creates a chat using the selected agent/mode or the Default runtime
3. First user message is sent; chat title is auto-set to the first message (truncated to 50 chars)
4. LLM response streams back in real-time with a bouncing-dots indicator

### Sending a message in an existing chat
1. Renderer starts a main-owned run and watches its sequenced events independently.
2. Main resolves the router, binding a synthetic runtime for a rootless non-human chat, persists the user message and dispatches through the agent driver.
3. ACP resumes an existing session or creates one. Fresh sessions receive saved transcript/attachments; ongoing sessions receive the current prompt and applicable catch-up.
4. The runtime owns model iteration. Its Cinna bridge persists connector/specialist tool results and streams child events to the transcript.

### Sending while a turn runs
1. User sends a message while the chat's turn is still running
2. Main hands it to the running turn when that turn's engine takes mid-turn messages, the agent has started streaming the turn, no tool call is running, and the message is for its agent; otherwise main queues it. A queued message for that agent goes into the turn as soon as it can take one, and anything else waits for the turn to end
3. A completed turn drains the queue as a new turn; a stopped, failed or out-of-budget turn gives the queued text back to the composer. See [Pending Messages](../pending_messages/pending_messages.md)

### Tool calls and cancellation

The ACP runtime calls the authenticated Cinna MCP endpoint. Main resolves a trusted ToolProvider, publishes tool_use, executes it and persists tool_result/tool_error; specialist activity is framed as child events. Stop aborts the root and nested calls, keeping already streamed text through driver completion. One specialist can be stopped independently from its sub-thread. Steering remains unavailable while native or bridge tools are active.

See [Runtime orchestration](../orchestrated_agents/orchestrated_agents.md) for permissions, durable questions and tool budgets.

## Business Rules

- Sidebar rows show main-owned running activity across chat switches. Hover/focus offers **Interrupt session** while running; **Delete session** returns after execution stops. Background results persist until the matching conversation loads in the foreground; user cancellation has no unread icon. See [Sidebar Session Status](../session_status/session_status.md).
- Each send resolves one answering runtime/agent; human routing addresses one participant.
- A chat can have zero or more MCP servers enabled (junction table)
- Messages are ordered by `sort_order` within a chat
- Chat title defaults to the first user message, truncated to 50 chars
- The selected [chat mode](../chat_modes/chat_modes.md) supplies runtime overrides; a plain mode-less chat uses the Default runtime. Missing API credentials do not by themselves forbid a CLI-backed chat.
- Streaming errors are parsed by the adapter's `parseError()` into user-friendly short + raw detail messages, then persisted to DB as `role: 'error'` messages so they survive navigation
- A stop ends the turn and keeps what arrived: the reply so far is saved as an ordinary assistant message and the chat leaves its streaming state. The stop itself is never saved or shown as an error message — only a real failure is; the one error-flagged record a stop writes is the "not run" result of a tool call it skipped, which the next request needs. The renderer's Stop clears nothing itself, so a stop that posted no ending used to leave the chat stuck offering only Stop
- A running turn is not a reason to refuse a message: it is steered into that turn or queued behind it, text only. Files wait for a turn of their own. See [Pending Messages](../pending_messages/pending_messages.md)
- Tool calls are only available when MCP servers are connected and enabled for the chat
- The user's sent message renders instantly (an optimistic bubble) and stays visible without flicker through the entire streaming turn, swapping seamlessly to its persisted row once the chat refetches; sending the same text twice in a row still shows a distinct bubble for each turn (see the optimistic user-message lifecycle in `messaging_tech.md`)

## Architecture Overview

ChatInput → run:start / run:watch → run queue → shared routing and runtime binding → agent driver → session output and Cinna MCP tool calls → persisted messages + run events. The deleted adapter chat loop is not a fallback execution path.

## Integration Points

- [LLM Adapters](../../llm/adapters/adapters.md) — Each provider adapter handles the actual streaming and tool-use protocol
- [MCP Connections](../../mcp/connections/connections.md) — Tool aggregation and execution via MCPManager
- [Pending Messages](../pending_messages/pending_messages.md) — Messages sent while a turn runs: steered, queued, drained or handed back
- Database — Chats, messages, and chat-MCP junction persisted in SQLite
