# The Agent Turn Runner — chatting with a folder agent

> **The engine contract this slice sits on is verified against the real binary — see [The OpenCode Engine Contract](opencode_contract.md).** That document records what was watched against `opencode` 1.18.27, what is only assumed, and what was believed and proved false. This document does not restate it. Four of its findings shape every rule below: `POST …/prompt` returns an **admission ack**, not the answer; `session.idle` is **never emitted** and `POST …/wait` is **declared but unimplemented**, so the only completion signal is `step.ended`; `GET /api/event` takes **no parameters at all** and therefore cannot be resumed; and saved permission grants are **user-global**, which is why the desktop answers *Always allow* itself and never sends `always` to the engine — see [Local Agent Permissions](permissions.md).

## Purpose

What happens when a user types a message into a chat with a folder agent: the message becomes one streaming turn against the local OpenCode engine, at parity with a chat against a remote A2A agent. Same composer, same transcript, same cancel button, same orchestrated-tool behaviour.

Phase 6 of Local Agents. Phase 5 built the machinery a turn needs — a running engine, a per-agent OpenCode agent key, an assembled prompt — and stopped one step short of sending anything. This is that step.

## A note on paths

Same convention as [The Local Engine](engine.md) and [Agents Home, Scanner & Folder Index](folder_index.md):

| Written as | Means |
|---|---|
| `src/...`, `docs/...` | A file in **this repository** |
| `Local/<slug>/...`, `cinna-agent.json`, `app-data/desktop.json` | Inside an **agent folder** |
| `/api/...` | A path on the local engine, reached only through `engineManager.request` |

## The governing principle

**The turn is the only thing that varies. Everything around it is reused, unchanged.**

The desktop already had a port-free, caller-agnostic single-turn primitive — `runAgentTurn` — and it already served *both* the direct agent chat and orchestrated-tool mode. Its output is exactly what a folder agent has to produce: compact `text` for an orchestrator LLM, full-fidelity `parts[]` for the UI, `notices`, and the session bookkeeping. So the local runner is not a second pipeline; it is a second implementation of one call signature, and every consumer downstream of it — the parts accumulator, the delta sink, the message repository, the session repository, the renderer — is reused verbatim.

The corollary is the shape of the work: this slice is a **lift**, not a rewrite. The A2A path's own body was not touched. The only change on that side is that two fields became optional, because a folder agent has neither of them.

## Core Concepts

- **Runner** — one agent turn, whatever kind of agent it is. Takes the shared turn input, returns the shared turn result, and **never throws**
- **Runner dispatch** — one function that answers "which runner does this agent's turn go through", used by both call sites. Dispatch is on `agents.source`, not on the absence of a card URL
- **Engine session** — an OpenCode `ses_…` created against the agent's folder and its agent key. One per (chat, agent), remembered so a conversation survives a restart
- **Admission ack** — what the engine answers a prompt with: a receipt saying the input was accepted, carrying an `admittedSeq`. Not the answer. The answer arrives on a *separate* subscription
- **Event bus** — the one process-wide subscription to the engine's global event stream, fanned out to turns by session id
- **Hole** — the events lost between a dropped socket and the next one. Unrecoverable from the global stream, because that stream takes no cursor
- **Heal** — filling a hole from the durable per-session stream, which *is* resumable
- **Turn stream** — the per-turn fold that turns one session's engine events into the A2A-shaped message the rest of the pipeline reads
- **Parked request** — a permission ask or an ask-user question the agent loop is blocked on, mid-turn, waiting for a human
- **Turn ceiling** — the backstop that ends a turn which never settles for any reason, found or unfound

## User Stories / Flows

