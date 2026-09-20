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
| **Message Part** | A typed segment of an assistant message — `kind: 'text' \| 'thinking' \| 'tool' \| 'tool_result' \| 'command_result'`. A2A messages may stream multiple parts that get persisted as a structured `parts[]` list alongside the flat `content` fallback. (The sibling `'notice'` kind never joins `parts[]` — see [Agent Notices](../../chat/agent_notices/agent_notices.md).) |
| **Content Kind** | A2A `TextPart.metadata['cinna.content_kind']` value (`text`, `thinking`, `tool`, `tool_result`, `notice`, `command_result`) that tells the client how to route/render the part. Cinna-backend convention — see [Streaming Pipeline](streaming_pipeline.md) |

## User Stories / Flows

### Adding an A2A Agent

1. User opens the Agents sidebar and presses **+** to open **Add an agent**
2. Chooses **Advanced options**, then **A2A agent**, opening the **Add A2A Agent** dialog
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
7. On success the dialog closes and the agent appears in the sidebar and chat picker. Failed saves keep the dialog and entered values; dismissal and input edits are blocked while saving.

### Managing Agents

- **Open agent** — Select its sidebar row to open a composer bound to the agent. **Settings** reveals Overview and Connection; **Start chat** returns to the composer without creating an empty conversation. Switching modes keeps the current draft mounted.
- **Overview** — Description, readiness and advertised skills.
- **Update Token** — Open **Settings → Connection → Authentication**, enter a replacement token and save. Connection details and Connection test are separate visible sections.
- **Test Connection** — Re-fetches card, re-runs protocol negotiation, and updates cached metadata (skills, endpoint, protocol version, transport). The same press re-asks the agent's readiness, so the page readiness and the composer follow the test just run
- **Readiness** — Sidebar rows and page headers use type icons without status dots. Overview names readiness, and Connection test shows a refusal beside Test Connection with the raw error as its tooltip. **A failed test does not replace it**: the test's own error ("fetch failed") said less than the reason and explained nothing. Only a passing test shows *Connected* in its place, since the re-check the same press started clears the reason moments later. A failed test's error is shown only when readiness has nothing to say. A healthy card shows no line at all. The composer refuses a direct send to a refused agent — see [Agent Drivers & Readiness](../drivers/drivers.md)
- **Delete agent** — The header **More actions** menu asks before removing the Desktop connection, and offers this only for a connection this app owns. Existing chats and the remote server/workspace remain; those chats can no longer reach this binding. Failure keeps the confirmation open with its error; pending deletion blocks dismissal.
- **Visibility** — Enabled direct connections have no Disable action. Previously disabled direct connections remain reachable in the sidebar and get an enable-only recovery action. Cinna-synced visibility follows [Remote Agents](../remote_agents/remote_agents.md), whose ⋯ menu deletes nothing that lives on a server and links to the agent's page there instead.

### Chatting with an Agent

Open the agent from the Agents sidebar for its chat landing page, or use its hover **Start chat** shortcut to open the new-chat screen with that agent selected. The shortcut does not also activate the row. Chat selection also works through the [composer menu](../../chat/composer_menu/composer_menu.md) and @-mentions.

**Via composer menu:**

1. On the new chat screen, open **[+] → Add agents**
2. The capability picker lists available agents
3. User selects the agent for the conversation

**Via @-mention shortcut:**

1. On the new chat screen, user types `@` at the start of input or after a space
2. A mention popup appears above the text input showing enabled agents with name and protocol tag
3. User can filter by typing after `@` (matches agent name or protocol)
4. User selects an agent via click, Enter, or Tab (Arrow keys navigate the list, Escape dismisses)
5. The `@...` token is removed from the input and the agent is selected

The same capability gesture can attach an agent to an existing chat; the shared routing flow determines any required router change.

**After selection:**

