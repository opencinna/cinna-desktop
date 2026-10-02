# Session Telemetry — model, tokens, cost, cache, context and login of a local agent's session

## Purpose

A chat with a local Claude or Codex agent spends tokens and money, fills a context window, keeps a prompt cache warm or lets it go cold, and runs on some login. Session telemetry collects what the runtime reports about each of those, per chat and per assistant turn, keeps it across restarts, prices what the runtime does not, and shows it in two places: the **mode badge's popover** under the composer (the `Local` / `Direct` / `You route` pill) — how full the context is, and behind it what the chat has spent, the prompt cache, what the next message will cost and the prices it is charged at — and, per turn, the verbose message popup.

Without it the runtime's usage reports were thrown away on arrival. `usage_update` was read only as the end marker of a turn the agent started itself, the prompt response's `usage` was read by nothing, and a user who wanted to know what a chat cost, which model actually answered or how full the context was had to open a terminal and ask the CLI.

## Core Concepts

- **Session telemetry** — one document per chat (`src/shared/sessionTelemetry.ts`): the engine, the login kind, the model (selected and resolved), the context reading, totals (tokens, cost, turns, per model, per ACP session), the prompt cache's clock and what Claude's `system/init` said about the runtime. It covers **every ACP session the chat had**, not only the current one
- **Message telemetry** — what one assistant turn used: its model, tokens, token scope, cost and where the cost came from, the number of model requests, wall-clock and API time, and the context used after it. Saved on the turn's last assistant row
- **Token tally** — uncached input, output, cache reads and cache writes, kept apart because they are priced apart
- **Token scope** — how much of the turn the counts cover. `turn`: every request, subagents and compaction included. `last_request`: only the turn's last model request, so a lower bound — a Codex turn whose running total could not be measured (see Known limits). `none`: the runtime reported no tokens; cost only, if any
- **Selected vs resolved model** — *selected* is what the session's model option says, an alias for Claude (`default`, `opus`). *Resolved* is what actually answered: for Claude, named by the runtime's `system/init` before the first request goes out (from turn 0), and again by each main-agent request; for Codex, read off the turn's usage at its end
- **Raw SDK stream** — Claude's own SDK messages, which the adapter forwards as `_claude/sdkMessage` notifications when a session asks for them. The desktop asks for four kinds — `system/init`, `system/compact_boundary`, `assistant` and `result` — and reads each frame down to a handful of numbers and ids. They carry the turn's content again; **no frame is logged, stored or put in the transcript whole**
- **Main-agent request** — one model request of the session's own agent: the first raw `assistant` frame of a message id, from a frame that names no parent tool call. A subagent's frames are counted as traffic and read for nothing else
- **Running total** — a figure the runtime reports cumulatively, not per turn: Claude's cost (`usage_update.cost.amount`, the SDK's `total_cost_usd`), its per-model cost (`result.modelUsage[m].costUSD`) and its API time (`result.duration_api_ms`), each cumulative **within one adapter query**; and Codex's token total (`_meta.quota.total_token_count`, added by the reviewed adapter patch), cumulative over the session and restored on resume. A turn's figure is always what the total grew by
- **Fresh query** — the adapter starting a new Claude query for a session: `session/new`, a `session/load` of a session not live on the connection (a new process, the app restarted), or a load under a different cwd or MCP server set, which the adapter answers by rebuilding the session. Every Claude running total starts from 0 with it
- **Cost source** — `runtime` when the runtime reported the cost (Claude), `estimated` when the desktop priced the tokens itself (Codex)
- **Price table** — `src/shared/modelPricing.ts`: list prices per model, with the date they were checked and their sources. The only place a price lives
- **Prompt cache clock** — when the last main-agent request went out, the cache's time-to-live, when it expires, and whether something invalidated it first. Claude only: Codex caches on its own with a TTL nobody reports
- **Context reading** — `used` and `size` from the session's own `usage_update`s, mid-turn as well as at the end. **Size authoritative** says whether `size` is the model's real window or the adapter's guess
- **Coarse context split** — `baseline` (the whole input of the session's first main-agent request: system prompt, tools, memory, the first message) and `conversation` (what has been added since). Claude's raw stream only
- **Context categories** — the main agent's context measured by category (system prompt, tools, memory files, MCP tools, skills, messages…), on demand, between turns, through the reviewed Claude adapter patch's `_cinna/contextUsage`. Where present it supersedes the coarse split
- **Read-time derivations** — warm or cold cache, the price of the next message's pre-context, the current model's prices, the cache hit ratio (`src/shared/sessionTelemetryDerived.ts`). Computed where they are shown, never stored, because they change with the clock
- **Login kind** — `subscription`, `api_key`, `gateway`, `cloud`, `none` or `unknown`, with a label and plan name. **Never the account**
- **Reporter** — the port a driver gets (`SessionTelemetryReporter`). The driver reports changes; the one thing it reads back is a Codex session's last running token total
- **Context row** — the last row of the chat's mode badge popover (the router badge under the composer, `RouterBadge`), below the routing or connection details and a hairline: `Context` and `46K | 15% Mid budget | 6% total` (used tokens, the share of the [AI spending level](../../llm/ai_spending_level/ai_spending_level.md)'s budget, the share of the whole window). A disclosure: collapsed by default, it opens the **session details** above itself
- **Engine capability tables** — `CACHE_TTL_KNOWN`, `CACHE_WRITES_REPORTED` and `CONTEXT_CATEGORIES_KNOWN` (`src/shared/sessionTelemetry.ts`): per engine, whether it reports a cache TTL, whether it reports cache writes at all, and whether its context can be measured by category. Claude yes to all three, Codex no. The popover hides what an engine cannot report, and the driver refuses a measurement, from the same tables, so the two cannot drift

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
2. The next turn resumes the session with `session/load`. For Claude that is a fresh query: its cost, per-model cost and API time start from 0, so the turn is measured from 0 and its cost, API time and per-model rows are its own
3. Codex restores its running token total with the session, so its first turn is measured against the total the chat saved, and the restored history is not counted again