### Chatting with a folder agent
1. The user opens a chat bound to a folder agent and sends a message
2. The message is persisted exactly as it is for a remote agent — one shared path, no local branch
3. The agent is checked: it must still exist on disk, must be switched **on**, and must not be in a readiness state it cannot run from
4. The engine is asked to be running. If it is already up it reconciles — re-deriving its config and restarting if the bytes moved — and this happens **before** the turn takes its lock
5. The engine is asked for this agent's key. No key means the running process does not know this agent, and the skip reason (if there is one) is what the user is told
6. The per-agent turn lock is taken, an engine session is opened or resumed, the event subscription goes live, and only then is the prompt posted
7. Text streams into the transcript token by token; tool calls and their results appear as blocks; the turn ends and the assistant message is persisted

### Continuing a conversation the next day
1. The user reopens the chat. The engine session id was remembered for this (chat, agent) pair
2. The remembered id is **verified, not trusted** — the engine's own storage can be cleared between runs
3. If the engine still has it, the session is re-pointed at the agent's current key (the config may have changed and the engine restarted) and the conversation continues
4. If it is gone, a new session is opened and the user simply carries on — no error, no explanation owed

### The agent asks for permission
1. Mid-turn, the agent wants to reach outside its folder, fetch a URL, edit its own manifest or prompt, or run something the profile flags, and the engine parks it
2. A permission block appears in the transcript *inside the streaming answer*, with the action and the things it wants to touch
3. The user answers **Allow once**, **Always allow** or **Deny**. The answer goes to the engine by request id, out of band — the turn is still streaming
4. The engine reports what it acted on, and the decision is recorded in the transcript beside the ask
5. The agent loop resumes, or takes the denial and continues

If a standing grant already covers the ask, **none of that happens**: the engine is answered `once` automatically and nothing is written to the transcript at all. What the grants are, where they live and why the engine's own *Always* is never used is [Local Agent Permissions](permissions.md); this document owns only the mechanics of parking, answering and settling.

### The agent asks a question
1. Same shape: the engine parks, a question block renders, and the answer is delivered by request id while the turn streams on
2. Unlike a cloud agent's question, this does **not** end the turn and there is no user message to send

### Cancelling
1. The user presses stop mid-answer
2. The turn settles as aborted, and the engine is **told** — an agent loop nobody is reading keeps running, keeps spending tokens and keeps holding the session
3. Whatever streamed before the cancel is kept

### The engine stops while an agent is answering
1. The engine process dies, or is stopped from Settings
2. Every listener is told the stream is **closed**, not merely disconnected, and every in-flight turn ends with "The local engine stopped while the agent was answering."
3. The session ids belonged to that process and died with it, so there is nothing to reconnect to

### A dropped socket mid-answer
1. The connection to the event stream drops. The reconnect happens on a capped backoff
2. When a new socket is live, the turn goes and reads the **durable per-session stream** from the last sequence number it saw
3. The replay carries both halves of the recovery: the words that were missed, and the event that actually ends a turn
4. The user sees the answer complete. If the turn had already finished inside the hole, it completes immediately

## Business Rules

### One turn primitive, two implementations, one resolver

`AgentTurnRunner` is a single method: take the shared input, return the shared result. Two implementations exist — the A2A one (which is `runAgentTurn` unchanged, behind the shared shape) and the local one. One resolver picks between them, on `agents.source`.

**Dispatch is on `source`, never on "has no card URL".** A missing card is a symptom several unrelated states share — a remote agent that has never been tested has no cached card either. This is not hypothetical: a combined `!agent || !agent.cardUrl` guard is what stood at the dispatch seam, and because folder agents are inserted with a null card URL it matched every one of them and answered "Agent not found or not configured" before any local branch could be reached. The friendlier branch below it was unreachable code for the whole of Phase 5.

**The resolver is the one dispatch point, and both call sites use it** — the direct-chat IPC handler and the orchestrated-tool provider. There is exactly one place to look when asking why an agent took a given path, and exactly one place to change when a third kind of agent arrives.

### `runTurn` never throws

A failed turn is a *result carrying an error*, not an exception. Both call sites have to render a failure either way, and an exception crossing the IPC boundary loses its code — `ipcMain.handle` serialises a rejection to message and stack, and `contextBridge` re-clones it, so a renderer guard testing `err.code` silently never fires.