- The composer keeps an ordered set of agents; selecting one from its landing page seeds that set with the page's agent. Picks appear in the composer capability strip and can be removed before sending.
- A single selected agent uses direct routing. Multiple agents and attached capabilities follow [Chat Routing](../../chat/chat_routing/chat_routing.md); there is no single-agent-only selection rule.
- Sending creates the chat and starts a main-owned run. Merely selecting an agent or returning from Settings creates no empty conversation.
- A2A responses stream when supported, otherwise arrive as a single response. Messages are saved in the shared history and the A2A driver saves remote context/task IDs for continuity.

### Continuing an Agent Chat

1. User opens an existing agent chat — the controls row below the input shows a read-only agent badge (Bot icon + agent name) instead of the usual model/MCP selectors
2. User types a follow-up message
3. Main resolves the answerer from the persisted chat router; the A2A driver then loads its protocol session
4. The stored `contextId` and `taskId` are sent with the new message so the remote agent maintains conversation context
5. The agent responds within the same context — the session is updated with any new task/context IDs from the response
6. If the app is quit or killed before the reply finishes, the next launch collects the reply from the agent, or says the app closed before it finished. See [Interrupted Turn Recovery](../turn_recovery/turn_recovery.md)

## Business Rules

- **Protocol version negotiation** — Our SDK speaks A2A v0.3.x. When connecting to an agent, the client fetches the raw card JSON and resolves protocol compatibility:
  1. If the card has a top-level `url` field → v0.3 compatible, use directly
  2. Otherwise, scan `supportedInterfaces` for an entry whose `protocolVersion` starts with `0.3` → use that entry's URL
  3. If neither found → error with a clear message listing what versions the agent supports
- **Protocol interface persistence** — The resolved `protocolInterfaceUrl` and `protocolInterfaceVersion` are stored on the agent record, avoiding re-negotiation on every message
- **Protocol extensibility** — The `protocol` field on agents is a discriminator; only `'a2a'` is handled today, but the schema and UI are designed for additional protocols
- **Network error translation** — When the A2A request fails at the socket/transport layer (server disconnect mid-response, refused, reset, DNS failure, timeout), the raw undici message (e.g. `TypeError: terminated`) is mapped to a short user-readable message shown in the chat error; the raw string is retained as `detail` for debugging
- **Agent selection is per-chat** — Selecting an agent applies only to the new chat being created; the agent binding is persisted on the chat (`agentId`) and in the `a2a_sessions` table so subsequent messages route through the agent automatically
- **Session continuity** — Each agent chat has an associated A2A session that stores the remote server's `contextId` and `taskId`. These are sent with every subsequent message so the remote agent maintains full conversation context. The session row is written from the first stream event that carries a task id and updated again when the turn ends. On Cinna the task id is the session, so saving it only at the end meant that a first turn that was stopped, dropped or killed left no session, and the next message started a new conversation. A turn that fails or is stopped skips the end-of-turn update and keeps the ids its first event saved.
- **The user row's id is the A2A `messageId`** — the Cinna backend echoes it in `tasks/get` history, which is how an interrupted or dropped turn is found there, and deduplicates a resend by it. A runner-originated send stores a system row and sends a fresh id instead.
- **Routing and protocol sessions are separate** — Main routes from `chats.router`; A2A session rows hold remote conversation checkpoints, not the choice between an agent and a model. See [Chat Routing](../../chat/chat_routing/chat_routing.md).
- **Agent and chat mode** — A direct A2A turn uses the agent's own execution; model-coordinated chats may also use the configured model and capabilities. Multiple selected agents follow the shared routing rules.
- **@-mention trigger** — The `@` character triggers the mention popup only when it appears at the start of input or immediately after whitespace; `@` inside a word (e.g. `email@`) does not trigger it
- **@-mention scope** — New-chat picks enter the pending capability set. Existing-chat agent picks use the shared attach-agent flow and may change routing; MCP picks use on-demand MCP.
- **Token security** — Access tokens never leave the main process; renderer only sees `hasAccessToken: boolean`
- **Card caching** — Agent card JSON is cached in the DB to avoid re-fetching on every operation; refreshed on "Test Connection"
- **Streaming detection** — The A2A client checks `card.capabilities.streaming` to decide between SSE streaming and single-response fallback
- **Per-part delta routing** — Each A2A `TextPart` can carry `metadata['cinna.content_kind']`; the client routes each fragment to a distinct rendering block (assistant text, thinking, tool narration). When metadata is absent, parts default to `text` — keeps backward compatibility with non-Cinna A2A servers. Full pipeline detailed in [Streaming Pipeline](streaming_pipeline.md)
- **Structured parts persisted** — Assistant messages from A2A agents store a `parts[]` JSON list on the message row in addition to the concatenated `content` text used for previews/search. Renderer prefers `parts[]` when present, falls back to `content` otherwise (LLM messages, legacy agent rows)
- **Cancellation** — In-flight agent requests can be cancelled via the same stop button used for LLM streaming
- **Bound agent badge** — When viewing an active agent chat, the controls row shows a read-only agent badge (Bot icon + agent name) alongside the routing/location controls. The badge has no dismiss button and no dropdown — the badge itself does not edit the binding. Participant and routing changes belong to the capability controls

