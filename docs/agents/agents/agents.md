# Agents

## Purpose

Universal agent integration that lets users chat with external AI agents through standardized protocols. Currently supports A2A (Agent-to-Agent) Protocol with automatic version negotiation (SDK speaks v0.3, agents may advertise v1.0); the architecture is extensible for additional protocols in the future.

## Core Concepts

| Term | Definition |
|------|-----------|
| **Agent** | An external AI service registered by the user, identified by a protocol type and connection details |
| **Protocol** | The communication standard an agent uses (`a2a` for now); determines how discovery, auth, and messaging work |
| **Agent Card** | A2A discovery metadata fetched from a well-known URL — contains agent name, description, capabilities, skills, and endpoint |
| **Protocol Negotiation** | Process of matching our SDK's supported protocol version (0.3.x) with the agent's advertised versions; resolves the correct endpoint URL and version |
| **Supported Interface** | An entry in the agent card's `supportedInterfaces` array, pairing a URL with a protocol version and transport binding |
| **Skill** | A named capability advertised by an A2A agent (e.g. "Weather Lookup", "Code Review") |
| **Access Token** | Optional bearer token for authenticating with a secured agent; encrypted at rest via safeStorage |
| **A2A Session** | A persistent record linking a chat to an A2A agent's remote session — stores the server-assigned `contextId` and `taskId` for conversation continuity across messages |
| **Context ID** | Server-assigned identifier grouping related interactions into a single conversation context (A2A protocol concept) |
| **Task ID** | Server-assigned identifier for a task created by the agent in response to user messages; may change across interactions within the same context |
| **Message Part** | A typed segment of an assistant message — `kind: 'text' \| 'thinking' \| 'tool'`. A2A messages may stream multiple parts that get persisted as a structured `parts[]` list alongside the flat `content` fallback |
| **Content Kind** | A2A `TextPart.metadata['cinna.content_kind']` value (`text`, `thinking`, `tool`) that tells the client how to route/render the part. Cinna-backend convention — see [Streaming Pipeline](streaming_pipeline.md) |

## User Stories / Flows

### Adding an A2A Agent