This is enforced at both ends. The local runner catches, and the direct-chat wrapper catches too — because that wrapper is what every future runner passes through, and a runner that breaks the contract used to close the port having posted neither `done` nor `error`, leaving the renderer in the streaming state forever. The live instance of that was the turn lock: it *throws* when the same folder agent is opened in a second chat, and the message is already user-facing ("This agent is busy right now…"), which is exactly why it is worth surfacing rather than swallowing.

### Widening the shared input did not weaken the A2A path

`endpointUrl` and `cardUrl` became optional on the shared input, because a folder agent has neither. `runAgentTurn` itself still *requires* both, and the A2A runner is the single place that narrows — so the compiler continues to refuse an A2A turn with no card, rather than discovering it at the SDK call mid-stream.

### Subscribe before prompting. This is not an optimisation

The prompt call returns an admission ack and the agent loop starts immediately. The global event stream takes **no cursor**, so anything emitted before the socket is live is gone with no way to ask for it again. Connect first, prompt second. The difference is between a turn that streams and one that appears to hang until its first tool call.

The turn also *waits* for the socket, and the wait **rejects** rather than hanging if the stream cannot be opened — so a turn against a dead engine fails as an error the user can read instead of waiting forever for deltas that will never come.

### One bus, because there is one engine

One `opencode serve` backs every folder agent, and the global stream carries every session's events. A subscription per turn would open N sockets each receiving all N turns' events and discarding N−1 of them. So there is one process-wide subscription, fanned out by session id, connected lazily on the first subscriber and dropped on the last — an idle desktop holds nothing open.

That sharing has a consequence: **one turn's handler throwing must not take the stream down for everyone**, so every listener callback is run guarded.

An event that names **no** session is logged and dropped, never broadcast. The engine's error event genuinely can arrive attributable to no session at all — its schema declares no required fields — and broadcasting it would end every unrelated turn in flight.

### A disconnect is a hole; a close is the end of the world

These are two different notices and the distinction is load-bearing rather than tidy.

- A **disconnect** is a gap in a stream that will come back. The right response is to wait, then heal from the durable stream. Silently carrying on after a reconnect would truncate an answer — the failure mode hardest to notice and worst to debug.
- A **close** means the engine stopped and no reconnect is coming. The session id died with the process that issued it. A turn that treats this as a disconnect waits forever, holds its per-agent lock for the life of the app and — because a config change refuses to restart the engine while any lock is held — makes the engine permanently un-reconcilable for *every* folder agent.

Only a socket that comes back *after* one dropped is a reconnect. The first connection of a stream is not: a turn told "reconnected" there would go and fill a gap that does not exist, from a cursor it has never held.

### The completion signal is `step.ended`, and the test is inverted

The documented ways a turn ends are both dead — see [the contract](opencode_contract.md). The real terminal signal is `step.ended`, and the rule is deliberately the opposite of the obvious one.

The obvious rule is "end the turn when `finish === 'stop'`". That hangs the turn forever the moment a real turn ends with any other terminal value, and the schema does not constrain the field at all — it is a bare string with no enum. So **termination is the default and continuation is the enumerated exception**: the only value that means "the loop continues" is `tool-calls`, observed on a real tool-calling turn. Ending a turn early is visible, recoverable, and the user can ask again. A hang is none of those.

### Deltas are true deltas; the accumulator expects cumulative text

The parts accumulator was built for A2A, where every update carries the message **as it stands** and the accumulator computes the delta itself. OpenCode emits the opposite: true deltas.

So the turn stream does not translate an event into a part — it maintains the *cumulative* message and hands the whole thing back for re-ingestion. Feeding a raw engine delta straight through would look correct in a test with one chunk and **duplicate every character from the second chunk onwards**. This is not a theoretical trap: the inversion survived a mutation run against nineteen passing assertions.

Two related rules follow:

- **Part identity is assigned once and never moves.** The accumulator keys on (message id, index in the parts array), so each engine stream id gets an index on first sight and keeps it. Parts are appended, never spliced
- **Text never shrinks.** A block-level end event that is somehow shorter than what already streamed is ignored, because a shorter string would make the computed delta the *whole* new text and duplicate everything already rendered

