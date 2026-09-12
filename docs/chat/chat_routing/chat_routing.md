# Chat Routing

> **Status:** implemented. Every chat has a router; it is the only thing that decides who answers.

## Purpose

Decide **who answers the next message in a chat** — the agent bound to it, one of several agents the user picks between, or the local model conducting them as tools. One value on the chat row (`chats.router`) answers that question for the composer, the send path, the attachment scope, the readiness refusal, the new-chat screen and the job runner, so none of them re-derives it.

The routing question used to be a boolean, `chats.orchestrated`: on meant "the local model conducts", off meant "the bound agent answers, or the model does when there is none". It had no way to say *"several agents, and the user routes between them"*, so **a second agent in a chat forced the local model into the middle of it** — and a user with no LLM provider configured could not have two agents talk to them at all. That is the failure the third value exists to fix.

## Core Concepts

- **Router** — `chats.router`, one of three values:
  - **`direct`** — one counterparty: the chat's bound agent (`chats.agent_id`), or the local model when there is none. A plain LLM chat is "direct to the LLM".
  - **`human`** — several agents, and **the user routes**. Each message addresses one of them; the others see it as thread context on their next turn. **No model is involved at any point**, so a chat like this runs with no LLM provider configured at all.
  - **`coordinator`** — the local model conducts, calling each attached agent and MCP server as a tool. This is what `orchestrated` meant, and it is documented in full under [Orchestrated Agents](../orchestrated_agents/orchestrated_agents.md).
- **Address** — which agent a message in a `human` chat is for. It is a **gesture, not a mention parsed out of the text**: picking an agent from the `@` popup or clicking its chip sets it, and the `@` token is deleted from the textarea as it always was. Nothing in the message body is scanned, so nothing moves while the user types.
- **Sticky default** — with nothing addressed, the message goes to whoever the **last user message** addressed; failing that, to the first attached agent. Read from the transcript rather than kept on the chat row, because the transcript is already the record and a second copy of it could disagree with what the user can see.
- **Catch-up packet** — the compact transcript of what an agent missed while somebody else was answering, put in front of the user's text on the wire. It is what lets two agents share a thread with no protocol between them.
- **Catch-up cursor** — per `(chat, agent)`, the last message that agent has been shown (`chat_agent_cursors`). No row means it has seen nothing.
- **Connection / router badge** — the pill left of Send. A resolved single-agent composer shows **Local** or **Remote** with connection details; **You route** / **Model routes** describe multi-agent routing. Job consumers can also show **Script routes** or the generic **Direct** fallback.
- **Coordinate toggle** — the composer `[+]` menu's "Let the model coordinate" row: the one router transition a user takes deliberately, and the only way back off `coordinator`.

## User Stories / Flows

### One agent (`direct`)

1. User picks a single agent on the new-chat screen and attaches no MCP servers.
2. The badge reads **Local** or **Remote**, based on the selected agent's execution transport. The internal router remains `direct`: no coordinating model is needed, and no model picker is offered.
3. The message streams straight to the agent, with full per-part fidelity.

### Bringing a second agent in — the chat the user routes (`human`)

1. User is in a `direct` chat with the "Email" agent and has some history.
2. User `@`-mentions "ERP". The chat moves to `human`: Email stops being the root and joins the attached set (keeping its session), ERP is attached, and the message the user is about to type is addressed to **ERP** — the agent they just named, not whoever answered last.
3. The badge flips to **You route**, and ERP's chip carries a ring.
4. ERP's turn is preceded by the catch-up packet: everything in the thread since its cursor, minus its own turns and the messages already addressed to it.
5. **No model was resolved, and none is needed.** This works on an install with no AI credentials at all.

### Addressing one agent per message

1. The user clicks a chip, or picks an agent from `@`. That is the address; the `@` token is removed from the textarea.
2. The ring follows the **resolved** answerer, not the raw click — before the user has picked anybody, the chip that would actually answer is the one marked.
3. Send refuses by name if that agent is not ready. Only the agent a message goes *straight* to is refused this way; an agent the model calls as a tool is not, because its failure comes back as a tool result the model can read.

### Handing the chat to the local model, and taking it back

1. In any chat that holds at least one agent, the `[+]` menu offers **Let the model coordinate**.
2. Ticking it moves the chat to `coordinator` — the one transition that can be refused, because it is the only one that needs a model. The refusal names the missing piece ("Add an LLM provider or pick a chat mode…").
3. Unticking it lands on `human` when agents remain, and back on `direct` when none do.
4. Nothing about the composer's height changes across any of it.

### Starting a new chat

