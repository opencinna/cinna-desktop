# Orchestrated Agents (Agents-as-MCP)

> **Status:** implemented. This is what the **`coordinator`** router does — one of the three values documented in [Chat Routing](../chat_routing/chat_routing.md), which is where the decision to *use* it is made.

## Purpose

Let a single chat mix agents and MCP tools usefully, with the local model as the **conductor**: it runs the conversation and calls each attached agent as if it were an MCP tool, unioned with the real MCP tools.

**This doc covers what happens once a chat is coordinated, not when it should be.** Who answers a message in a chat is `chats.router`, and a coordinated chat is one of three shapes it can be — the others are one agent answering directly (`direct`) and several agents the user addresses one at a time with no model between them (`human`). See [Chat Routing](../chat_routing/chat_routing.md) for the rule, the transitions and the badge.

A chat arrives here two ways: created that way (any agent mixed with an MCP server, or the composer's explicit "Let the model coordinate"), or moved here later by the same toggle. It is the one router transition that needs a model, so it is the only one that can be refused.

## Autonomous Execution

The composer’s **Run on its own…** action explicitly starts a [task runner](../../jobs/tasks/autonomous_tasks.md). Its coordinator receives fixed delegate/handoff/ask_user/update_task/finish tools instead of the ordinary synthesized per-agent tool set, alongside MCP tools. Ordinary coordination remains the one-turn behavior documented below; enabling the router alone never starts the autonomous loop.

## Core Concepts

- **Coordinated chat** — an LLM-root chat (`chats.agent_id = null`) whose attached agents are exposed to the local model as emulated MCP tools. `chats.router = 'coordinator'`. It is stable: removing every agent chip does not silently re-route the chat, and the way back off it is the composer's coordinate toggle.
- **Handing a chat over** — moving to `coordinator` re-exposes a `direct` chat's bound agent as an on-demand agent (so the conductor can still call it — its `a2a_sessions` row is preserved, so its prior context survives), detaches `agent_id`, and resolves a model (chat mode → default chat mode). Refused with `not_configured` when no LLM provider or chat mode is available. Handled by `chatService.setRouter`; see [Chat Routing](../chat_routing/chat_routing.md).
- **History handoff** — When a handed-over chat's prior one-on-one turns (assistant rows carrying `source_agent_id`) are replayed into the orchestrator, each is prefixed with attribution (`[From the "<agent>" agent — available to you as the \`<tool>\` tool]`). This is what makes the orchestrator understand those earlier answers came from a specialist it can now re-delegate to, rather than treating them as its own words. A stateless, one-time reframe applied at history rebuild — nothing is persisted.
- **On-Demand Agent** — An agent the user `@-mentions` (or picks via the agent selector) into a chat. In a coordinated chat it is a tool the conductor can call; in a `human` chat it is one of the counterparties the user addresses. Mirrors [On-Demand MCP](../../mcp/on_demand/on_demand.md) exactly — separate table, sticky chips, one-shot announce.
- **Tool Provider** — A polymorphic tool source the orchestrator unions: an MCP provider (real MCP tools) or an agent provider (one emulated tool per agent). The orchestrator routes each tool call by provider type.
- **`cinna.mcp` Descriptor** — Optional backend-supplied shape describing how an agent should appear as a tool (tool name, description, input schema). When absent, the desktop synthesizes a minimal `{ message }` tool from the agent's name/description/example prompts.
- **Agent Sub-thread** — An agent-backed tool call rendered not as an opaque result string but as an expandable nested thread showing the agent's own work (thinking / tool / tool_result / text). This is what makes orchestrated mode *better* than a flat tool result rather than worse.
- **Dual Output** — Every agent turn yields two things: a **compact** result (final agent text) fed back to the orchestrator LLM, and the **full-fidelity** `parts[]` shown in the sub-thread. The rich parts never re-enter orchestrator context.
- **Router Badge** — the pill left of Send, which reads **Model routes** for a coordinated chat and names the model in its tooltip along with what it costs (local-model tokens every turn *plus* each agent invocation, tool schemas in context, higher latency, and an agent's live stream summarized into one tool result). See [Chat Routing](../chat_routing/chat_routing.md).

## User Stories / Flows

### Mixing an agent with MCP tools

1. User is on the new-chat screen with a default chat mode active (so a local model is available).
2. User `@`-mentions the "Email" agent and the "GitHub" MCP. Two chips appear below the composer; the badge flips to **Model routes** — an agent mixed with an MCP server needs a conductor, because the servers are the *model's* tools and an agent cannot call them.
3. User types a task and sends.
4. An LLM-root chat is created; the agent is flushed onto `chat_on_demand_agents` and the MCP onto `chat_on_demand_mcps` before the first send.
5. The conductor (the chat-mode model) receives a tool set unioning the GitHub MCP tools and one `email` tool. It calls them as needed, in one loop.
6. The GitHub call renders as a normal tool block; the Email call renders as an expandable sub-thread that streams the agent's thinking/tool steps live.

### Handing a running chat to the model

1. User is in a chat with the "Email" agent and has a few turns of history — the agent has been the conversation's voice.
2. User ticks **Let the model coordinate** in the composer's `[+]` menu. Email moves into the on-demand agent set (keeping its A2A session), the chat detaches its root, and a model is resolved from the chat mode (or default chat mode).
3. The next send goes to the conductor. Its rebuilt history shows the earlier Email turns prefixed with attribution, and every attached agent is available as a tool — so it understands the prior exchange and can re-delegate.
4. If the user has no LLM provider or chat mode configured, the switch is refused with an explanatory error and the chat stays where it was. **This is the only router transition that needs a model**, and therefore the only one that can be refused; bringing a second agent into a chat does not go through here at all.
5. Unticking the toggle hands the chat back: to `human` if agents remain, to `direct` if none do.

### Watching an agent work inside a tool call

1. During a coordinated turn the model calls an agent tool.
2. That tool renders as a sub-thread headed by the agent's badge (with `· {n} steps · {status}` appended in verbose mode), auto-expanded while the agent streams, inset with a left border in the agent's color. Inside, consecutive tool/tool_result steps fold into expandable dots in compact mode, with the agent's thinking open between them; verbose shows every step inline.
3. The orchestrator-authored task message is shown as the first line ("the ask that went to the agent").
4. When the agent finishes, the sub-thread collapses to its header (unless verbose mode is on). The orchestrator receives only the agent's compact final text and continues.

### Managing capabilities mid-chat

1. User is in an active coordinated chat. The attached agents and MCPs show as removable chips below the composer (alongside the on-demand-MCP chips).
2. To remove a capability, the user clicks the `×` on its chip — the agent/MCP detaches from the chat immediately and the next send no longer exposes it.
3. To add another agent, the user `@`-mentions it; it attaches as an on-demand agent (a new chip appears) and the next send unions it into the tool set.

### Continuity across turns

1. A follow-up message in a coordinated chat re-invokes the same agent tool.
2. The desktop reuses the agent's own `a2a_sessions` row for that `(chat, agent)` pair, so the agent retains its context — the orchestrator never carries `context_id`.

## Business Rules

- **Which chats end up here is not decided in this feature.** `newChatRouter` and `chats.router` decide it, in `src/shared/chatRouting.ts` — see [Chat Routing](../chat_routing/chat_routing.md). What matters here: a chat is coordinated when an agent is mixed with an MCP server, or when the user asks the model to conduct.
- **A coordinated chat requires a local model**, and it is the only router that does. It needs a resolvable chat-mode provider + model, or the switch (and the send) is refused with an explanatory error naming the way out.
- **The orchestrator LLM only ever passes `{ message }`** to an agent tool. `context_id` is deliberately omitted from the tool schema — continuity is the desktop's own concern via `a2a_sessions` per `(chat, agent)`.
- **Compact result back to the LLM; rich parts to the UI.** The tool result fed to the orchestrator each round is the agent's final text only. The full `parts[]` are persisted on the tool-call row and streamed to the sub-thread, but never re-fed into orchestrator context (avoids token blow-up and runaway recursion).
- **Tool naming.** LLM-facing tool name = a sanitized slug from the descriptor's `tool_name`/`display_name` or the agent name (`^[a-z0-9_-]+$`, ≤64 chars). Collisions (agent-vs-agent or agent-vs-MCP) get a stable id-derived suffix (e.g. `assistant_a3f`) — never a positional `_2`. The routing key (stable agent id) is never shown to the LLM.
- **On-demand agents mirror on-demand MCPs.** Sticky per-chat engagement (`chat_on_demand_agents`), one-shot announce prefix on the next send, removable chips, re-arm on re-add. The announce is combined with the MCP announce into one system note.
- **Handover depth.** An agent's own tool calls render as leaf blocks in the sub-thread. If an agent hands off to *another* agent server-side, that renders as a single labeled leaf — the desktop does not recurse into sub-sub-threads (v1).
- **A nested agent's ask cannot be answered yet.** A folder agent called as a tool may stop to ask permission or a question. The ask reaches the renderer and is recorded against its tool call, and the registry would accept an answer by id — but no sub-thread renders a control for it, so it waits out its park timeout and is rejected.
- **Abort.** Aborting the orchestrator propagates an `AbortSignal` into the in-flight agent sub-turn, cancelling it.
- **Depth guard.** The orchestrator's tool-call loop is bounded (max rounds) so an agent tool that triggers server-side handovers can't loop the conductor unbounded.
- **The orchestrator is the only context-handoff mechanism.** It authors each agent's tool `message` (so every agent gets a self-contained prompt) and holds the full chat history, so no per-agent prompt-rewriting or transcript-replay machinery is needed. Per-agent continuity is `a2a_sessions`.
- **In-chat `@`-agent does not always add a tool.** An `@`-agent pick attaches an on-demand agent, but what that *means* now depends on the chat: a plain LLM chat becomes coordinated (the model is the counterparty already, and an arriving agent is a tool it can call, not a replacement for it), while a chat with an agent in it becomes `human` and the pick addresses that agent instead. Re-picking the sole bound agent of a `direct` chat is still a no-op — it is already the conversation partner. See [Chat Routing](../chat_routing/chat_routing.md).
- **Abort cancels the remote agent.** Aborting an orchestrated turn aborts the orchestrator's `AbortController`, which both stops the in-flight agent sub-turn's stream *and* sends a `cancelTask` to the remote agent (so it doesn't keep running server-side).
- **Capability chips in active chats.** Attached agents and MCPs render as removable chips below the composer in active chats (DB-backed), mirroring on-demand MCP chips. Removing a chip detaches that capability from the chat immediately.
- **Sub-thread auto-expand.** The active sub-thread is expanded while streaming and collapses on completion; verbose mode keeps it expanded. Notices (agent startup pings) are excluded from the persisted/streamed sub-thread parts. These automatic opens and closes are not the user's, so the transcript's **Collapse expanded** never counts them.
- **Sub-thread step grouping.** Inside an expanded sub-thread, runs of consecutive tool steps (tool / tool_result / Cinna CLI) fold into a single expandable **dots group** in compact mode — the same `groupConsecutiveCollapsibles` treatment the main transcript uses — while the agent's text bubbles and its thinking, open by default, render inline between groups. Verbose mode renders every step inline. This keeps a multi-step agent turn from flooding the conductor's transcript.

## Architecture Overview

```
How a chat becomes coordinated -> see docs/chat/chat_routing/
  new chat : newChatRouter(agentIds, mcpIds) -> 'coordinator' when an agent
             meets an MCP server (or the explicit toggle)
  active   : [+] "Let the model coordinate" -> chat:set-router 'coordinator'
             (chatService.setRouter: resolve a model, move the root agent into
              chat_on_demand_agents, null agent_id; refuse not_configured when
              no model is resolvable)
             a @-agent pick in a plain LLM chat lands here too

run:send (main resolves the answerer as { kind: 'model' })
  -> chatStreamingService.stream
  history rebuild: assistant rows with source_agent_id (prior direct-A2A turns)
    -> prefixed with agent attribution so the orchestrator re-delegates
  -> build ToolProvider[]: McpToolProvider per connected MCP
       + A2AAsMcpProvider per on-demand agent (buildAgentToolProviders)
  -> union getTools() into tools[] + name->provider routing map
  -> tool-call loop:
       provider.callTool(name, input, { onEvent, signal })
         mcp   -> mcpManager.callTool (raw result)
         agent -> runAgentTurn(...) -> { text (compact), parts (rich) }
                    onEvent wraps each RunEvent of the sub-turn as child { toolCallId, agentId }
       -> compact text back to LLM; parts persisted on tool_call row

Renderer
  tool_use(providerType:'agent') -> ToolCallBlock w/ subParts
  child -> appendToolSubEvent accumulates MessagePart[]   (nested asks -> chat store inputRequests)
  MessageStream -> AgentToolSubThread -> AgentContribution (parts render)
```

## Integration Points

- [Chat Routing](../chat_routing/chat_routing.md) — who answers a message in a chat, and where `coordinator` sits among the three answers. The transitions in and out of this mode, the badge and the `[+]` toggle all live there.
- [Messaging](../messaging/messaging.md) — `chatStreamingService` is the orchestrator; it now unions MCP + agent tool providers and calls their execution and event-delivery contracts. A sub-turn's events reach the renderer wrapped in `child` — see [Stream Event Typing](../../development/stream_event_typing/stream_event_typing_llm.md).
- [On-Demand MCP](../../mcp/on_demand/on_demand.md) — `chat_on_demand_agents` is a verbatim mirror; the announce prefix is combined across MCPs and agents. The former root agent is added as a pending-announce on-demand agent, so it is announced like any freshly attached agent.
- [Agents](../../agents/agents/agents.md) — Agent turns reuse the A2A client, endpoint/token resolution, and the `a2a_sessions` table via the port-free `runAgentTurn` core.
- [A2A Streaming Pipeline](../../agents/agents/streaming_pipeline.md) — The agent's rich `parts[]` (`cinna.content_kind`) stream over the same external A2A surface; orchestrated mode just stops collapsing them.
- [Remote Agents](../../agents/remote_agents/remote_agents.md) — The `cinna.mcp` descriptor is carried through the remote-agent sync into `agents.remote_metadata`.
- [Conversation UI](../conversation_ui/conversation_ui.md) — The sub-thread reuses the existing thinking / tool / tool_result / command_result blocks.
- [Chat Modes](../chat_modes/chat_modes.md) — Supplies the orchestrator's provider + model. No mode → orchestrated mode is unavailable.