## Architecture Overview

```
Settings Flow:
  Sidebar + → NewLocalAgentModal → A2AAgentForm
  Sidebar row → ExternalAgentPage → Settings → AgentCard(connectionOnly)
    → window.api.agents.* → IPC → agent.ipc.ts → DB + a2a-client.ts

Protocol Negotiation (on fetch-card / test):
  fetchRawCard(url) → raw JSON → resolveProtocol(card) → { url, version }
    → patch card.url for SDK → A2AClient(patchedCard)

Chat Flow — First Message (agent page, capability picker or @-mention):
  ChatInput (@-mention popup) ─┐
  Composer capability picker     ─┤→ selectedAgent → ChatWorkspace → useNewChatFlow.startNewChat()
                                └→ chat:create + chat:update(agentId)
                                └→ run.start → main executor → run.watch (MessagePort)
                                   → agent_a2a.ipc.ts → createA2AClient() → External Agent
                                   → SSE events → StreamPartsAccumulator (per-part deltas, kind+toolName)
                                   → Deltas streamed back via MessagePort → chat.store → UI
                                   → a2a_sessions row created at the first event with a task id
                                   → On done: messageRepo.saveAssistant({ content, parts })

Chat Flow — Subsequent Messages:
  ChatInput → useChatStream.startRun() → window.api.run.send(chatId, ...)
    → main reads chats.router → the bound agent answers
      → the driver loads the a2a_sessions row → buildSendParams(content, contextId, taskId)
        → External Agent (receives conversation context)
        → a2a_sessions row updated with latest contextId/taskId (first task event, then turn end)
```

## Integration Points

- **Chat system** — Agent messages are saved to the same `messages` table as LLM messages, using the same `role` values (`user`, `assistant`). The chat row stores `agentId` for display/identification, while `a2a_sessions` stores the remote session state for protocol-level continuity
- **Streaming infrastructure** — Reuses the `MessagePort` streaming pattern from [Messaging](../../chat/messaging/messaging.md), including `chat.store` streaming state (`startStreaming`, `appendDelta`, `stopStreaming`). Agent deltas extend the protocol with `kind` and `toolName` fields — see [Streaming Pipeline](streaming_pipeline.md)
- **Conversation rendering** — `thinking` and `tool` parts render via dedicated collapsible blocks (`ThinkingBlock`, `ToolNarrationBlock`) — see [Conversation UI](../../chat/conversation_ui/conversation_ui.md)
- **Security** — Token encryption uses the same `encryptApiKey`/`decryptApiKey` from [safeStorage keystore](../../llm/adapters/adapters.md) as LLM API keys
- **Settings UI** — [Settings](../../ui/settings/settings.md) separates installation-wide **Default → Agents** configuration from the active server visibility list in **Profile → Agents**. Direct A2A connection configuration belongs to its agent page.
- **Other agent kinds** — ACP and Managed agents share the chat landing page and Overview/Connection tabs; Connection opens their existing configuration dialogs.