1. User navigates to Settings > Agents
2. Clicks "Add A2A Agent"
3. Enters the agent's card URL (base URL or direct `.well-known/agent-card.json` path)
4. Optionally enters an access token for authenticated agents
5. Clicks "Test Connection" — app fetches the agent card, negotiates protocol, and displays:
   - Agent name and description
   - Agent version (the agent's own version)
   - Resolved protocol version and transport (e.g. "A2A v0.3.0 · JSONRPC"), plus all versions the agent supports
   - Resolved endpoint URL
   - Streaming support indicator
   - Number of skills and their names
6. Clicks "Save Agent" — agent is persisted with cached card metadata
7. Agent appears in the settings list and the chat agent selector

### Managing Agents

- **Enable/Disable** — Toggle controls agent visibility in the chat selector
- **Update Token** — Expand card, enter new token, save
- **Test Connection** — Re-fetches card, re-runs protocol negotiation, and updates cached metadata (skills, endpoint, protocol version, transport)
- **Delete** — Removes agent permanently

### Chatting with an Agent

There are two ways to select an agent for a new chat:

**Via Bot icon:**

1. On the new chat screen, user clicks the Bot icon button (next to the [+] chat mode button)
2. Dropdown shows all enabled agents with name, protocol badge, and description
3. User selects an agent (click again to deselect)

**Via @-mention shortcut:**

1. On the new chat screen, user types `@` at the start of input or after a space
2. A mention popup appears above the text input showing enabled agents with name and protocol tag
3. User can filter by typing after `@` (matches agent name or protocol)
4. User selects an agent via click, Enter, or Tab (Arrow keys navigate the list, Escape dismisses)
5. The `@...` token is removed from the input and the agent is selected

> The `@` shortcut is extensible — additional reference types beyond agents may be added in the future.

**After selection (either method):**

- The Bot icon button expands horizontally with an animation, showing the selected agent's name and a dismiss (X) button
- Only one agent can be selected at a time
- Clicking the X button deselects the agent (shrink animation) and returns focus to the text input
- User types a message and sends
- App creates a new chat, routes the message through the A2A protocol
- Response streams in real-time (if agent supports streaming) or arrives as a single response
- Both user and assistant messages are saved to the chat history
- An A2A session is created/updated after each exchange, storing the server's `contextId` and `taskId`

### Continuing an Agent Chat

1. User opens an existing agent chat — the controls row below the input shows a read-only agent badge (Bot icon + agent name) instead of the usual model/MCP selectors
2. User types a follow-up message
3. The system detects this is an agent chat by looking up the A2A session for this chat
4. The stored `contextId` and `taskId` are sent with the new message so the remote agent maintains conversation context
5. The agent responds within the same context — the session is updated with any new task/context IDs from the response

## Business Rules

- **Protocol version negotiation** — Our SDK speaks A2A v0.3.x. When connecting to an agent, the client fetches the raw card JSON and resolves protocol compatibility:
  1. If the card has a top-level `url` field → v0.3 compatible, use directly
  2. Otherwise, scan `supportedInterfaces` for an entry whose `protocolVersion` starts with `0.3` → use that entry's URL
  3. If neither found → error with a clear message listing what versions the agent supports
- **Protocol interface persistence** — The resolved `protocolInterfaceUrl` and `protocolInterfaceVersion` are stored on the agent record, avoiding re-negotiation on every message
- **Protocol extensibility** — The `protocol` field on agents is a discriminator; only `'a2a'` is handled today, but the schema and UI are designed for additional protocols
- **Network error translation** — When the A2A request fails at the socket/transport layer (server disconnect mid-response, refused, reset, DNS failure, timeout), the raw undici message (e.g. `TypeError: terminated`) is mapped to a short user-readable message shown in the chat error; the raw string is retained as `detail` for debugging
- **Agent selection is per-chat** — Selecting an agent applies only to the new chat being created; the agent binding is persisted on the chat (`agentId`) and in the `a2a_sessions` table so subsequent messages route through the agent automatically
- **Session continuity** — Each agent chat has an associated A2A session that stores the remote server's `contextId` and `taskId`. These are sent with every subsequent message so the remote agent maintains full conversation context. The session is created on the first successful message exchange and updated after each response.
- **Session lookup for routing** — When a user sends a message in an existing chat, the system looks up the `a2a_sessions` table. If a session exists, the message is routed through the A2A agent channel; otherwise it goes through the LLM channel. This is the source of truth for distinguishing agent chats from LLM chats.
- **Agent vs Chat Mode** — These are independent: user can select a chat mode OR an agent (or neither); when an agent is selected, the LLM provider/model from chat modes is bypassed
- **Single agent selection** — Only one agent can be active at a time; selecting a new agent replaces the previous selection
- **@-mention trigger** — The `@` character triggers the mention popup only when it appears at the start of input or immediately after whitespace; `@` inside a word (e.g. `email@`) does not trigger it
- **@-mention scope** — The mention popup is only active on the new chat screen (not inside existing chats); the feature is extensible for future reference types beyond agents
- **Agent chip animation** — Selection expands the Bot icon into a chip (expand-in 200ms); deselection plays a shrink animation (shrink-out 200ms) and then returns focus to the text input
- **Token security** — Access tokens never leave the main process; renderer only sees `hasAccessToken: boolean`
- **Card caching** — Agent card JSON is cached in the DB to avoid re-fetching on every operation; refreshed on "Test Connection"
- **Streaming detection** — The A2A client checks `card.capabilities.streaming` to decide between SSE streaming and single-response fallback
- **Per-part delta routing** — Each A2A `TextPart` can carry `metadata['cinna.content_kind']`; the client routes each fragment to a distinct rendering block (assistant text, thinking, tool narration). When metadata is absent, parts default to `text` — keeps backward compatibility with non-Cinna A2A servers. Full pipeline detailed in [Streaming Pipeline](streaming_pipeline.md)
- **Structured parts persisted** — Assistant messages from A2A agents store a `parts[]` JSON list on the message row in addition to the concatenated `content` text used for previews/search. Renderer prefers `parts[]` when present, falls back to `content` otherwise (LLM messages, legacy agent rows)
- **Cancellation** — In-flight agent requests can be cancelled via the same stop button used for LLM streaming
- **Bound agent badge** — When viewing an active agent chat, the controls row shows a read-only agent badge (Bot icon + agent name) styled like the AgentSelector's expanded state. The badge has no dismiss button and no dropdown — the agent is permanently bound to the session. Model and MCP selectors are hidden since they don't apply to agent chats

## Architecture Overview

```
Settings Flow:
  Sidebar → AgentsSettingsSection → AgentCard / A2AAgentForm
    → window.api.agents.* → IPC → agent.ipc.ts → DB + a2a-client.ts

Protocol Negotiation (on fetch-card / test):
  fetchRawCard(url) → raw JSON → resolveProtocol(card) → { url, version }
    → patch card.url for SDK → A2AClient(patchedCard)

Chat Flow — First Message (agent selection via Bot icon or @-mention):
  ChatInput (@-mention popup) ─┐
  AgentSelector (Bot icon)     ─┤→ selectedAgent → MainArea.handleNewChat()
                                └→ chat:create + chat:update(agentId)
                                └→ window.api.agents.sendMessage() → IPC (MessagePort)
                                   → agent_a2a.ipc.ts → createA2AClient() → External Agent
                                   → SSE events → StreamPartsAccumulator (per-part deltas, kind+toolName)
                                   → Deltas streamed back via MessagePort → chat.store → UI
                                   → a2a_sessions row created (contextId, taskId from response)
                                   → On done: messageRepo.saveAssistant({ content, parts })

Chat Flow — Subsequent Messages:
  ChatInput → useSendMessage() → agents.getSession(chatId)
    → session found → window.api.agents.sendMessage(session.agentId, ...)
      → agent_a2a.ipc.ts loads session → buildSendParams(content, contextId, taskId)
        → External Agent (receives conversation context)
        → a2a_sessions row updated with latest contextId/taskId
```

## Integration Points

- **Chat system** — Agent messages are saved to the same `messages` table as LLM messages, using the same `role` values (`user`, `assistant`). The chat row stores `agentId` for display/identification, while `a2a_sessions` stores the remote session state for protocol-level continuity
- **Streaming infrastructure** — Reuses the `MessagePort` streaming pattern from [Messaging](../../chat/messaging/messaging.md), including `chat.store` streaming state (`startStreaming`, `appendDelta`, `stopStreaming`). Agent deltas extend the protocol with `kind` and `toolName` fields — see [Streaming Pipeline](streaming_pipeline.md)
- **Conversation rendering** — `thinking` and `tool` parts render via dedicated collapsible blocks (`ThinkingBlock`, `ToolNarrationBlock`) — see [Conversation UI](../../chat/conversation_ui/conversation_ui.md)
- **Security** — Token encryption uses the same `encryptApiKey`/`decryptApiKey` from [safeStorage keystore](../../llm/adapters/adapters.md) as LLM API keys
- **Settings UI** — Follows the same card/form pattern as [LLM Provider settings](../../ui/settings/settings.md)
- **Sidebar navigation** — "Agents" tab appears between "Chats" and "LLM Providers" in the settings sidebar