### The user checks on the session
1. After the chat's first reported turn, hovering or focusing the chat's mode badge (`Local`, `Direct`, `You route`, …) shows, below its routing or connection details, a collapsed **Context** row: the used tokens, the share of the spending level's budget and the share of the window, `84.2K | 53% Mid budget | 42% total` (at Greedy, or while the window size is not confirmed, `84.2K | 42% total`; just `84.2K` with no known window size), and a chevron pointing up
2. Clicking the row (or Enter/Space) opens the session details above it and turns the chevron down; clicking again folds them. The choice holds while the chat stays open, across the popover closing, and resets on another chat. The details read top to bottom: the model that answered (else the selected one, else *Model not reported yet*) and the login in words (`Claude Max`, `API key`, `Gateway · …`); **Context**; **Spent in this chat**; **Cache** (Claude only); **Next message**; **Prices** (only when the table knows the model); and, in verbose mode only, a raw runtime block — CLI version, effort, fast mode, betas and the rate-limit payload as the runtime sent it
3. **Context** shows `used of size (percent)`, marked *size not confirmed yet* while the size is the adapter's guess. Under it, the measured categories largest first with the window's free room as a note, else Claude's coarse setup-and-conversation split. Once measured, its heading says *counted by the provider … ago*
4. **Spent in this chat** lists input, output, cache reads, cache writes (Claude only), turns, the session cache-hit ratio and the cost, followed by at most one muted qualifier: *estimated*, *at least*, *API-equivalent*, comma-joined. With no cost reported it says so
5. **Cache** shows Warm (with *cold in m:ss*, counting down each second), Cold or Unknown, and the TTL; a TTL under an hour is qualified *observed* or *assumed* (no write has shown one yet)
6. **Next message** shows Claude's cache-warm and cache-cold prices and the time the warm price ends, or Codex's one uncached figure marked *at most*; where there is no figure, one line says why (cloud pricing, price unknown for the model, price unknown in fast mode, no context yet)
7. **Prices** shows the current model's per-MTok input, output, cache-read and (Claude) cache-write prices at the 5-minute and 1-hour TTLs, a note for fast mode or the long-context rate, and the date the table was checked

