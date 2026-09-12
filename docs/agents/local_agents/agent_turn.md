# The Agent Turn — chatting with a folder agent

> **What the engines actually do over this protocol is verified against the real binaries — see [The ACP Engine Contract](acp_contract.md).** This document does not restate it. Four of its findings shape every rule below: `session/load` **replays the whole conversation** before it answers; `session/request_permission` is a *blocking request*, so the answer is the response rather than a separate call; OpenCode registers **no question tool** under ACP while the Claude adapter gains one from a declared client capability; and OpenCode's saved permission grants are **user-global**, which is why the desktop answers *Always allow* itself and never sends `allow_always` — see [Local Agent Permissions](permissions.md).

## Purpose

What happens when a user types a message into a chat with a folder agent: the message becomes one streaming turn against a child process running that agent's engine, at parity with a chat against a remote A2A agent. Same composer, same transcript, same cancel button, same orchestrated-tool behaviour.

**One implementation serves both engines.** Until phase 3 of the agent runtime plan there were two: `LocalAgentTurnRunner`, which drove a shared `opencode serve` over HTTP with an SSE event bus, a durable cursor and hole-and-heal recovery; and `ClaudeAgentTurnRunner`, which ran the Claude Agent SDK inside this process. Both are gone. With the transport standardised on the [Agent Client Protocol](../drivers/drivers.md) there is nothing left for them to disagree about — what differs between engines is how a process is started, and that is a [launcher](engine.md).

## A note on paths

Same convention as [The Local Engine](engine.md) and [Agents Home, Scanner & Folder Index](folder_index.md):

| Written as | Means |
|---|---|
| `src/...`, `docs/...` | A file in **this repository** |
| `Local/<slug>/...`, `cinna-agent.json`, `app-data/desktop.json` | Inside an **agent folder** |
| `session/new`, `session/prompt`, `elicitation/create` | ACP methods, spoken over the child process's stdio |

## The governing principle

**The turn is the only thing that varies. Everything around it is reused, unchanged.**

The desktop already had a port-free, caller-agnostic single-turn primitive whose output is exactly what a folder agent has to produce: compact `text` for an orchestrator LLM, full-fidelity `parts[]` for the UI, `notices`, and the session bookkeeping. So the ACP driver is not a second pipeline; it is a second implementation of one call signature, and every consumer downstream of it — the parts accumulator, the delta sink, the message repository, the session repository, the renderer — is reused verbatim.

