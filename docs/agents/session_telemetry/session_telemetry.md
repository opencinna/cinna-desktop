# Session Telemetry — model, tokens, cost, context and login of a local agent's session

## Purpose

A chat with a local Claude or Codex agent spends tokens and money, fills a context window and runs on some login. Session telemetry collects what the runtime reports about each of those, per chat and per assistant turn, keeps it across restarts, and hands it to the renderer. It is collection only: the one place it is shown today is the verbose message popup. The session badge that will present it comes later and reads this model.

Without it the runtime's usage reports were thrown away on arrival. `usage_update` was read only as the end marker of a turn the agent started itself, the prompt response's `usage` was read by nothing, and a user who wanted to know what a chat cost, which model actually answered or how full the context was had to open a terminal and ask the CLI.

## Core Concepts

- **Session telemetry** — one document per chat (`src/shared/sessionTelemetry.ts`): the engine, the login kind, the model (selected and resolved), the context reading, totals (tokens, cost, turns, per model, per ACP session) and the time of the last request. It covers **every ACP session the chat had**, not only the current one
- **Message telemetry** — what one assistant turn used: its model, tokens, token scope, cost, duration and the context used after it. Saved on the turn's last assistant row
- **Token tally** — uncached input, output, cache reads and cache writes, kept apart because they are priced apart
- **Token scope** — how much of the turn the counts cover. `turn`: every request, subagents and compaction included (Claude). `last_request`: only the turn's last model request (Codex), so a lower bound. `none`: the runtime reported no tokens (a follow-up turn); cost only, if any
- **Selected vs resolved model** — *selected* is what the session's model option says, an alias for Claude (`default`, `opus`). *Resolved* is what actually answered, read off the turn's usage (`claude-sonnet-5[1m]`)
- **Context reading** — `used` and `size` from the session's own `usage_update`s, mid-turn as well as at the end. **Size authoritative** says whether `size` is the model's real window or the adapter's guess
- **Cost reading** — Claude's `usage_update.cost.amount`, the session's running total. A turn's cost is what that total grew by
- **Login kind** — `subscription`, `api_key`, `gateway`, `cloud`, `none` or `unknown`, with a label and plan name. **Never the account**
- **Reporter** — the port a driver gets (`SessionTelemetryReporter`). The driver reports changes; the only thing it reads back is a session's last cost reading

## User Stories / Flows

### A turn is counted
1. The user sends a message to a Claude or Codex folder agent. While the turn runs, each `usage_update` of the agent's own session moves the chat's context reading, and each change is pushed to the window
2. The prompt answers. The turn's tokens come from the response, its cost from what the costed `usage_update` added to the session's total, its duration from the prompt going out to the answer
3. The turn is added to the chat's totals once, and its figures are saved on the turn's last assistant row
4. In verbose mode, that row's info popup lists a `telemetry` block — model, tokens with their scope, cost and duration — above the parts