### The user measures the context
1. On a Claude chat the details' Context heading carries a **Measure** action. Pressing it reads *Measuring…* in the same space until the answer comes
2. A measurement taken arrives through the push and replaces the split with the categories
3. A refusal is one line at the end of the section: *The agent is working — measure when the turn ends* (`busy`), *Available after the agent's first reply in this session* (`not_ready`), *The agent's process isn't running — send a message first* (`not_running`), and, in the danger tone, *The agent didn't answer the measurement* (`failed`) or *The context couldn't be measured* (anything else). It clears on the next attempt and when the details are folded or the popover closes, and never carries into another chat
4. An `unsupported` answer is not a failure to retry: Measure disappears for that agent session, across popover closes, and *This agent can't report a breakdown* takes its place. A new session brings it back

### Something asks how the context is made up
1. The popover's Measure calls `measureContext` (the hook's second member). Nothing asks on its own; each measurement is one request to the provider
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
- **A turn's figure is what the total grew by**, measured against the previous reading for the same session on the same connection
- **Claude's running totals start from 0 with every fresh query, and nothing of Claude's is saved to measure against.** Cost, per-model cost and API time are cumulative within one adapter query only; a restart followed by `session/load` does not restore them. So on a fresh query the connection's readings for the session are set to 0, and that turn's cost, API time and per-model rows are its own. An earlier design assumed the CLI restored its cost on resume and measured the first turn after a restart against a saved reading, and took that turn's tokens from the main loop only, believing its per-model rows were the whole history. A billed live probe (2026-09-30, Claude Code 2.1.276, adapter 0.76.0) showed every total starting at 0 and the rows being the turn's own: the saved reading would have been subtracted from a figure that never contained it, reporting such a turn as costing nothing. Rows written under that design still carry the old readings; they are read by nothing and dropped on the session's next write
- **A reading that dropped, or one with no earlier reading, is taken whole**: the total started over. That also covers the adapter's rebuilds nobody sees (a signed-out query, a provider update). Codex compares field by field; any field that fell means it started over
- **Codex's token total, unlike Claude's, survives a restart.** The CLI restores it when a session is loaded into a new process — watched against the pinned CLI (`codex.session.quota-total-on-resume`) — so the chat saves the last total per session and the first turn after a restart is measured against it. A chat whose telemetry predates the running total has no baseline, and its first reading is the whole history. That turn keeps its last request instead, scope `last_request`: an undercount, preferred to charging the history to one turn
- **API time is never saved.** It is measured on the connection that took the readings; a fresh query starts it at 0, so it is known from a session's first turn

### Cost
- **Claude's cost is the runtime's**, and so is its split by model. Its per-model rows name the price basis the CLI used; only `list` rows are compared with the table
- **Codex's cost is estimated from the price table**, because the runtime reports none. It is a lower bound while its tokens are the last request's. The long-context tier is judged by one request's input — the last request's — never by the turn's sum, which would put every multi-request turn in the higher tier
- **An unknown model has no price.** No nearest match, no family guess: a price that is wrong looks exactly like one that is right, and the answer is "price unknown" instead
- **A partner cloud is never estimated.** Bedrock and Vertex price differently from the list; a `cloud` login gets no estimate, per turn or next-message
- **The table is checked against Claude's runtime cost every turn.** A model whose list-price estimate drifts more than 5% from what the runtime charged is logged once per model per process, naming the model and the two figures. A stale table shows up in the logs, not silently in the UI. Not checked for a row the CLI priced other than at list

### Prices (`modelPricing.ts`)
- **Dated and sourced.** `PRICES_CHECKED_AT` records the day the table was compared with Anthropic's and OpenAI's (Standard tier) published pricing pages; the sources are named in the file. Updating a price means updating that date
- **Keyed by a canonical id**: lowercased, without a bracketed variant (`[1m]`), a Vertex `@…` version, a Bedrock region and `anthropic.` prefix and `-v1:0` suffix, or a trailing date
- **OpenAI's long-context tier** applies above 272K input tokens, where it exists; cache writes in a tier scale with its input price. OpenAI has no cache-write price, so a write is charged as input
- **A premium the table does not model means no price**: Sonnet 4.5 and 4 above 200K input
- **Fast mode** has its own input and output prices, and the caching multipliers apply on top of the fast input price. A model with no fast prices, in fast mode, has no price for a turn and no next-message estimate (*Price unknown in fast mode*); the popover's Prices section still lists its base rates, flagged *fast-mode rate not listed*, because the base rate is a true floor and hiding it would hide the model's whole price list over one missing line

