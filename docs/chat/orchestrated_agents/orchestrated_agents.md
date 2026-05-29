# Orchestrated Agents (Agents-as-MCP)

> **Status:** implemented. This is the engine for any chat with more than one counterparty.

## Purpose

Let a single chat mix on-demand agents and on-demand MCP tools usefully. When more than one counterparty is in play (an LLM plus an agent, two agents, or an agent plus MCP tools), the local model becomes the **conductor**: it runs the conversation and calls each attached agent as if it were an MCP tool, unioned with the real MCP tools. A lone agent with no MCPs still talks directly over A2A, unchanged.

The routing decision is evaluated **dynamically**, not just at chat creation: bringing a second counterparty into a one-on-one chat (`@`-mentioning a second agent into a direct-A2A chat, or any agent into a plain LLM chat) **promotes** that chat to orchestrated on the spot.

## Core Concepts

- **Communication Pattern** — How a new chat will route, derived purely from the current selection:
  - **A2A** — exactly one agent and zero on-demand MCPs → the agent is bound as the chat root and talked to directly (full per-part streaming fidelity; current behavior, untouched).
  - **AI (orchestrated)** — anything else (LLM root + ≥1 agent, ≥2 agents, or agents mixed with MCPs) → the local model orchestrates, calling each agent/MCP as a tool. Zero agents → plain LLM chat (also "AI").
- **Orchestrated Mode** — An LLM-root chat (`chats.agent_id = null`) with a non-empty on-demand agent set. The local model drives the tool-call loop; each attached agent is exposed as one emulated MCP tool. Marked by `chats.orchestrated`, set at creation or at in-chat promotion and stable thereafter (removing every agent chip does not revert the chat to direct routing).
- **Promotion** — The in-chat transition from one counterparty to two. A direct-A2A chat's bound agent is moved into the on-demand agent set (so the orchestrator can still call it as a tool — its `a2a_sessions` row is preserved, so its prior context survives), `agent_id` is detached, a model is resolved (chat mode → default chat mode), and `orchestrated` flips true. A plain LLM chat just flips the flag (it already has a model). Refused when no LLM provider/chat mode is configured.
- **History handoff** — When a promoted chat's prior one-on-one turns (assistant rows carrying `source_agent_id`) are replayed into the orchestrator, each is prefixed with attribution (`[From the "<agent>" agent — available to you as the \`<tool>\` tool]`). This is what makes the orchestrator understand those earlier answers came from a specialist it can now re-delegate to, rather than treating them as its own words. A stateless, one-time reframe applied at history rebuild — nothing is persisted.
- **On-Demand Agent** — An agent the user `@-mentions` (or picks via the agent selector) into a chat so the orchestrator can call it. Mirrors [On-Demand MCP](../../mcp/on_demand/on_demand.md) exactly — separate table, sticky chips, one-shot announce.
- **Tool Provider** — A polymorphic tool source the orchestrator unions: an MCP provider (real MCP tools) or an agent provider (one emulated tool per agent). The orchestrator routes each tool call by provider type.
- **`cinna.mcp` Descriptor** — Optional backend-supplied shape describing how an agent should appear as a tool (tool name, description, input schema). When absent, the desktop synthesizes a minimal `{ message }` tool from the agent's name/description/example prompts.
- **Agent Sub-thread** — An agent-backed tool call rendered not as an opaque result string but as an expandable nested thread showing the agent's own work (thinking / tool / tool_result / text). This is what makes orchestrated mode *better* than a flat tool result rather than worse.
- **Dual Output** — Every agent turn yields two things: a **compact** result (final agent text) fed back to the orchestrator LLM, and the **full-fidelity** `parts[]` shown in the sub-thread. The rich parts never re-enter orchestrator context.
- **CommPattern Badge** — Indicator left of the chat-mode Cog on the new-chat composer showing `A2A` or `AI`, with a hover tooltip explaining the cost/behavior trade-offs.

## User Stories / Flows

### Talking to a single agent (A2A — unchanged)

1. User picks one agent (via the agent selector or `@`-mention) and attaches no MCPs.
2. The composer badge reads **A2A**.
3. User sends. The chat is created agent-rooted; the message streams directly to the agent over A2A with full per-part fidelity. No local model is involved.

### Mixing an agent with MCP tools (orchestrated)

1. User is on the new-chat screen with a default chat mode active (so a local model is available).
2. User `@`-mentions the "Email" agent and the "GitHub" MCP. Two chips appear below the composer; the badge flips to **AI**.
3. User types a task and sends.
4. A LLM-root chat is created; the agent is flushed onto `chat_on_demand_agents` and the MCP onto `chat_on_demand_mcps` before the first send.
5. The orchestrator (the chat-mode model) receives a tool set unioning the GitHub MCP tools and one `email` tool. It calls them as needed, in one loop.
6. The GitHub call renders as a normal tool block; the Email call renders as an expandable sub-thread that streams the agent's thinking/tool steps live.