### The agent answers on its own
1. A background shell ends and Claude starts a [follow-up turn](../local_agents/agent_turn.md#a-turn-the-agent-starts-on-its-own-is-a-follow-up-turn)
2. There is no prompt response, so there are no tokens. The costed `usage_update` that ends the turn gives its cost
3. The turn counts once in the totals, with cost and no tokens, and its popup reads *not reported (follow-up turn)* for tokens

### The app restarts mid-chat
1. The chat's telemetry is read back from the database the first time something asks for it
2. The next Claude turn resumes the session with `session/load`. Its cost is measured against the last cost reading the chat saved for that session, so the history the CLI restored is not counted again

## Business Rules

### Counting
- **Totals come only from finished turns, one report per turn.** A context reading never adds to them, so a reading seen twice, or replayed, cannot count twice. `session/load` replay frames are dropped before they reach telemetry
- **A cancelled turn counts** when the prompt still answered. The tokens were spent
- **A turn with neither tokens nor cost reports nothing.** It still counts as a run of the chat; it does not count as a telemetry turn
- **Subagents count in the totals, never in the context or the model.** Claude's per-model rows include subagents and compaction and feed the per-model totals. The resolved model is the main agent's row only, and a child session's `usage_update` never moves the chat's context, because a subagent's context is not this one's
- **The main model among the rows** is the one whose canonical id (date and bracket suffix stripped) matches the selected model; failing that, the one that read the most input, since a subagent on a smaller model reads less
- **Once any turn covered only its last request, the totals are marked a lower bound** (`last_request`) and stay so
- **A nested turn** (an agent called as a tool inside another turn) reports nothing to the chat's totals. Its result still carries its own figures

### Cost (Claude)
- **The reading is a running total**, the SDK's `total_cost_usd`, which the CLI persists and restores when the session is resumed. A turn's cost is the growth since the previous reading for the same session
- **The previous reading is this process's, else the one the chat saved.** A new process, or a session resumed after a restart, is measured against the saved reading. Measuring from zero would count the whole restored history as the first turn's cost
- **A reading that dropped, or one with no earlier reading anywhere, is taken whole**: the session's total started over
- **The first turn on a resumed session takes its tokens from the main loop only.** The adapter restarts its per-model baseline when it builds a session object over a restored history: a `session/load` on a new process, or one under a different cwd or MCP server set (a connector switched on or off), which the adapter answers by rebuilding the session. That turn's per-model rows are the session's whole history. The main-loop `usage` is an undercount (subagents and compaction missing) and is preferred to a double count
- **Codex reports no cost.** Its turns have tokens and no cost

### Context
- **Every reading of the session's own `usage_update`s moves it**, mid-turn included
- **Codex's size is authoritative from the start.** Claude's is the adapter's guess until the first costed reading of that session and model corrects it
- **A size proven for one session or one model proves nothing about another.** A reading from another session, or a switch of the selected model, makes the size a guess again
- **A switch of the selected model forgets what answered.** The resolved model clears until the next turn names one

### Login
- **Only the kind, a label and the plan name are kept.** Claude's `_auth/status_update` carries the account's email and organisation beside them, unasked. Anything email-shaped is scrubbed out of the label and plan, so a future adapter that puts the account in the label still does not pass it on
- **Claude says it over ACP; Codex does not.** Claude's notification names no session and arrives right after `initialize`, so it is heard per connection and read when a turn ends. For Codex the login comes from the CLI's own `codex login status` line (ChatGPT is a subscription, an API key is one), read beside the turn and never holding it up
- **The latest report wins**
- **A login that is not the install's own subscription is also said in the transcript**, once per chat per process and login, not on every turn. See [The Claude Engine](../local_agents/claude_engine.md#a-turn-that-did-not-run-on-the-users-own-login-says-so-where-the-user-is)

### Where it goes
- **Telemetry never fails a turn.** A report that throws is logged; a write that fails keeps the in-memory state
- **The message row gets the turn's figures on its last assistant row.** When the turn's last slice is empty — it ended on a steer, or everything was already saved — the figures go onto the last assistant row saved for the turn. With no assistant row at all they are dropped from the transcript; the chat's totals already have them
- **A turn's tokens are also its [outcome's usage](../../chat/messaging/turn_completion.md)**: input is uncached plus cache reads plus cache writes. A turn that reported no tokens has no usage, never zero
- **Only the active profile's chats reach the window**, and nothing while the [activation gate](../../core/resource_activation/resource_activation.md) is closed. A chat of another profile, or one in the trash, answers `chat_not_found` as data
- **Trashing or deleting a chat forgets its telemetry**, row included, along with its sessions. A late report for a trashed chat is dropped, not written back. A chat restored from the trash starts without telemetry
- **Nothing changes, nothing is written or pushed.** A report that leaves the state as it was (a repeated model report) is silent

## Known limits
- **Codex tokens are a lower bound.** `codex-acp` reports the turn's last request only
- **Follow-up turns have cost and no tokens.** No prompt response carries them
- **Claude's cost handling rests on the reading being a running total**, read from the adapter and CLI source. If a pinned adapter starts reporting per-result cost instead, `costDelta` is the one place to change
- **A `session/load` the adapter answers by recreating a live session is not seen as a resume**, so that turn's per-model rows are trusted as they are
- **Not yet:** a badge or any surface besides the verbose popup, prices and estimated cost (`costSource: 'estimated'` exists and nothing sets it), cache time-to-live and expiry, the maximum output, context split by category, and any reading of the rate-limit payload (kept raw). Per-session totals are kept and not shown
- **OpenCode, command-line agents, remote A2A agents and Managed sessions report nothing**

## Architecture Overview

```
ACP adapter ── usage_update / config_option_update ──► AcpMessageStream ──► TurnTelemetry (per turn)
            ── session/prompt answer (usage, _meta.quota) ─────────────────►      │
            ── _auth/status_update (no session) ──► connection listener ─────►    │
codex login status ──► launcher.telemetryAuth ────────────────────────────►      │
                                                                                  ▼
                         sessionTelemetryService (reducer, held + session_telemetry row)
                              │                                   │
              session-telemetry:changed                 lastCostReading (restart)
                              ▼
                  useSessionTelemetry (no consumer yet)

TurnTelemetry.settle ──► RunAgentTurnResult.telemetry ──► a2aStreamingService
                              ──► messages.telemetry (last row) + TurnOutcome.usage
                              ──► MessageMetaFooter popup (verbose mode)
```

## Integration Points

- [The Agent Turn](../local_agents/agent_turn.md) — the ACP driver that observes the turn and settles its telemetry, including follow-up turns
- [The Claude Engine](../local_agents/claude_engine.md) and [The Codex Engine](../local_agents/codex_engine.md) — what each engine reports and where its login comes from
- [Session Activity](../session_activity/session_activity.md) — the sibling core service in the same shape: driver reports, service holds, IPC pushes. Activity is memory-only; telemetry is durable
- [Turn Outcomes](../../chat/messaging/turn_completion.md) — `TurnOutcome.usage` is filled from a turn's tokens
- [Verbose Mode](../../ui/verbose_mode/verbose_mode.md) — the message popup, the only surface today
- [Hub core](../../development/hub_core/hub_core_llm.md) — the service is core (`src/main/agents/telemetry/`); the IPC push is the desktop's
- Technical details: [Session Telemetry (tech)](session_telemetry_tech.md)
