# Session Telemetry — model, tokens, cost, cache, context and login of a local agent's session

## Purpose

A chat with a local Claude or Codex agent spends tokens and money, fills a context window, keeps a prompt cache warm or lets it go cold, and runs on some login. Session telemetry collects what the runtime reports about each of those, per chat and per assistant turn, keeps it across restarts, prices what the runtime does not, and hands it to the renderer. It is collection only: the one place it is shown today is the verbose message popup. The session badge that will present it comes later and reads this model, the read-time derivations beside it and the on-demand context measurement.

Without it the runtime's usage reports were thrown away on arrival. `usage_update` was read only as the end marker of a turn the agent started itself, the prompt response's `usage` was read by nothing, and a user who wanted to know what a chat cost, which model actually answered or how full the context was had to open a terminal and ask the CLI.

## Core Concepts

- **Session telemetry** — one document per chat (`src/shared/sessionTelemetry.ts`): the engine, the login kind, the model (selected and resolved), the context reading, totals (tokens, cost, turns, per model, per ACP session), the prompt cache's clock and what Claude's `system/init` said about the runtime. It covers **every ACP session the chat had**, not only the current one
- **Message telemetry** — what one assistant turn used: its model, tokens, token scope, cost and where the cost came from, the number of model requests, wall-clock and API time, and the context used after it. Saved on the turn's last assistant row
- **Token tally** — uncached input, output, cache reads and cache writes, kept apart because they are priced apart
- **Token scope** — how much of the turn the counts cover. `turn`: every request, subagents and compaction included. `last_request`: only the turn's last model request, so a lower bound — a Codex turn whose running total could not be measured (see Known limits). `none`: the runtime reported no tokens; cost only, if any
- **Selected vs resolved model** — *selected* is what the session's model option says, an alias for Claude (`default`, `opus`). *Resolved* is what actually answered: for Claude, named by the runtime's `system/init` before the first request goes out (from turn 0), and again by each main-agent request; for Codex, read off the turn's usage at its end
- **Raw SDK stream** — Claude's own SDK messages, which the adapter forwards as `_claude/sdkMessage` notifications when a session asks for them. The desktop asks for four kinds — `system/init`, `system/compact_boundary`, `assistant` and `result` — and reads each frame down to a handful of numbers and ids. They carry the turn's content again; **no frame is logged, stored or put in the transcript whole**
- **Main-agent request** — one model request of the session's own agent: the first raw `assistant` frame of a message id, from a frame that names no parent tool call. A subagent's frames are counted as traffic and read for nothing else
- **Running total** — a figure the runtime reports as the session's cumulative value, not the turn's: Claude's cost (`usage_update.cost.amount`), its per-model cost (`result.modelUsage[m].costUSD`) and its API time (`result.duration_api_ms`), and Codex's token total (`_meta.quota.total_token_count`, added by the reviewed adapter patch). A turn's figure is always what the total grew by
- **Cost source** — `runtime` when the runtime reported the cost (Claude), `estimated` when the desktop priced the tokens itself (Codex)
- **Price table** — `src/shared/modelPricing.ts`: list prices per model, with the date they were checked and their sources. The only place a price lives
- **Prompt cache clock** — when the last main-agent request went out, the cache's time-to-live, when it expires, and whether something invalidated it first. Claude only: Codex caches on its own with a TTL nobody reports
- **Context reading** — `used` and `size` from the session's own `usage_update`s, mid-turn as well as at the end. **Size authoritative** says whether `size` is the model's real window or the adapter's guess
- **Coarse context split** — `baseline` (the whole input of the session's first main-agent request: system prompt, tools, memory, the first message) and `conversation` (what has been added since). Claude's raw stream only
- **Context categories** — the main agent's context measured by category (system prompt, tools, memory files, MCP tools, skills, messages…), on demand, between turns, through the reviewed Claude adapter patch's `_cinna/contextUsage`. Where present it supersedes the coarse split
- **Read-time derivations** — warm or cold cache, the price of the next message's pre-context, the current model's prices, the cache hit ratio (`src/shared/sessionTelemetryDerived.ts`). Computed where they are shown, never stored, because they change with the clock
- **Login kind** — `subscription`, `api_key`, `gateway`, `cloud`, `none` or `unknown`, with a label and plan name. **Never the account**
- **Reporter** — the port a driver gets (`SessionTelemetryReporter`). The driver reports changes; what it reads back is a session's last running-total readings (cost, per-model cost, Codex token total)

## User Stories / Flows

### A turn is counted
1. The user sends a message to a Claude or Codex folder agent. For Claude, the runtime's `system/init` names the model that will answer, the CLI version, betas, effort and fast mode before any request goes out, and the telemetry takes them at once
2. While the turn runs, each main-agent request moves Claude's cache clock and fixes its TTL, and each `usage_update` of the agent's own session moves the chat's context reading. Every change is pushed to the window
3. The prompt answers. The turn's tokens come from the response (Codex: from how far its running total grew), its cost from what the costed `usage_update` added to the session's total (Codex: priced from the table), its duration from the prompt going out to the answer. Claude's raw `result` adds the per-model cost, the model's real window and maximum output, the request count and the API time
4. The turn is added to the chat's totals once, and its figures are saved on the turn's last assistant row
5. In verbose mode, that row's info popup lists a `telemetry` block — model, tokens with their scope, cost, requests, duration and API time — above the parts

### The agent answers on its own
1. A background shell ends and Claude starts a [follow-up turn](../local_agents/agent_turn.md#a-turn-the-agent-starts-on-its-own-is-a-follow-up-turn)
2. There is no prompt response. The raw frames the follow-up gate held from the trigger on are replayed into the turn, so its requests move the cache clock and its raw `result` gives its tokens. The costed `usage_update` that ends the turn gives its cost
3. The turn counts once in the totals. Only when no raw `result` reached it do its tokens read *not reported (follow-up turn)*

### The app restarts mid-chat
1. The chat's telemetry is read back from the database the first time something asks for it
2. The next turn resumes the session with `session/load`. Every running total is measured against the last reading the chat saved for that session — Claude's cost and per-model cost, Codex's token total — so the history the runtime restored is not counted again
3. That turn's API time is left unknown: it is kept in memory only, so there is nothing to measure it against

### Something asks how the context is made up
1. A view of the chat calls `measureContext` (the hook's second member). Nothing asks on its own; each measurement is one request to the provider
2. If the chat's Claude process and session are live, idle and have answered a prompt in this process, the adapter measures the context by category and the result reaches the window through the ordinary push
3. Otherwise the answer is a code — `busy`, `not_ready`, `not_running`, `unsupported` or `failed` — and nothing is started to make it possible

## Business Rules

### Counting
- **Totals come only from finished turns, one report per turn.** A context reading, a request or a runtime report never adds to them, so a frame seen twice, or replayed, cannot count twice. `session/load` replay frames are dropped before they reach telemetry
- **A cancelled turn counts** when the prompt still answered. The tokens were spent
- **A turn with neither tokens nor cost reports nothing.** It still counts as a run of the chat; it does not count as a telemetry turn
- **Subagents count in the totals, never in the context, the model or the cache.** Claude's per-model rows include subagents and compaction and feed the per-model totals. The resolved model, the cache clock and the context split follow the main agent only, and a child session's `usage_update` never moves the chat's context, because a subagent's context is not this one's
- **The main model among the rows** is the one whose canonical id (date and bracket suffix stripped) matches the selected model; failing that, the one that read the most input, since a subagent on a smaller model reads less
- **One request is one message id.** A streamed message arrives as one raw frame per content block, each repeating the same input usage; only the first is a request
- **Once any turn covered only its last request, the totals are marked a lower bound** (`last_request`) and stay so
- **A nested turn** (an agent called as a tool inside another turn) reports nothing to the chat's totals. Its result still carries its own figures

### Running totals
- **A turn's figure is what the total grew by**, measured against the previous reading for the same session: this process's, else the one the chat saved. Measuring from zero after a restart would count the whole restored history as the first turn
- **A reading that dropped, or one with no earlier reading anywhere, is taken whole**: the session's total started over. Codex compares field by field; any field that fell means it started over
- **Except a restored Codex session with no saved total.** The CLI restores its token total when a session is loaded into a new process — watched against the pinned CLI (`codex.session.quota-total-on-resume`) — so a chat whose telemetry predates the running total has no baseline, and its first reading is the whole history. That turn keeps its last request instead, scope `last_request`: an undercount, preferred to charging the history to one turn
- **API time is measured only within one process.** It comes from the same cumulative ledger as the cost, but is not saved; a session this connection created starts at zero, and one loaded into a new process has no API time on its first turn
- **The first Claude turn on a resumed session takes its tokens from the main loop only.** The adapter restarts its per-model baseline when it builds a session object over a restored history: a `session/load` on a new process, or one under a different cwd or MCP server set (a connector switched on or off), which the adapter answers by rebuilding the session. That turn's per-model rows are the session's whole history. The main-loop `usage` is an undercount (subagents and compaction missing) and is preferred to a double count

### Cost
- **Claude's cost is the runtime's**, and so is its split by model. Its per-model rows name the price basis the CLI used; only `list` rows are compared with the table
- **Codex's cost is estimated from the price table**, because the runtime reports none. It is a lower bound while its tokens are the last request's. The long-context tier is judged by one request's input — the last request's — never by the turn's sum, which would put every multi-request turn in the higher tier
- **An unknown model has no price.** No nearest match, no family guess: a price that is wrong looks exactly like one that is right, and the answer is "price unknown" instead
- **A partner cloud is never estimated.** Bedrock and Vertex price differently from the list; a `cloud` login gets no estimate, per turn or next-message
- **The table is checked against Claude's runtime cost every turn.** A model whose list-price estimate drifts more than 5% from what the runtime charged is logged once per model per process, naming the model and the two figures. A stale table shows up in the logs, not silently in the UI. Not checked on a resumed session's first turn (its rows are not the turn's) or for a row the CLI priced other than at list

### Prices (`modelPricing.ts`)
- **Dated and sourced.** `PRICES_CHECKED_AT` records the day the table was compared with Anthropic's and OpenAI's (Standard tier) published pricing pages; the sources are named in the file. Updating a price means updating that date
- **Keyed by a canonical id**: lowercased, without a bracketed variant (`[1m]`), a Vertex `@…` version, a Bedrock region and `anthropic.` prefix and `-v1:0` suffix, or a trailing date
- **OpenAI's long-context tier** applies above 272K input tokens, where it exists; cache writes in a tier scale with its input price. OpenAI has no cache-write price, so a write is charged as input
- **A premium the table does not model means no price**: Sonnet 4.5 and 4 above 200K input
- **Fast mode** has its own input and output prices, and the caching multipliers apply on top of the fast input price. A model with no fast prices, in fast mode, has no price

### Prompt cache (Claude)
- **The TTL is read off the writes.** A main-agent request that wrote to the 1-hour cache makes it 1h, one that wrote to the 5-minute cache 5m; a request that wrote nothing keeps the last one seen; until one is seen, 5m is assumed and marked `assumed`
- **The expiry is the last main-agent request plus the TTL**, and it is approximate: the TTL runs from when the request reached the API, and the clock is when its first frame reached this app, a little later
- **Without the raw stream the `usage_update` readings are the clock.** Once a turn has timed its requests from the raw stream, its readings no longer move it
- **Four things make the cache cold before its TTL runs out**, each recorded with its reason: a switch of the selected model (nothing the old model wrote is read by the new one), a new session, a session loaded under other params (the adapter rebuilt it with another system prompt and tool list), and a compaction. The cache is cold until the next request writes it again
- **Codex has no TTL, no expiry and no invalidation.** Its cache state is always unknown

### Context
- **Every reading of the session's own `usage_update`s moves it**, mid-turn included
- **Codex's size is authoritative from the start.** Claude's is the adapter's guess until the first costed reading of that session and model corrects it, or the raw `result` names the main model's window, which also gives its maximum output
- **A size proven for one session or one model proves nothing about another.** A reading from another session, or a switch of the selected model, makes the size a guess again
- **A switch of the selected model forgets what answered.** The resolved model clears until the next report names one
- **The coarse split starts over only with a new session or a compaction**: the next main-agent request's whole input is the new baseline. After a model switch or a reload under other params the conversation is the same one, so the split stands. Codex has none
- **Context categories are measured only on demand, and only for Claude.** They stand, dated and tied to their session, until measured again. A new session or a compaction drops them (the context they describe no longer exists), and so does a reading from another session. A measurement of a session the context has since moved off is not kept

### Measuring the context on demand
- **It never starts, reserves or holds anything.** It asks the process and session the chat's last turn left live, or answers `not_running`
- **Never while a turn runs.** A turn or follow-up in the chat answers `busy`; so does a turn that started while the request was out, whose answer would describe the context before that turn and is discarded rather than saved as current. The adapter refuses a running or queued turn itself as well
- **Never before the session's first answered prompt in this process** (`not_ready`): asked then, the runtime stalls on the request for tens of seconds. A turn that begins taking the session clears the flag until its prompt answers, so one that failed before its answer (a reload under other params, a fresh session) does not leave a stalling session measurable
- **Each measurement costs a provider request.** The CLI counts the tokens with the provider's `POST /v1/messages/count_tokens` — not a Messages request, but not free of the network either — which is why nothing measures on its own
- **One measurement per chat at a time**; a second ask while one is out shares its answer. Past 30 seconds the measurement is given up as `failed`
- **The answer is only whether it was taken.** The measurement itself arrives through the push, like every other change
- **Claude only.** A Codex chat answers `unsupported`. An adapter that does not know the request refuses it, which reads as `failed`

### Read-time derivations
- **Warm or cold is computed, never stored.** Claude: unknown before any request; cold after an invalidation no request has followed, or past the expiry; else warm until the expiry. Codex: always unknown
- **The next message's estimate prices the pre-context only**: the context used, as the first request of the next turn reads it, without the new message. A turn with tool calls re-reads the context once per request and costs a multiple of it, and the estimate says so
- **Claude gets two figures**: warm (read from cache) and cold (written to cache at the observed TTL's write price), with the moment warm turns cold. **Codex gets one**: the whole context at the uncached input price, an upper bound, since its own caching usually makes it cheaper
- **On a subscription the figure is API-equivalent**: what counts against its limits, not money paid. A cloud login, an unknown model and an empty context get a note and no figure

### Runtime
- **Claude's `system/init` fills the runtime block**: CLI version, betas, effort (null when none is sent) and fast mode. Fast mode chooses the prices
- **Its `apiKeySource` can say an API key paid**, and that refines an `unknown` login to `api_key`. It never replaces a login the adapter reported

### Login
- **Only the kind, a label and the plan name are kept.** Claude's `_auth/status_update` carries the account's email and organisation beside them, unasked. Anything email-shaped is scrubbed out of the label and plan, so a future adapter that puts the account in the label still does not pass it on
- **Claude says it over ACP; Codex does not.** Claude's notification names no session and arrives right after `initialize`, so it is heard per connection and read when a turn ends. For Codex the login comes from the CLI's own `codex login status` line (ChatGPT is a subscription, an API key is one), read beside the turn and never holding it up
- **The latest report wins**
- **A login that is not the install's own subscription is also said in the transcript**, once per chat per process and login, not on every turn. See [The Claude Engine](../local_agents/claude_engine.md#a-turn-that-did-not-run-on-the-users-own-login-says-so-where-the-user-is)

### What is never kept
- **Raw frames are read into numbers and ids**; their content, which repeats the turn, reaches the transcript the usual way and nowhere else
- **A session's setup params are kept only as a digest**: the cwd and MCP servers can hold secrets (server env and headers), and only the fact that they changed matters
- **Memory-file paths in a context measurement are the user's own** and may name their home directory: they are shown, never logged. A failed measurement logs its code only

### Where it goes
- **Telemetry never fails a turn.** A report that throws is logged; a write that fails keeps the in-memory state
- **The message row gets the turn's figures on its last assistant row.** When the turn's last slice is empty — it ended on a steer, or everything was already saved — the figures go onto the last assistant row saved for the turn. With no assistant row at all they are dropped from the transcript; the chat's totals already have them
- **A turn's tokens are also its [outcome's usage](../../chat/messaging/turn_completion.md)**: input is uncached plus cache reads plus cache writes. A turn that reported no tokens has no usage, never zero
- **Only the active profile's chats reach the window**, and nothing while the [activation gate](../../core/resource_activation/resource_activation.md) is closed. A chat of another profile, or one in the trash, answers `chat_not_found` as data — to a read and to a measurement alike
- **Trashing or deleting a chat forgets its telemetry**, row included, along with its sessions. A late report for a trashed chat is dropped, not written back. A chat restored from the trash starts without telemetry
- **Nothing changes, nothing is written or pushed.** A report that leaves the state as it was (a repeated model report) is silent

## Known limits
- **A Codex turn is a lower bound when its running total could not be measured**: an adapter answer without `total_token_count`, or the first turn of a restored session whose chat saved no total
- **A follow-up turn has no tokens when no raw `result` reached it**; Codex follow-ups, never seen live, would have none
- **API time is unknown on a session's first turn in a new process**
- **Claude's cost handling rests on the readings being running totals**, read from the adapter and CLI source. If a pinned adapter starts reporting per-result cost instead, `costDelta` is the one place to change
- **A `session/load` the adapter answers by recreating a live session is not seen as a resume**, so that turn's per-model rows are trusted as they are
- **The price table goes stale with the vendors' pages**; the calibration log catches Claude drift, nothing catches OpenAI drift
- **Presented nowhere but the verbose popup.** No component reads the hook, the derivations or the measurement yet; the rate-limit payload is kept raw and read by nothing; per-session totals are kept and not shown
- **OpenCode, command-line agents, remote A2A agents and Managed sessions report nothing**

## Architecture Overview

```
Claude adapter ── _claude/sdkMessage (init, assistant, result, compact) ──► readSdkMessage ──► TurnTelemetry.sdk
               ── usage_update / config_option_update ──► AcpMessageStream ──► TurnTelemetry.frame / model
               ── session/prompt answer (usage, _meta.quota[.total_token_count]) ──► TurnTelemetry.answered
               ── _auth/status_update (no session) ──► connection listener ──► TurnTelemetry.auth
codex login status ──► launcher.telemetryAuth ──────────────────────────────►      │
                                                                                   ▼
          modelPricing (Codex estimate, calibration) ◄── TurnTelemetry.settle ── one turn change
                                                                                   ▼
                        sessionTelemetryService (reducer, held + session_telemetry row)
                             │                            │                        ▲
             session-telemetry:changed        last readings (restart)     measureContext
                             ▼                                                     │
          useSessionTelemetry {query, measureContext} ── sessionTelemetry:measureContext
                             │                                  └─► acpDriver.measureContext ─► _cinna/contextUsage
                             ▼
          sessionTelemetryDerived (cache state, next-message estimate) — no consumer yet

TurnTelemetry.settle ──► RunAgentTurnResult.telemetry ──► a2aStreamingService
                              ──► messages.telemetry (last row) + TurnOutcome.usage
                              ──► MessageMetaFooter popup (verbose mode)
```

## Integration Points

- [The Agent Turn](../local_agents/agent_turn.md) — the ACP driver that observes the turn and settles its telemetry, including follow-up turns, whose gate holds the raw frames
- [The Claude Engine](../local_agents/claude_engine.md) and [The Codex Engine](../local_agents/codex_engine.md) — what each engine reports, where its login comes from, and the reviewed adapter patches the running Codex total and the Claude context measurement rely on
- [Runtime Pins](../../development/runtime_pins/runtime_pins_llm.md) and [Packaged Runtime Dependencies](../../development/distribution/packaged_runtime.md) — the adapter digests those patches are checked against, at install and at packaging
- [Session Activity](../session_activity/session_activity.md) — the sibling core service in the same shape: driver reports, service holds, IPC pushes. Activity is memory-only; telemetry is durable
- [Turn Outcomes](../../chat/messaging/turn_completion.md) — `TurnOutcome.usage` is filled from a turn's tokens
- [Verbose Mode](../../ui/verbose_mode/verbose_mode.md) — the message popup, the only surface today
- [Hub core](../../development/hub_core/hub_core_llm.md) — the service is core (`src/main/agents/telemetry/`); the IPC push is the desktop's
- Technical details: [Session Telemetry (tech)](session_telemetry_tech.md)