### The block-level end event is idempotent, and that is what makes healing safe

The engine's `text.ended` carries the cumulative text and is the durable stream's *only* text event. Live, it is redundant with the deltas; after a reconnect, it is how the hole gets filled. It **sets** rather than appends, so replaying it over text already streamed is a no-op and replaying one whose deltas were lost restores the block whole.

The same never-shrink / never-shorten guard is applied to tool narrations, tool results and decision records, which is what makes a replay tolerant of re-delivered events regardless of whether the durable cursor turns out to be inclusive or exclusive.

### Permissions and questions are `tool` parts. There is no `permission` part kind

**This is the convention a future contributor will otherwise break, so it is stated flatly: neither a `permission` nor a `question` stream-part kind exists, and none is to be added** (seam 7 in the plan).

The stream vocabulary is a wire contract shared by the main process, the preload guard and the renderer, and it already has a convention for "a tool call the renderer should render as an interactive widget": Ask-User-Question is detected renderer-side by pattern-matching a `tool` part whose `cinna.tool_name` normalises to `askuserquestion` (see [Ask User Question](../../chat/ask_user_question/ask_user_question.md)). A permission ask is the same thing — a call the agent cannot proceed past until a human answers — so it follows the identical convention under a reserved tool name, and the renderer gains a sibling block component while the wire contract is untouched.

The reserved permission name is deliberately not a name any model would emit. OpenCode's permission asks are *about* tools (`bash`, `edit`, `webfetch`) and carry the real tool name separately, so naming the request after a tool would make an agent's own call to that tool indistinguishable from a request to run it.

The request id rides in the part's existing `cinna.tool_id` field, because that field already exists to pair a call with its result — and here it is *also* the address the answer is posted back to. The renderer needs no new field to know where to send an answer.

### An engine request id is a live address that dies with the turn

This is what separates a local agent's question from a cloud agent's, and the separation is load-bearing on the replay path. A cloud agent's question ends its turn and stays answerable afterwards — answering it sends the next user turn. A local agent's request is answerable **only while the engine is still parked on it**, so a persisted block bearing one of those ids must render read-only however recent the message is. Whether it is still live is a question only the main process can answer, and it answers it from the pending-request registry.

### The answer travels out of band, and every exit clears what is parked

The answer could have ridden the turn's message port, but that port exists only for a *direct chat* — the turn primitive is deliberately port-free and orchestrated mode has no port at all. Routing the reply through a registry keyed by request id means one path serves both modes.

A parked request with no answer coming is a session that never goes idle. So:

- Every exit from a turn — cancel, error, teardown — **rejects** whatever is still pending, using the engine's own clean exits (a question's reject endpoint, a permission's `reject` reply)
- An unanswered request also expires on its own timer. Expiry sends a real rejection rather than abandoning the request, so the session goes idle by the same path a deliberate Deny takes
- A request the **engine** settled (including by a decision made from outside this window) is *dropped* from the registry, not resolved. Resolving it would make the runner post a redundant rejection at a request the engine has already closed. Dropping only the turn's own handle and not the registry entry left it live for the full expiry window — during which a persisted block kept rendering as answerable and answering it reported success while the reply 404'd, telling the user their decision landed when it did not
- Re-registering the same id settles the first registration as rejected, so a replayed ask cannot leave an orphan promise nothing will ever resolve

### The `enabled` gate lives in the runner, and nowhere else

The engine config generator skips only readiness `invalid` and `contract_too_new`. It does **not** consult `enabled` — so a folder agent the user has switched off still gets an OpenCode agent entry and a written prompt file.

That is coherent as a design: the engine config is a catalogue of what *can* be addressed, and the runner decides what a turn may reach — which also leaves a disabled agent's prompt on disk for the user's own assistant to read. But it means **the gate exists in exactly one place**. Deleting the check in the runner makes a disabled agent chattable.