1. The badge on the new-chat screen previews the router the current selection would create — the same call the send makes, so it cannot promise a shape the send does not build.
2. No agent → `direct`, to the local model. One agent, no MCP → `direct`, bound as the root. Several agents, no MCP → `human`. Any agent mixed with an MCP server → `coordinator`.
3. A `human` chat's first message goes to the **first agent the user picked**; the order they picked them in is the only signal there is.

### Running a job

A local job run makes the same decision from the job's attached agents and MCP servers, and spawns a chat already on that router. See [Jobs](../../jobs/jobs/jobs.md).

## Business Rules

- **One decision, one place.** `src/shared/chatRouting.ts` is pure — no React, no I/O, no Electron — so main and the renderer read the same answer from the same code rather than from two copies of the same sentence. Five hand-written copies of `chat.agentId && !chat.orchestrated` and a sixth answer from `derivePattern` were replaced by it.
- **The renderer does not pick where a message goes.** It used to, by picking between two IPC channels — and picking one *was* the routing decision. `run:start` is the normal send command; main reads the router and dispatches, while `run:watch` supplies output. Legacy agent/model send channels have been removed; `run:send` is the lower-level port API through the same executor. The renderer says only which agent the user addressed.
- **An address is honoured only if the chat is carrying that agent.** The composer and the chat row can disagree for a moment after a chip is removed, and a message to an agent the chat no longer has would be a turn nobody asked for. The guard is written as "not in a **non-empty** attached list", so a caller that cannot say what is attached still has its address honoured: an empty list from a cache that has not loaded is not the same fact as "this chat has no agents", and refusing the user's own gesture over that difference would send the message to the wrong agent for a turn. The same clause means a `human` chat that has somehow lost every agent still routes to an explicitly addressed one rather than to the model. A `human` chat with no agents should not exist (removing the last chip is what sends a chat back to `direct`), and "answer nobody" is not a shape the send path can express.
- **Only a chat the *model* answers needs a model.** `direct`-with-an-agent and every `human` chat talk straight to their agents. This is what makes `human` work with no provider configured, and it is why the model picker is hidden in those chats: offering one beside a badge saying no model is involved would be two surfaces disagreeing about the same chat.
- **The cursor advances only on a completed turn.** A failed or stopped turn leaves the same gap for the retry to carry. A cursor naming a message the chat no longer has is treated as no cursor at all and the whole thread is replayed — the safe side, because re-reading context costs tokens while silently missing the message costs the answer.
- **The catch-up packet is the same for every driver.** A resumable session holds that agent's *own* turns, not the other agents', and the gap is exactly the part it has never seen. Resumability only makes the packet smaller.
- **The packet is built before the user's message is persisted**, so the message being sent cannot appear in the transcript of what the agent missed. The renderer-side drop by `addressedAgentId` is a second guard; the two fail in opposite directions.
- **What the packet contains and what it leaves out.** Oldest first, capped at 4000 characters with the oldest lines dropped under a `[…earlier messages dropped to fit]` marker. It carries user messages (naming attached files, never their bytes), other agents' text, notices, and **tool names without their payloads** — a diff or a file listing is the bulk of a thread and none of what the next agent needs. It drops the agent's own turns, the messages already addressed to it, error rows (a dropped stream is not something that happened in the conversation) and empty rows.
- **Switching routers never costs an agent its context.** The `a2a_sessions` row for `(chat, agent)` is untouched by every transition.
- **Arriving at `direct` binds a single attached agent as the root**, which is what `direct` means. Arriving with more than one is refused rather than silently dropping the rest.
- **The attachment scope follows the router**, not the agent: a message an agent answers uploads to the Cinna backend, one the local model answers uses the local store. Whether an attach button is offered at all is a separate question, asked of the target agent's `capabilities.attachments`.
- **MCP servers are the model's tools; an agent cannot call them.** They are attached whenever the *model* is the one answering — which is not the same as `coordinator`: a chat with connectors and no agent at all is `direct`, to the model, and dropping its servers there would run it toolless.
- **The composer never moves while the user types or switches router.** The badge's label reserves the width of the longest of its three labels; the readiness line is rendered whenever the chat holds an agent at all, refused or not and whoever is answering; the addressed chip is marked with a ring rather than a border or weight change. Chip rings use the theme's foreground colour, not the agent's, because two agents can hash to the same preset.
- **Only chats.router persists routing.** The old orchestrated flag is backfilled into router on legacy databases before a guarded migration drops it. Current writers and DTOs carry no mirror. An existing router wins over a contradictory legacy flag, so a later startup cannot undo a route the user chose.

## What this deliberately does not do