### Prompt cache (Claude)
- **The TTL is read off the writes.** A main-agent request that wrote to the 1-hour cache makes it 1h, one that wrote to the 5-minute cache 5m; a request that wrote nothing keeps the last one seen; until one is seen, 5m is assumed and marked `assumed`. The live probe saw the pinned Claude Code write to the 1-hour cache, so the 5m assumption is a floor for the gap before the first request, not the usual case
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
- **Each measurement costs a provider request.** The CLI counts the tokens with the provider's `POST /v1/messages/count_tokens` — not a Messages request, but not free of the network either — which is why nothing measures on its own. Live, the first measurement in a session took about 0.7 s and later ones about 10 ms
- **One measurement per chat at a time**; a second ask while one is out shares its answer. Past 30 seconds the measurement is given up as `failed`
- **The answer is only whether it was taken.** The measurement itself arrives through the push, like every other change
- **Claude only** (`CONTEXT_CATEGORIES_KNOWN`). A Codex chat answers `unsupported`, and its popover offers no Measure. An adapter that does not know the request refuses it, which reads as `failed`

### Read-time derivations
- **Warm or cold is computed, never stored.** Claude: unknown before any request; cold after an invalidation no request has followed, or past the expiry; else warm until the expiry. Codex: always unknown
- **The next message's estimate prices the pre-context only**: the context used, as the first request of the next turn reads it, without the new message. A turn with tool calls re-reads the context once per request and costs a multiple of it, and the estimate says so
- **Claude gets two figures**: warm (read from cache) and cold (written to cache at the observed TTL's write price), with the moment warm turns cold. **Codex gets one**: the whole context at the uncached input price, an upper bound, since its own caching usually makes it cheaper
- **On a subscription the figure is API-equivalent**: what counts against its limits, not money paid. A cloud login, an unknown model and an empty context get a note and no figure

### The Context row in the mode badge
- **In the mode badge, not a badge of its own.** The router badge's popover carries it for any router, once the chat has telemetry; a chat without telemetry (an engine that reports none, or no turn yet) shows its routing card unchanged. With the row the popover is a `dialog` (it holds a control) and widens to `w-80`. The job pages' router badge has no chat and reads no telemetry
- **The row under the pointer never moves.** The popover hangs from the pill and grows upward, so the row stays its last row and the details open above it; the chevron points up when collapsed and down when open ([UX rule 1](../../development/ui_guidelines/ux_rules.md)). The popover stays open while the pointer or focus is inside it, through the toggle and Measure
- **The pill itself carries a context health line** when the reading's window size is authoritative: a 2 px line along its bottom edge filled to the share of the [AI spending level](../../llm/ai_spending_level/ai_spending_level.md)'s budget used, the Context row leads with the same share (`53% Mid budget`) and the Context section gains a `{Level} budget` row. A guessed size draws none of them. The budget, its colours and the one-time toast on crossing it belong to that feature
- **Collapsed by default.** Its state lives with the badge for the chat: it survives the popover closing and reopening, resets when the chat changes, and is not persisted
- **The row reads against the budget first, then the window.** The budget share comes first because it is the figure the health line under the pill draws; when the row showed only the window share, a `42%` row sat over a line more than half full and the two disagreed. The window share stays as `total`. The words and `|` separators are muted so the numbers lead
- **No budget part where it would say nothing or guess.** At Greedy the budget is the window, so the budget part would repeat `total`, and the expanded section has no *Greedy budget* row either (the line still draws). With the window size unconfirmed there is no budget at all, so the row shows used and `total` only
- **The budget share is not clamped.** Past the budget the row says `150% Eco budget` while the line stops full: the line is a gauge, the row is the reading
- **Named by what it shows.** The row's accessible name is the same figures as words, the separators read as pauses: *Context 84.2K, 53% Mid budget, 42% total* (*Context 84.2K, 42% total* at Greedy or with an unconfirmed size, *Context 84.2K* without a size), with `aria-expanded`. `<1%` for a share under half a percent of a context that is not empty; never a percentage without a known size
- **The details' sections keep their order and update in place.** A section an engine cannot fill is absent rather than empty: no Cache section and no cache-write rows or prices for Codex, no Measure where categories cannot be measured, no Prices section for a model the table does not know. A refusal is appended last in its section so it moves nothing above it
- **The details' clock runs only while they are shown.** The cache countdown ticks once a second; the ticking stops when they are folded or the popover closes
- **Measured categories are what is in the window.** The CLI's list also names the window's unused room (`Free space`) and the room held back for compaction (`Autocompact buffer`, `Compact buffer`); like the CLI's own `/context`, the popover counts neither as a row. Free space is a note under the rows, the buffer is not shown, and categories with no tokens or marked deferred are left out. The names are matched exactly, case-insensitively (`contextCategoryKind`)
- **"API-equivalent" is said in one place**: the cost qualifier, on a subscription
- **The list scrolls rather than leaving the window.** The details are capped at the smaller of 70% of the window and 36rem, and the whole popover at the room from the pill up to 8 px below the window's top edge; under that cap only the details shrink and scroll, with a stable scrollbar gutter so a growing section never shifts the rows

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
- **Claude's cost handling rests on the readings being running totals of the adapter's query**, observed live on one pinned version. If a pinned adapter starts reporting per-result cost, or starts restoring its totals on resume, `costDelta` and `TurnTelemetry.session` are the places to change; the contract does not watch it, because the fake provider reports no cost
- **A fresh query the adapter starts without being seen to** (a signed-out query, a provider update) is caught only when a reading drops. If the new query's total has already passed the old reading, that turn's cost and API time are undercounted by the old reading
- **The price table goes stale with the vendors' pages**; the calibration log catches Claude drift, nothing catches OpenAI drift
- **The rate-limit payload is shown only raw**, in verbose mode's runtime block; per-session totals are kept and not shown
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
             session-telemetry:changed    Codex token total (restart)     measureContext
                             ▼                                                     │
          useSessionTelemetry {query, measureContext} ── sessionTelemetry:measureContext
                             │                                  └─► acpDriver.measureContext ─► _cinna/contextUsage
                             ▼
          SessionTelemetryBlock ◄── sessionTelemetryDerived (cache state, next-message estimate,
        (in RouterBadge's popover)      current prices, hit ratio, category kind)

TurnTelemetry.settle ──► RunAgentTurnResult.telemetry ──► a2aStreamingService
                              ──► messages.telemetry (last row) + TurnOutcome.usage
                              ──► MessageMetaFooter popup (verbose mode)
```

## Integration Points

- [The Agent Turn](../local_agents/agent_turn.md) — the ACP driver that observes the turn and settles its telemetry, including follow-up turns, whose gate holds the raw frames
- [The Claude Engine](../local_agents/claude_engine.md) and [The Codex Engine](../local_agents/codex_engine.md) — what each engine reports, where its login comes from, and the reviewed adapter patches the running Codex total and the Claude context measurement rely on
- [Runtime Pins](../../development/runtime_pins/runtime_pins_llm.md) and [Packaged Runtime Dependencies](../../development/distribution/packaged_runtime.md) — the adapter digests those patches are checked against, at install and at packaging
- [Session Activity](../session_activity/session_activity.md) — the sibling core service in the same shape: driver reports, service holds, IPC pushes. Activity is memory-only; telemetry is durable. It also owns the badge strip under the composer (`SessionMetaBadges`) left of the mode badge that carries the Context row, and its ordering rule
- [Turn Outcomes](../../chat/messaging/turn_completion.md) — `TurnOutcome.usage` is filled from a turn's tokens
- [AI Spending Level](../../llm/ai_spending_level/ai_spending_level.md) — reads the context reading against the user's budget: the health line on the pill, the Context row's budget share, the budget row in the Context section and the crossing toast
- [Verbose Mode](../../ui/verbose_mode/verbose_mode.md) — the per-turn block in the message popup, and the runtime block in the mode badge's session details
- [Hub core](../../development/hub_core/hub_core_llm.md) — the service is core (`src/main/agents/telemetry/`); the IPC push is the desktop's
- Technical details: [Session Telemetry (tech)](session_telemetry_tech.md)