The check runs before the engine is touched at all: a turn against a disabled agent starts nothing, reconciles nothing and opens no session.

### Reconcile before the lock, stream inside it

The engine's `ensureRunning` is the config choke point: it re-derives the config from current state and restarts if the bytes moved. One process backs every folder agent, so that restart ends *every* streaming turn — which is why a config change refuses while any turn lock is held.

Calling it *after* taking the lock would therefore not be unsafe, merely useless: the change would be deferred past the very turn that asked for it. So it is called **before** the lock, and the lock covers the streaming part only.

**The engine-level predicate is "is any lock held", not "is this agent locked".** One `opencode serve` backs them all — see [The Local Engine](engine.md), where this is argued at length and where a live Invariant 3 violation of exactly this shape was found and fixed. This slice inherits that rule rather than restating it: the turn holds the per-agent lock, and it is the *global* predicate that keeps the engine from being restarted underneath it.

### Invariant 3 — no desktop writes while a turn streams

The turn holds the per-agent lock for its whole streaming life, which is what stops the folder being written to underneath a running agent. Assume a rescan can land at any moment, including mid-turn, and rely on the lock rather than on timing: macOS FSEvents replays a backlog of pre-arm changes on *every* watcher arm, so a rescan can fire from a watcher's own recovery with no user action at all.

### Invariant 4 — secrets never reach the renderer

Nothing in this slice widens the secret surface, and two rules keep it that way:

- **The engine's base URL and auth password stay inside the engine manager.** Every call this slice makes goes through the manager's request method — there is no IPC channel that hands the renderer a door to the engine, which is exactly what stops a component being written that routes around the runner
- **No response body from the engine is ever logged.** The engine's config endpoint returns the *resolved* config with environment references substituted, so its response contains live API keys — and it is not the only thing behind that door that can. A helpful debug dump is how a key reaches a log file

What the renderer receives is what it has always received for an agent turn: stream events and message parts.

### Session continuity reuses the A2A column, on purpose

A folder agent's engine session id is stored in the A2A session table's `context_id` column (seam 9), and the column names stay A2A-flavoured deliberately. That column is what the existing session lookup reads to decide a chat is an agent chat, so putting the engine session there means every existing reader keeps working — rather than adding a parallel table each of them would have to learn about.

There are **two stores**, and they answer different questions. The SQLite row carries continuity on this machine; the copy in the agent folder's `app-data/desktop.json` is the durable one that travels with the folder. Invariant 1 says the row is a cache that can be dropped and rebuilt, so the folder copy failing to write must not fail the turn.

### A turn always settles

Only four things can end a turn: a terminal engine event, an abort, the engine closing, and a ceiling.

The ceiling is the backstop for every door that has not been found yet. Three separate defects in this phase all ended at the same place — a turn that never settles, holding its per-agent lock for the life of the app and, through the global lock predicate, stopping the engine being reconciled for every folder agent. Each was fixed at its own door; the ceiling caps them all, including the doors nobody has opened yet. It turns the worst outcome from "the app is permanently degraded and only a restart fixes it" into "one turn failed with a readable message".

It is generous on purpose. A real agent run doing real work can take minutes, and a ceiling that fires on a working turn is worse than no ceiling.

### An error after a partial answer does not blank the answer

Parts already streamed are kept and returned alongside the error. The A2A path behaves the same way, so the transcript reads the same for both kinds of agent.

### *Always* is answered by the desktop, and never reaches the engine

The third permission answer is offered, and it stops in the main process. One `always` posted to the engine writes a grant naming no directory, no session and no agent into a **user-global** store shared with the user's own OpenCode install — proven, not suspected ([the contract](opencode_contract.md) §4). Replying `once` persists nothing there, so the desktop keeps the rule beside the agent it was granted for and answers a matching ask with `once`.

Three obligations fall on this slice, and each is a lie to the user if dropped:

- **The runner's engine door downgrades any stray `always` to `once`, loudly.** The conversion happens on the answer path; this is the second lock on the same rule, because a caller that settled a request with `always` some other way would write that user-global row and nothing in a test against the HTTP fake would notice
- **The transcript says what was actually decided.** The engine's `permission.v2.replied` reports `once`, so `permissionDecisionText` takes a `remembered` flag from the desktop's own knowledge: "Allowed, and remembered for this agent." only where the rule reached disk, "Allowed once." otherwise. An `always` arriving from another client on the same `opencode serve` reads "Allowed, and remembered **by the engine**." — that grant will authorise every folder agent and must not be recorded as if it were scoped to one
- **An auto-answered ask writes nothing.** `TurnStream` consults the grant predicate *before* it creates a message state, so no part, no first-owner entry and no registry entry exist for it. A block that appeared and answered itself milliseconds later would be a widget the user cannot act on, mid-stream

Because an auto-answered ask has no registry entry, it also has no park timer — so the runner retries the automatic reply once and then posts `reject` rather than letting a lost reply hold the turn to the ceiling. The rest of the model is [Local Agent Permissions](permissions.md).

## Architecture Overview

```
User types in a folder-agent chat
  │
Renderer ── window.api ──▶ ipcMain.on('agent:send-message')   [thin controller]
  │                          │ persist the user message (shared path)
  │                          │ resolveTurnRunner(agent)  ── on agents.source
  │                          ▼
  │                        a2aStreamingService.streamToAgent  [direct-chat wrapper,
  │                          │                                 runner-agnostic]
  │                          ▼
  │                        AgentTurnRunner.runTurn(input) ──────┐
  │                          │                                  │
  │            LocalAgentTurnRunner                   A2ATurnRunner → runAgentTurn
  │                          │                                  (unchanged)
  │      ┌───────────────────┴───────────────────┐
  │      │ gate: exists / enabled / readiness    │
  │      │ ensureRunning  (BEFORE the lock)      │
  │      │ agentKey                              │
  │      │ ── withLock ────────────────────────  │
  │      │    open or resume session             │──▶ POST /api/session
  │      │    subscribe ── EngineEventBus ───────│◀── GET  /api/event   (global SSE)
  │      │    await ready()                      │
  │      │    POST prompt  → admission ack       │──▶ POST /api/session/{id}/prompt
  │      │    TurnStream.apply(event) per event  │
  │      │      ├─ cumulative message ──▶ StreamPartsAccumulator ──▶ onEvent sink
  │      │      ├─ asked   ──▶ pendingRequests.register
  │      │      │              (asked.auto ──▶ autoAllow, nothing rendered)
  │      │      ├─ settled ──▶ pendingRequests.drop
  │      │      └─ idle / error ──▶ settle
  │      │    heal on reconnect ─────────────────│──▶ GET /api/session/{id}/event?after=
  │      └───────────────────┬───────────────────┘
  │                          ▼
  │                   RunAgentTurnResult { text, parts, notices, contextId, error? }
  │                          │ persist assistant row + notices, save the session
  ◀── MessagePort ───────────┘ post `done`, close the port

Out of band, while the turn streams:
Renderer ── agent:pending-requests (poll) ──▶ pendingRequests.listForChat
Renderer ── agent:answer-request   ────────▶ pendingRequests.resolve
                                              → runner POSTs the reply to the engine
```

## Integration Points

- [The Local Engine, Runtimes & Prompt Assembly](engine.md) — supplies everything this slice consumes: `ensureRunning` as the config choke point, `agentKey()` and the skip reasons, the single request door, and the global lock predicate that keeps the engine from restarting mid-turn
- [The OpenCode Engine Contract](opencode_contract.md) — what is actually known about the endpoints and events this slice speaks, and what is not
- [Local Agent Permissions](permissions.md) — what an ask can be about in the first place, and where a standing grant lives. This slice owns the parking and the reply; that one owns the decision and the store
- [Agents Home, Scanner & Folder Index](folder_index.md) — the `enabled` flag this runner gates on, the readiness values it refuses, and the per-agent turn lock
- [Agents Tab & Agent Page](agents_tab.md) — the chat controls that were rendered disabled until this phase landed
- [Ask User Question](../../chat/ask_user_question/ask_user_question.md) — the existing tool-part convention that permission and question blocks follow
- [Orchestrated Agents](../../chat/orchestrated_agents/orchestrated_agents.md) — the second call site of the resolver; a folder agent works as an orchestrated tool with no change of its own, because the runner matches the primitive's signature
- [Agents (A2A streaming)](../agents/agents.md) — the direct-chat wrapper, the parts accumulator and the session table this slice reuses whole