- **It does not parse mentions out of the message text.** The address is set by a pick and nothing else, so no hint appears or moves per keystroke.
- **It does not let one message address two agents**, and there is no agent-to-agent protocol. In a `human` chat the agents never speak to each other; the user is the only router, and the packet is the only thing that crosses between them.
- **A handoff note supplements catch-up.** The packet remains a transcript. An [autonomous coordinator](../../jobs/tasks/autonomous_tasks.md) supplies the specialist’s handoff note separately, and its catch-up includes bounded tool-result text so delegated findings are available. Ordinary routing still omits tool payloads.
- **It does not own how the coordinator runs.** Tool naming, sub-threads, dual output and the depth guard are [Orchestrated Agents](../orchestrated_agents/orchestrated_agents.md).
- **It does not order a job's agents.** `job_agents` records no order, so a `human` job run addresses the first of a stable-but-arbitrary list. Stated honestly rather than dressed up: a run is one prompt, so it has to pick somebody, and the user routes the rest in the chat it spawns.

### Connection details in a single-agent composer

- **Local** means a folder agent or a non-WebSocket ACP process that Desktop launches. **Remote** means A2A (including directly registered connections), Cinna, WebSocket ACP or Claude Managed Agents. Registration ownership is not execution location: `source: local` does not make an A2A endpoint local. A stdio command may itself invoke SSH; Local does not inspect the command's eventual destination.
- Hover or keyboard focus shows the agent name and relevant details: folder path and the shared runtime summary; A2A protocol/version, domain and authentication method; ACP transport, folder/workspace and token presence; or Managed API, provider domain, credential name and environment.
- Remote domains contain only the URL host, including a port when present. User information, endpoint paths, queries and secret values are excluded. Missing configuration shows loading or unavailable feedback; the tooltip does not guess a subscription or credential.
- The badge is one keyboard stop, associates its tooltip with `aria-describedby`, stays open while hovered or focused, and dismisses on Escape. Labels use their natural width and stay on one line.
- The composer withholds a direct badge until it has the selected/bound agent. Other `RouterBadge` callers without agent data retain **Direct**; the presentation does not change routing or readiness.

## Architecture Overview

```
New chat (ChatWorkspace)
  pendingAgentIds + pendingMcpIds -> newChatRouter() -> direct | human | coordinator
                                                     -> RouterBadge (preview)
  send -> useNewChatFlow.startNewChat
            router decides: bind root / attach all / attach all + resolve a model
            attachment scope from routingOf(...).attachmentTarget

Active chat (ChatInput)
  routingOf(chat) -> router, rootAgentId, attachmentTarget, needsModel, answerer()
    answerer({ addressed, lastAddressed, attached }) -> { model } | { agent }
      -> RouterBadge          (who answers next)
      -> OnDemandAgentChips   (ring on the addressed chip; click = address)
      -> ComposerPlusMenu     ("Let the model coordinate")
      -> ComposerReadinessLine(refusal named for the answering agent)

  @-agent pick / [+] picker -> useAttachAgentToChat
       direct + agent -> chat:set-router 'human'      (no model)
       direct + none  -> chat:set-router 'coordinator' (needs a model; can refuse)
       then chat:on-demand-agent-add, and the pick is the address

Send -> useChatStream.startRun -> window.api.run.start -> run:start
Observe -> selected-chat run:watch -> snapshot + sequenced events
  main: routingOf(chatRow).answerer({ addressed, lastAddressed, attached })
    { kind: 'model' } -> chatStreamingService.stream
    { kind: 'agent'  } -> buildCatchUpPacket(from chat_agent_cursors)
                          -> withCatchUp(packet, userText)
                          -> driverFor(agent).run -> a2aStreamingService.streamToAgent
                          -> onCompleted -> cursor advances
```

## Integration Points

- [Messaging](../messaging/messaging.md) — `run:start` commands and `run:watch` observations share the main executor; `chatStreamingService` still runs the model’s half of it.
- [Orchestrated Agents](../orchestrated_agents/orchestrated_agents.md) — the `coordinator` value in full: agents-as-MCP, sub-threads, attributed history handoff.
- [On-Demand MCP](../../mcp/on_demand/on_demand.md) — `chat_on_demand_agents` mirrors it; the attached set is what `human` addresses and what `coordinator` calls.
- [Agent Drivers & Readiness](../../agents/drivers/drivers.md) — the composer's refusal follows the addressed agent; the catch-up packet is driver-agnostic by design.
- [Composer `[+]` Menu](../composer_menu/composer_menu.md) — hosts the coordinate toggle and the agent/MCP picker that triggers a router change.
- [Jobs](../../jobs/jobs/jobs.md) — a local run makes the same `newChatRouter` decision and spawns a chat already on it.
- [Chat Modes](../chat_modes/chat_modes.md) — supplies the provider + model a `coordinator` chat needs.
- [File Attachments](../file_attachments/file_attachments.md) — the upload scope is `routingOf(chat).attachmentTarget`.