### Two agents in one chat (orchestrated)

1. User picks two agents, no MCPs. Badge reads **AI**.
2. Both agents are exposed to the orchestrator as tools. The model decides which to call (or both) and composes their results.

### Promoting a one-on-one chat mid-conversation

1. User is in a direct-A2A chat with the "Email" agent and has a few turns of history — the agent has been the conversation's voice.
2. User `@`-mentions a second agent ("ERP"). The chat is promoted: Email moves into the on-demand agent set (keeping its A2A session), the chat detaches its root, a model is resolved from the chat mode (or default chat mode), and the composer flips from direct to orchestrated.
3. The next send goes to the orchestrator. Its rebuilt history shows the earlier Email turns prefixed with attribution, and Email + ERP are both available as tools — so it understands the prior exchange and can re-delegate to either.
4. If the user has no LLM provider or chat mode configured, promotion is refused with an explanatory error and the chat stays a direct one-on-one. (Single-agent direct A2A needs no local model; orchestration does.)

### Watching an agent work inside a tool call

1. During an orchestrated turn the model calls an agent tool.
2. That tool renders as a sub-thread headed by the agent's badge (with `· {n} steps · {status}` appended in verbose mode), auto-expanded while the agent streams, inset with a left border in the agent's color. Inside, consecutive thinking/tool/tool_result steps fold into expandable dots in compact mode; verbose shows every step inline.
3. The orchestrator-authored task message is shown as the first line ("the ask that went to the agent").
4. When the agent finishes, the sub-thread collapses to its header (unless verbose mode is on). The orchestrator receives only the agent's compact final text and continues.

### Managing capabilities mid-chat

1. User is in an active orchestrated chat. The attached agents and MCPs show as removable chips below the composer (alongside the on-demand-MCP chips).
2. To remove a capability, the user clicks the `×` on its chip — the agent/MCP detaches from the chat immediately and the next send no longer exposes it.
3. To add another agent, the user `@`-mentions it; it attaches as an on-demand agent (a new chip appears) and the next send unions it into the tool set.

### Continuity across turns

1. A follow-up message in an orchestrated chat re-invokes the same agent tool.
2. The desktop reuses the agent's own `a2a_sessions` row for that `(chat, agent)` pair, so the agent retains its context — the orchestrator never carries `context_id`.

## Business Rules