## What is not verified

This project's honesty convention applies: coverage is named, not implied.

**Every test in `agentTurn/**` runs against a fake at the HTTP boundary.** The real event bus, the real turn stream, the real parts accumulator and the real pending-request registry are wired together — what is replaced is the socket to `opencode` and the three things that need a database or a disk. That split is deliberate, because every defect this slice can still have is a defect of *sequence*, and a test that stubs the bus can see none of them.

Real turns have since been run against the binary with a live credential, and the fakes were corrected wherever they disagreed with it. Two things the binary contradicted outright were things the fakes had implemented **faithfully from the OpenAPI document** — `session.idle` and `POST …/wait`. A fake can only ever be as right as the contract you believed when you wrote it, which is the argument for [the contract document](opencode_contract.md) existing at all.

Named gaps, beyond [`opencode_contract.md` §7 "Still unverified"](opencode_contract.md#7-still-unverified) which covers the engine-side ones:

- **A turn has never been watched through a real reconnect.** The heal path is tested end to end against a fake that drops and restores a stream, but the durable stream's own field set on a replayed event has not been observed. If it can omit the message id, a block is filed under a second identity and the whole answer duplicates into the transcript — which is why the turn stream remembers the first owner of a stream id rather than trusting the event. That defence now covers tool events as well as text, which is **hardening against this unverified field set, not a repair of anything seen**: no duplicated tool block has ever been observed, but tool events are replayed by the heal path exactly as text is, and defending only one of the two was an asymmetry a reader would misread as the question being settled
- **Whether a sequence number from the global stream is a valid cursor on the per-session stream** is the highest-value target for the next probe, and being wrong is silent. See §7 item 1
- **Which `finish` values actually occur**, beyond the two observed. The code is built to be terminate-by-default so an unknown value ends the turn rather than hanging it, and the runner logs a per-turn count of every event type it saw so the question can be answered from a user's log rather than another probe session
- **Where a permission or question falls relative to the text stream** — whether one can arrive before the first text, and how a parked request interleaves with deltas. See §7 item 5
- **The independent mutation audit has now been run** (3 September), which closes the gap this bullet used to record. 45 mutations against the three core test files, **13 survivors, all fixed** — each with an adversarial input added and the same mutation re-run afterwards to confirm it then fails a named test. A further 13 survivors were **deliberately left uncovered**: each is shielded by a second mechanism, so no input separates the code from its absence and a test there would pass against the code's absence. Each is recorded in its file with the reason and an explicit note that the guard is still load-bearing. What the audit did *not* do is change the picture above: it hardened the tests, not the engine contract, and every one of them still runs against a fake at the HTTP boundary
- **The shape of what it found is worth more than the count.** Of the 13 fixed, **three** were a test named for a contract whose branch it never executed, **nine** were plain holes with no test and no claim at all, and **one** was a guard reachable only across a seam. The sharpest defect of the audit was in the *plain holes* group — a failed engine POST was swallowed, so the turn hung to the ceiling with nothing shown. The sophisticated failure mode is the one that fools a reader; it is not the one that produced the worst consequence

Two things carry an explicit *honest note* in the source rather than a test, and both say so at the line: the assertion behind the stream-ready promise is currently unreachable and is kept as defence behind the fix that made it so, and the SSE comment-line skip is behaviourally redundant under the current field split and is kept as an explicit statement of the rule. Neither has a test, and neither should get one that claims to cover it.