A shared main-owned executor now wraps the transport for both typed chat sends and Inbox continuations. It observes asks without requiring a renderer port, reserves one active turn per chat, and distinguishes message acceptance from turn completion. ACP parks remain live; the autonomous runner composes consecutive turns through the same executor; see [shared turn lifetime](../../chat/chat_routing/chat_routing_tech.md#shared-turn-lifetime-and-acceptance).

## Core Concepts

- **Driver** — one agent turn, whatever kind of agent it is: the shared input in, the shared result out, and it **never throws**. Three transports, a2a/acp/managed, and `driverFor(agent)` is the one dispatch point ([Agent Drivers & Readiness](../drivers/drivers.md))
- **Launcher** — the engine-specific half of an ACP turn: what to spawn, what to declare, what `session/new` carries, and what must be set on the session before the first prompt. It also answers with a **refusal** in place of a plan
- **Process pool** — one child per agent, started by the turn that needs it, held for that turn's length, reaped after two minutes idle ([The Local Engine](engine.md))
- **Session** — an ACP session id created against the agent's folder. One per (chat, agent), remembered so a conversation survives a restart
- **Replay** — the `session/update` notifications `session/load` emits for the *whole* prior conversation before it answers. Dropped, never ingested
- **Parked request** — a permission ask or a question the agent is blocked on, mid-turn, waiting for a human. Over ACP the agent is blocked on a JSON-RPC request, so the park **is** the unresolved response
- **Cancel grace** — the bounded wait for an agent to acknowledge a `session/cancel`. Three seconds, after which its process is retired
- **Turn ceiling** — the backstop that ends a turn which never settles for any reason, found or unfound. Twenty minutes

## User Stories / Flows

### Chatting with a folder agent
1. The user opens a chat bound to a folder agent and sends a message
2. The message is persisted exactly as it is for a remote agent — one shared path, no local branch
3. The **folder is read**: it must still exist on disk, must be switched on, and must not be in a readiness state it cannot run from. The engine comes from what the folder says now, not from the row
4. That engine's launcher **plans** the turn, or refuses it in a sentence. Planning may resolve (and download) the `opencode` binary, generate this agent's config, or probe whether Claude Code is logged in — all of it before the turn lock is taken, so a user reads the reason instead of queueing behind another chat to be told
5. The per-agent turn lock is taken, the agent's process is acquired — started if this is the first turn — and a session is loaded or created
6. The launcher's setup is applied to the session: the agent definition on OpenCode, the approval mode on Claude
7. The prompt is sent. Text, thinking, tool calls and their results stream into the transcript as `session/update` notifications arrive; the turn ends on a stop reason and the assistant message is persisted

### Continuing a conversation the next day
1. The user reopens the chat. The session id was remembered for this (chat, agent) pair
2. The remembered id is **verified by use, not by a probe** — there is nothing to ask. `session/load` either works or it does not
3. If it works, the whole prior conversation replays as notifications first; the replay is **dropped**, and only what the new prompt produces reaches the transcript
4. If it fails, a fresh session is created and the user simply carries on — no error, no explanation owed. Nothing has streamed at that point, because the replay gate was closed for exactly this window

### The agent asks for permission
1. Mid-turn the agent wants to reach outside its folder, fetch a URL, edit its own manifest or prompt, or run something the profile flags, and it blocks on `session/request_permission`
2. A permission block appears in the transcript *inside the streaming answer*, with the action and the things it wants to touch
3. The user answers **Allow once**, **Always allow** or **Deny**. The answer is delivered by request id, out of band, and settles the blocked request
4. The decision is recorded in the transcript beside the ask, and the agent continues or takes the denial
5. If a standing grant already covers the ask, **none of that happens**: the agent is answered `allow_once` automatically and nothing is written to the transcript at all

### The agent asks a question
1. Only on Claude, and only because the client declares `elicitation.form`: the adapter enables its `AskUserQuestion` tool, renders each question as a form field and sends `elicitation/create`
2. The question block renders, the answer is delivered by request id while the turn streams on, and the turn does **not** end to ask
3. On OpenCode nothing arrives here — its `question` tool is not registered under ACP — so a model that wants to ask asks in prose

### Cancelling
1. The user presses Stop mid-answer
2. Anything parked is answered **first**, so an agent blocked inside a permission request can unwind and read the cancel at all
3. `session/cancel` goes out and the pending `session/prompt` is expected to come back `cancelled`. It gets three seconds; an agent that never acknowledges has its **process retired**, because a turn is still running inside it and the next prompt on that session would interleave with work the user stopped
4. Whatever streamed before the cancel is kept, and the stop is not reported as an error

### The agent's process dies
1. The connection closes. The turn ends with the failure the stream reports, and the parts already streamed are kept
2. Nothing restarts it. The agent page shows `exited`, and the **next** turn starts a fresh process

## Business Rules

### One turn contract and one dispatch point

`AgentDriver.run` is a single method: take the shared input, return the shared result. A2A, ACP and Managed implement it; the registry selects the transport. This document scopes the ACP path to folder agents; [custom commands](../custom_agents/custom_agents.md) share it with captured external state. `driverFor(agent)` reads `agents.driver` and nothing else.

**The row is a cache; the folder is the truth.** The dispatch point reads the row, so an A2A agent — which has no folder — never costs a filesystem hit on a turn. The ACP driver then reads the folder at the start of every turn and takes its **launcher** from what the folder's runtime says now. This used to be a reconcile *between drivers*: with one driver per engine, a Claude agent dispatched on a stale `opencode` row had to be handed across, and while that hand-off was missing such an agent answered "try again in a moment" for ever. With one driver it is a lookup, which is the point of the collapse.

Where the folder cannot answer at all — the row is gone, the folder has moved, the manifest is mid-save — the turn is refused in the runners' own sentence rather than guessed at. The one reader left for the stored launcher is `capabilities()`, which has only a row to go on.

**Dispatch never keys on "has no card URL".** A missing card is a symptom several unrelated states share. A combined `!agent || !agent.cardUrl` guard once stood at the dispatch seam, matched every folder agent, and answered "Agent not found or not configured" before any local branch could be reached. The card check lives inside the A2A driver, and only an A2A row reaches it.

### `run` never throws

A failed turn is a *result carrying an error*, not an exception. Both call sites have to render a failure either way, and an exception crossing the IPC boundary loses its code — `ipcMain.handle` serialises a rejection to message and stack, and `contextBridge` re-clones it, so a renderer guard testing `err.code` silently never fires.

Enforced at both ends. The driver catches — including around `turnLock.acquire`, which *throws* when the same agent is opened in a second chat and whose message is already user-facing ("This agent is busy right now…") — and the direct-chat wrapper catches too, because that wrapper is what every future driver passes through and a driver that breaks the promise used to close the port having posted neither `done` nor `error`, leaving the renderer streaming for ever.

### Refuse before the lock, stream inside it

Everything that can be answered without spawning anything is answered first: the folder's own state, `enabled`, the engine this build cannot run, and the launcher's plan — no `opencode` binary, no usable credential, no model, no Claude Code, not logged in. Only then is the lock taken.

The ordering is about what the user reads. A refusal produced *inside* the lock would queue behind another chat's turn on the same agent before saying that this agent cannot run at all.

The lock covers the streaming half: acquire the process, load or create the session, apply the setup, prompt, stream, settle. It is the same per-agent lock the page editors and the folder watcher respect — see [Invariant 3](#invariant-3--no-desktop-writes-while-a-turn-streams).

### The load replay is dropped, not appended

`session/load` replays the entire prior conversation as `session/update` notifications *before* it answers. Ingesting them would append the whole history to this turn's message.

So the driver binds its handlers first — there is nowhere else to put traffic that arrives before the bind — and drops every update until `loadSession` resolves. **The gate closes before the bind, not after it**, because binding flushes the connection's pre-bind buffer *synchronously*: a stop and a resend in the same chat inside that window would otherwise fold the stopped turn's tail into the new one.

The mode a loaded session reports is deliberately not read either. It is the mode the session was left in, and the setup that follows overwrites it before the first prompt — reading it would only give the fallback notice a stale value to compare against.

### Traffic that arrives before a turn binds is kept, not dropped

Messages are *read* in order and *processed* concurrently: the SDK dispatches each incoming message without awaiting the previous one, so a `session/new` response and the notifications written right behind it race each other through the client. Recorded, not hypothesised — an `available_commands_update` follows its `session/new` response with nothing in between.

A turn that bound its handlers on `session/new`'s answer would therefore drop the opening of its own turn some fraction of the time. So the connection keeps an unbound session's traffic in a short, bounded holding pen (500 notifications, 10 s) and a bind drains it in order. A permission or elicitation request for a session nobody binds within that window is answered `cancelled`.

### `session/update` is taken off the wire before the SDK validates it

The SDK's session-update schema is a **closed union** of the kinds that version knows, installed as a static handler ahead of anything we could register — so an update kind it has not heard of throws there and is dropped with a console error. Nothing in the recordings is outside the schema today, and one `opencode` or adapter bump is all it takes; what would go missing is a chunk of a message.

So the connection consumes `session/update` in the transport tap, checks only what routing needs (a session id, an object update), and hands the notification over as it arrived. **Ignoring kinds it does not know belongs at the translation layer**, where it is explicit and silent by design: a turn that was going fine must not die because the agent learned a new trick.

### `fs/*` and `terminal/*` answer "method not found"

The client declares neither capability, which per ACP means an agent must not call them — and draft v2 removes them outright. OpenCode 1.18.27 calls `fs/write_text_file` anyway; on the `-32601` it writes the file itself and the turn continues to a completed tool call. So the error is the *working* answer, and it costs nothing: answering for real would hand the agent a second, unaudited write path, and crashing would break turns that work today.

### The translator maintains a cumulative message; the accumulator computes the delta

The parts accumulator was built for A2A, where every update carries the message **as it stands**. ACP emits true deltas, so the translator folds each notification into a cumulative message and hands the whole thing back for re-ingestion. Feeding a raw chunk straight through would look correct with one chunk and duplicate every character from the second onwards.

Four rules come from watching the wire rather than from the protocol document:

- **Only a chunk names a message.** `tool_call` and `tool_call_update` carry no message id in either engine, so a tool call is filed under whatever message was current when it arrived. Under the Claude adapter a turn's tool calls arrive *before* its first chunk, so they land in an anonymous message of their own — which is far better than adopting the id of whatever message comes next
- **The first title wins as the tool name.** OpenCode titles a call `write` and then retitles the *same* call with the file path; the Claude adapter titles a Bash call `Terminal` and then the command. Neither later title is a tool name. What is authoritative is `_meta.claudeCode.toolName`, then the non-standard `name` field, and only then the first title
- **A tool call ends a run of text.** A turn is text → tool → more text, and the second run must not be appended to the first part, or the renderer shows the tool block after a paragraph it interrupted. No recording *forces* this rule — both engines happen to start a new message id after a call — which is exactly why it is written down: the protocol never promised it
- **Part identity is assigned once and never moves**, and text never shrinks. A part key gets an index on first sight and keeps it; parts are appended, never spliced

### Permissions and questions are `tool` parts. There is no `permission` part kind

**This is the convention a future contributor will otherwise break, so it is stated flatly: neither a `permission` nor a `question` stream-part kind exists, and none is to be added.**

The stream vocabulary is a wire contract shared by the main process, the preload guard and the renderer, and it already has a convention for "a tool call the renderer should render as an interactive widget": Ask-User-Question is detected renderer-side by pattern-matching a `tool` part whose tool name normalises to `askuserquestion` (see [Ask User Question](../../chat/ask_user_question/ask_user_question.md)). A permission ask is the same thing, so it follows the identical convention under a reserved tool name. The **part** is the transcript, and it is all a reloaded chat has. A running turn also announces the ask on the stream — `needs_input` right after the part, `input_resolved` when it settles ([Stream Event Typing](../../development/stream_event_typing/stream_event_typing_llm.md)) — but those events are never persisted, which is why they cannot replace the part.

The reserved permission name is deliberately not a name any model would emit: an ask is *about* a tool (`bash`, `edit`, `webfetch`), so naming the request after a tool would make an agent's own call to that tool indistinguishable from a request to run it.

The request id rides in the part's existing tool-id field, because that field already exists to pair a call with its result — and here it is *also* the address the answer is posted back to.

### A request id is a live address that dies with the turn

Ids are **minted by the desktop** (`per_acp_…` / `que_acp_…`), never taken from the agent's own call id: over ACP the park is an unanswered JSON-RPC request, and the agent has nothing to correlate an out-of-band answer with anyway.

This is what separates a local agent's question from a cloud agent's, and the separation is load-bearing on the replay path. A cloud agent's question ends its turn and stays answerable afterwards; a local agent's request is answerable **only while its turn is still parked on it**, so a persisted block bearing one of those ids renders read-only however recent the message is. While a turn runs, main says so two ways: the stream posts `needs_input` when the ask is parked and `input_resolved` when it settles, and the renderer also polls the pending-request registry — not redundantly, because a reloaded renderer has no port and an ask raised before it subscribed never reaches it as an event. Where the two disagree, *settled* wins.

### The answer travels out of band, and every exit clears what is parked

The answer could have ridden the turn's message port, but that port exists only for a *direct chat* — the turn primitive is port-free and orchestrated mode has no port at all. A registry keyed by request id serves both.

A parked request with no answer coming is a turn that never ends. So:

- **Every exit — cancel, error, ceiling, teardown — releases what this turn parked.** A request left registered keeps rendering as answerable, and answering it reports success into a turn that has ended
- **The turn's own ending closes the ask gate first**, so a park it releases posts no `input_resolved`: the terminal `done` or `error` above the driver already says nothing is parked
- **A released park is not a decision.** The registry settles a release as `rejected`, which is also what an expiry looks like — so the transcript says "No answer — the request expired." for an expiry, and "Not answered — the turn was stopped." when the user stopped it. Denying is the only safe answer either way; recording a decision nobody made is not
- An unanswered ask also expires on its own timer, which sends a real rejection rather than abandoning the agent inside a request

### A cancel is bounded, and the parks go first

Stop and the twenty-minute ceiling do the same two things — send `session/cancel` and start the grace that bounds the wait for an acknowledgement — and they **share one signal**, because a grace armed only by the user's abort would leave the ceiling with no way out of a prompt the agent never answers: the timer fires, the notification goes unheard, and the turn holds its lock for the life of the app. Which is the failure the ceiling exists to prevent.

Inside that, the order is the point:

1. **The parked asks are answered first.** An agent blocked on `session/request_permission` cannot act on a notification it has not read: it is inside a request, waiting for us. Releasing the parks answers that request with a refusal, the agent unwinds, and the prompt comes back `cancelled` inside the grace — so a Stop pressed while a permission block is on screen ends the turn instead of timing out and killing a perfectly good process
2. `session/cancel` goes out. It is a notification, so nothing waits on it; a connection that has already died has nothing to tell
3. Three seconds. An agent that has not acknowledged **loses its process**, because a turn is still running inside it

**The abort is re-checked between acquiring the process and sending the prompt.** Everything before that awaited — a spawn, `session/new`, the setup calls — which is one to two seconds in which a Stop lands with no session to cancel. Sending the prompt anyway would start the agent on work the user cancelled and then kill its process three seconds later. And a listener added to an **already-aborted** signal never fires, so a stop that lands while the launcher is still planning is checked for explicitly — that window used to be dropped entirely, and the turn ran to completion after the user had stopped it.

### The setup is a refusal, not a warning

`session/set_mode` and the mandatory `session/set_config_option` calls are what make the desktop's own choices true: OpenCode's `mode` selects the agent definition (without it the turn runs the engine's stock coding agent in the user's folder), and Claude's `session/set_mode` is the only thing that overrides a `defaultMode` from the user's own settings — which can be `bypassPermissions`. A turn that ran anyway would run under a policy nobody chose.

The refusal goes out through the same exit every other path takes, so the session this turn *did* create is still recorded: a bare failure leaves it behind engine-side and mints another on every retry, and the chat never gets a session to continue from.

One option is exempt, and only one: OpenCode's `model` set, which the config's top-level `model` has already selected. See [The Local Engine](engine.md#a-config-per-agent-written-where-the-users-folder-is-not).

### The transcript says when an agent did not run in the mode it was given

The desktop's approval setting is a promise to the user, and the agent can quietly not keep it. Over ACP the signal is a `current_mode_update` (or a `config_option_update` for `mode`) naming a mode other than the one `session/set_mode` was given, and **any** disagreement is reported, in the words of whichever way it went — asked for `auto` and ran asking, or asked for `default` and ran automatic, which would be far worse.

A notice, not a status line, because it belongs beside the turn it describes: a panel would say it once, about whichever turn ran last, on a screen the user may not be looking at.

### An error after a partial answer does not blank the answer

Parts already streamed are kept and returned alongside the error, on every exit — including the ceiling and a cancel whose grace expired. The A2A path behaves the same way, so the transcript reads the same for both kinds of agent.

`max_tokens`, `max_turn_requests` and `refusal` stop reasons are reported as errors rather than swallowed: a reply that stops mid-sentence with no explanation reads as a bug in this app.

### *Always* is answered by the desktop, and never reaches the engine

The third permission answer is offered, and it stops in the main process. `allow_always` writes into the *engine's* own store — user-global on OpenCode, `~/.claude/` on Claude — and the measurement was repeated over ACP: answering `allow_always` once in one folder silenced every later ask in that folder, **including in a new session in the same process**. So `pickPermissionOption` cannot return an `allow_always` option at all: it is filtered before the search, not merely deprioritised.

Three obligations follow, and each is a lie to the user if dropped:

- **What the agent is told is a plain allow-once.** The rule is written beside the folder instead
- **The transcript says which of the two happened** — "Allowed, and remembered for this agent." only where the rule reached disk, "Allowed once." otherwise. A store that refused the write must not cancel the action the user approved: they are asked again next time, and nothing claims a rule that does not exist
- **An auto-answered ask writes nothing.** The grant is checked *before* any part is created, so no block, no registry entry and no `needs_input` exist for it. A block that appeared and answered itself milliseconds later would be a widget the user cannot act on, mid-stream

The vocabulary is the engine's and stays the engine's: a grant made under OpenCode's `bash` must never silently authorise Claude's `Bash`. The rest of the model is [Local Agent Permissions](permissions.md).

### The `enabled` gate lives in the driver, and nowhere else

The config generator does not consult `enabled`. The driver does, before it plans anything, in the runners' own sentence. Deleting that check makes a switched-off agent chattable.

### Invariant 3 — no desktop writes while a turn streams

The turn holds the per-agent lock for its whole streaming life, which is what stops the folder being written to underneath a running agent. Assume a rescan can land at any moment, including mid-turn, and rely on the lock rather than on timing: macOS FSEvents replays a backlog of pre-arm changes on *every* watcher arm, so a rescan can fire from a watcher's own recovery with no user action at all.

What is **no longer** part of this invariant: the engine. There is no shared process to be restarted underneath anyone, so `turnLock.anyHeld()` has no engine-level caller left, and a config change is not deferred behind anybody's turn.

### Invariant 4 — secrets never reach the renderer

Nothing here widens the secret surface:

- **A credential travels only as the `CINNA_ENGINE_KEY_…` variable the generated config names**, into the child's environment. Nothing on the turn path holds a key, and the launch spec's key — which *is* logged — is a digest
- **No engine response is logged wholesale.** The rule outlived the endpoint that produced it: OpenCode's HTTP `/config` returned the resolved config with keys substituted, and the next response to carry a secret will not announce itself either

What the renderer receives is what it has always received for an agent turn: stream events and message parts.

### Session continuity reuses the A2A column, on purpose

A folder agent's session id is stored in the A2A session table's `context_id` column, and the column names stay A2A-flavoured deliberately: that column is what the existing session lookup reads to decide a chat is an agent chat, so putting the session there means every existing reader keeps working.

There are **two stores**, answering different questions. The SQLite row carries continuity on this machine; the copy in the agent's desktop state is the durable one — `app-data/desktop.json` for a kit agent, a file under `<userData>` keyed on the folder's path for a [bare](bare_agents.md) one, whose folder is never written into. The driver passes the agent's kind with the path rather than probing the folder, so the two callers cannot disagree about which store an agent has. Invariant 1 says the row is a cache, so the folder copy failing to write must not fail the turn.

### A turn always settles

Only four things can end a turn: a stop reason, an abort, the connection dying, and the ceiling.

The ceiling is the backstop for every door that has not been found yet. It turns the worst outcome — a turn that never settles, holding its agent's lock for the life of the app — into "one turn failed with a readable message". It is generous on purpose: a real agent run doing real work can take minutes, and a ceiling that fires on a working turn is worse than no ceiling.

## Architecture Overview

User send → renderer run.start → run:start → runExecutionService → driverFor(agent) → ACP driver → fresh folder runtime → launcher plan → per-agent turn lock → pool initialize → session load/new → setup → prompt.

ACP notifications pass through AcpMessageStream and StreamPartsAccumulator into the main observer. Stream services persist the answer; liveRunHub delivers snapshots/events through the selected-chat run:watch subscription. useRunEventHandler projects them once. A coordinator specialist uses the same driver and wraps its events in child frames.

Permission/question → captured pending registration → tool part + needs_input → transcript/Inbox answer → owned runtime validation → grant/resolve/commit → input_resolved while the turn remains open. Stop and the turn ceiling cover setup as well as a pending prompt; leaving the view only detaches its watch.

## Integration Points

- [The Local Engine, Runtimes & Prompt Assembly](engine.md) — the launchers this turn plans with, the per-agent config, the process pool and the binary behind it
- [The ACP Engine Contract](acp_contract.md) — what was actually watched on the wire, per launcher, and what is still unverified
- [Agent Drivers & Readiness](../drivers/drivers.md) — the dispatch point, the capability answer a composer reads, and the readiness a send is refused on
- [The Claude Engine](claude_engine.md) — the second launcher: the approval mode set on every session, the question path it gains, and the isolation it is spawned with
- [Local Agent Permissions](permissions.md) — what an ask can be about, and where a standing grant lives. This document owns the parking and the reply; that one owns the decision and the store
- [Agents Home, Scanner & Folder Index](folder_index.md) — the `enabled` flag this driver gates on, the readiness values it refuses, and the per-agent turn lock
- [Ask User Question](../../chat/ask_user_question/ask_user_question.md) — the tool-part convention permission and question blocks follow
- [Orchestrated Agents](../../chat/orchestrated_agents/orchestrated_agents.md) — an orchestrated tool goes through `driverFor` just as a direct chat does
- [Agents (A2A streaming)](../agents/agents.md) — the direct-chat wrapper, the parts accumulator and the session table this turn reuses whole

## What is not verified

This project's honesty convention applies: coverage is named, not implied.

**The driver's own suite runs against a scriptable fake ACP agent over real stdio** (`testSupport/fakeAcpAgent.mjs`): a real child process, real ndjson framing, real blocking requests. What it cannot prove is the one thing measured by hand instead — that killing the process group takes the agent's own children with it, checked against the real Claude adapter (node plus its `claude` child before dispose, neither after).

Named gaps:

- **Gemini and Codex have not been run at all.** Neither binary is on the machine this was built on and the Codex adapter is not a dependency. Both are refused in words, and the capability answer claims no question path for either, because nothing has measured one
- **A `session/load` against a session an engine has forgotten** is covered by the fake, but the *shape* of what each real engine returns when a session id is stale has been seen only on OpenCode
- **Whether OpenCode will ever bridge a question to `elicitation/create`** is an open question upstream; today it registers no question tool under ACP, and the desktop claims none for it
- **The golden suites both engines had are gone**, deliberately. All 32 cases were reduced to their final text, part kinds, tool names, asks and notices before deletion: 26 map straight across to assertions in the ACP suite, three are gone by construction (an SSE drop healed by a durable cursor, a shared server that could be cold), and three that were **missing** are now covered — a user's explicit Deny, a permission ask arriving after the agent has already replied, and the notice that says the CLI fell back from automatic approvals