- **Routing decision** is `derivePattern(agentIds, mcpIds)`: one agent + zero on-demand MCPs → A2A; everything else → orchestrated/LLM. The badge and `startNewChat` share this single helper.
- **Orchestrated mode requires a local model.** A2A binds an agent and needs no model; orchestrated (and plain LLM) chats need a resolvable chat-mode provider + model, or the send is refused with an explanatory error.
- **The orchestrator LLM only ever passes `{ message }`** to an agent tool. `context_id` is deliberately omitted from the tool schema — continuity is the desktop's own concern via `a2a_sessions` per `(chat, agent)`.
- **Compact result back to the LLM; rich parts to the UI.** The tool result fed to the orchestrator each round is the agent's final text only. The full `parts[]` are persisted on the tool-call row and streamed to the sub-thread, but never re-fed into orchestrator context (avoids token blow-up and runaway recursion).
- **Tool naming.** LLM-facing tool name = a sanitized slug from the descriptor's `tool_name`/`display_name` or the agent name (`^[a-z0-9_-]+$`, ≤64 chars). Collisions (agent-vs-agent or agent-vs-MCP) get a stable id-derived suffix (e.g. `assistant_a3f`) — never a positional `_2`. The routing key (stable agent id) is never shown to the LLM.
- **On-demand agents mirror on-demand MCPs.** Sticky per-chat engagement (`chat_on_demand_agents`), one-shot announce prefix on the next send, removable chips, re-arm on re-add. The announce is combined with the MCP announce into one system note.
- **Handover depth.** An agent's own tool calls render as leaf blocks in the sub-thread. If an agent hands off to *another* agent server-side, that renders as a single labeled leaf — the desktop does not recurse into sub-sub-threads (v1).
- **Abort.** Aborting the orchestrator propagates an `AbortSignal` into the in-flight agent sub-turn, cancelling it.
- **Depth guard.** The orchestrator's tool-call loop is bounded (max rounds) so an agent tool that triggers server-side handovers can't loop the conductor unbounded.
- **The orchestrator is the only context-handoff mechanism.** It authors each agent's tool `message` (so every agent gets a self-contained prompt) and holds the full chat history, so no per-agent prompt-rewriting or transcript-replay machinery is needed. Per-agent continuity is `a2a_sessions`.
- **In-chat `@`-agent always adds a tool.** An `@`-agent pick attaches an on-demand agent. When the chat isn't yet orchestrated (direct-A2A or plain LLM), the pick promotes it first (see Promotion). Re-picking the sole bound agent of a direct-A2A chat is a no-op — it's already the conversation partner. A plain LLM chat is promoted in-chat the same way.
- **Abort cancels the remote agent.** Aborting an orchestrated turn aborts the orchestrator's `AbortController`, which both stops the in-flight agent sub-turn's stream *and* sends a `cancelTask` to the remote agent (so it doesn't keep running server-side).
- **Capability chips in active chats.** Attached agents and MCPs render as removable chips below the composer in active chats (DB-backed), mirroring on-demand MCP chips. Removing a chip detaches that capability from the chat immediately.
- **Sub-thread auto-expand.** The active sub-thread is expanded while streaming and collapses on completion; verbose mode keeps it expanded. Notices (agent startup pings) are excluded from the persisted/streamed sub-thread parts.
- **Sub-thread step grouping.** Inside an expanded sub-thread, runs of consecutive auxiliary steps (thinking / tool / tool_result) fold into a single expandable **dots group** in compact mode — the same `groupConsecutiveCollapsibles` treatment the main transcript uses — while the agent's text bubbles render inline between groups. Verbose mode renders every step inline. This keeps a multi-step agent turn from flooding the conductor's transcript.

## Architecture Overview

```
New-chat selection (MainArea)
  selectedAgent (agent selector) + pendingAgentIds (@-mentions) -> combinedAgentIds
  pendingMcpIds (@-mentions)
  derivePattern(combinedAgentIds, pendingMcpIds) -> A2A | AI  (CommPatternBadge)

Send -> useNewChatFlow.startNewChat(agentIds[], mcpIds[], onDemandMcpIds[])
  1 agent + 0 on-demand MCP -> bind agentId (root) -> startAgent (direct A2A)
  else -> LLM-root chat
            -> flush chat_on_demand_agents + chat_on_demand_mcps
            -> startLlm

In-chat @-agent (ChatInput.selectAgent)
  not orchestrated yet -> chat:promote-to-orchestrated
       (chatService.promoteToOrchestrated: resolve model, move root agent
        into chat_on_demand_agents, null agent_id, set orchestrated;
        refuse with not_configured when no model resolvable)
  -> chat:on-demand-agent-add
  composer.submit reads the (optimistically promoted) snapshot -> startLlm

llm:send-message -> chatStreamingService.stream
  history rebuild: assistant rows with source_agent_id (prior direct-A2A turns)
    -> prefixed with agent attribution so the orchestrator re-delegates
  -> build ToolProvider[]: McpToolProvider per connected MCP
       + A2AAsMcpProvider per on-demand agent (buildAgentToolProviders)
  -> union getTools() into tools[] + name->provider routing map
  -> tool-call loop:
       provider.callTool(name, input, { onEvent, signal })
         mcp   -> mcpManager.callTool (raw result)
         agent -> runAgentTurn(...) -> { text (compact), parts (rich) }
                    onEvent wraps each AgentStreamEvent as tool_subevent
       -> compact text back to LLM; parts persisted on tool_call row

Renderer
  tool_use(providerType:'agent') -> ToolCallBlock w/ subParts
  tool_subevent -> appendToolSubEvent accumulates MessagePart[]
  MessageStream -> AgentToolSubThread -> AgentContribution (parts render)
```

## Integration Points

- [Messaging](../messaging/messaging.md) — `chatStreamingService` is the orchestrator; it now unions MCP + agent tool providers and routes dispatch by provider type. The `LlmStreamEvent` union gains `tool_subevent`.
- [On-Demand MCP](../../mcp/on_demand/on_demand.md) — `chat_on_demand_agents` is a verbatim mirror; the announce prefix is combined across MCPs and agents. The promoted root agent is added as a pending-announce on-demand agent, so it is announced like any freshly attached agent.
- [Agents](../../agents/agents/agents.md) — Agent turns reuse the A2A client, endpoint/token resolution, and the `a2a_sessions` table via the port-free `runAgentTurn` core.
- [A2A Streaming Pipeline](../../agents/agents/streaming_pipeline.md) — The agent's rich `parts[]` (`cinna.content_kind`) stream over the same external A2A surface; orchestrated mode just stops collapsing them.
- [Remote Agents](../../agents/remote_agents/remote_agents.md) — The `cinna.mcp` descriptor is carried through the remote-agent sync into `agents.remote_metadata`.
- [Conversation UI](../conversation_ui/conversation_ui.md) — The sub-thread reuses the existing thinking / tool / tool_result / command_result blocks.
- [Chat Modes](../chat_modes/chat_modes.md) — Supplies the orchestrator's provider + model. No mode → orchestrated mode is unavailable.
