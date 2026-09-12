# Agent Drivers & Readiness

## Purpose

One place per kind of agent decides how that agent is reached, run, authenticated and answered, and whether it can take a turn right now. The rest of the app asks an agent's driver what the agent *can do* rather than comparing what it *is*. The composer uses the driver's readiness to refuse a message that would only fail, and says why before the user sends it.

## Core Concepts

- **Driver** — `AgentDriver`: the kind-specific half of running an agent. There are **two**: `a2a` (a hand-added or Cinna-synced agent reached over A2A) and `acp` (every local CLI agent, run as a child process speaking the Agent Client Protocol). There were four for the length of one commit while the ACP driver landed switched off, and three before that — `opencode` and `claude` were separate drivers wrapping separate runners
- **Driver id** — `agents.driver`, stored on every row. **`source` still says who owns a row** (`local` / `remote` / `folder`: whether sync may touch it, which settings tab lists it, whether it can be deleted). **`driver` says how the agent runs.** One column used to carry both, and they are separate concerns
- **Capabilities** — what a driver can do for a given row: stream, cancel, keep a session, which asks it raises and how they are answered, whether a file can be attached, who authenticates the turn, where `/` commands come from, whether it runs in a folder. Answered from the row alone
- **Agent readiness** — whether an agent can take a turn now. The answer is `ok`, or one of:
  - `credentials_needed`, `invalid`, `contract_too_new` — the folder's own states
  - `not_installed`, `not_logged_in` — a CLI's
  - `unreachable` — an agent behind a URL

  It carries a short `reason` and, where the driver kept one, the raw `detail`. It is not the same as the scan-time folder **Readiness** in [Agents Home, Scanner & Folder Index](../local_agents/folder_index.md), which is only the first rung of a folder driver's answer
- **Not known** — a readiness of `null`: never checked, or a check that could not tell. **It never refuses anything**
- **Refusal** — the composer declining to send a message to the agent it goes straight to, because that agent's driver answered something other than `ok`
- **Check again** — the composer's action on a refusal; the Settings card's **Test Connection** does the same. It is a check the user asked for, so it goes past every cache a probe keeps
- **Launcher** — which engine an ACP agent runs: `driver_config.launcher`, one of `opencode` / `claude` / `gemini` / `codex`. **The launcher id is the engine name**, deliberately — it is what the folder's own `runtime.engine` says, and a second vocabulary would put the manifest and the row one translation table apart. Only the first two are built; an agent naming either of the others is refused in words, which is a far better failure than a value that reads as the default engine
- **Reconcile** — the ACP driver re-reading its folder's engine at the start of every turn and taking the launcher from what it says now. It used to mean handing the turn to a *sibling driver*, and while that hand-off was missing a Claude agent on a stale row answered "try again in a moment" for ever

## User Stories / Flows

### Sending to an agent that cannot take a turn
1. The user opens a new chat with one agent (the routing badge reads *Direct A2A connection*), or a chat already bound to one
2. The agent list answers at once with whatever readiness is already known: `null` for an agent not checked yet. It also starts a background check for every enabled agent whose answer is missing or old
3. The check comes back, say, `unreachable`. The answer changed, so main pushes it and the renderer re-reads the list
4. The reason appears in the state's colour, followed by a separator and **Check again**. It sits on a line under the controls row that is kept for every composer sending straight to one agent, so it was already there and nothing moves. Send is disabled and described by the reason. Its tooltip is the raw error where the driver kept one
5. Enter does nothing more. Nothing is cleared, so the message is still in the box when the agent comes back
6. The user fixes the agent and presses **Check again**. The check runs fresh and the list is re-read when it finishes. The reason goes away, Send is enabled, and focus lands in the message box

### An expired Cinna session
1. A synced agent's readiness comes back `not_logged_in`
2. The action is **Re-authenticate**, not Check again: asking again does not fix a session, signing in does. It runs the same flow as the chat's error chip ([Cinna Re-authentication](../../auth/cinna_accounts/reauthentication.md))
3. If either action fails, the line adds that (*Couldn't re-authenticate — …*) and the reason stays

### A catalog command to a refused folder agent
1. A folder agent is refused — its credentials are missing, say
2. The user types exactly `/run:<name>`. Send is enabled and the notice stays where it is
3. The command runs as a script in the folder, exactly as it would for a ready agent. `/run:check please` is still refused, because it is text for the engine, not a command

### A turn fails on an agent the list thought ready
1. A direct agent turn ends in `error`
2. The renderer asks for that agent's readiness again, without waiting for the answer
3. If the answer changed, the push re-reads the list. The next send is then refused with the reason, instead of failing the same way

### Settings → Agents
1. A hand-added A2A agent's card has a status dot. It is green when the agent is on and not refused, the refusal's colour when it is refused, and muted when the agent is off
2. When the card is expanded, the reason sits beside **Test Connection**, with a warning glyph for something the user can fix (a token, a login, an install) and a cross for an agent that cannot be reached or does not validate. A failed test does not replace it, because the test's raw error ("fetch failed") said less than the reason did. Only a passing test shows *Connected* in its place
3. Pressing Test Connection also re-checks readiness, so the dot and the composer follow the test the user just ran. A switched-off agent shows no reason at all

### The example prompts
1. On the new-chat screen, the example prompt tags of a refused single agent are dimmed and inert, with the reason as their tooltip
2. The tags send without going through the composer, so a tag that looked live and did nothing would fail silently

### A folder agent whose manifest now names the other engine
1. The user, or an assistant, switches a folder agent's runtime between OpenCode and Claude
2. The next turn reads the folder, sees the other engine and runs there, whatever the row still says

## Business Rules

### Turn behavior belongs to drivers

The turn decisions about readiness, authentication, attachments and commands live in `src/main/agents/drivers/`. Code elsewhere asks for capabilities — "does this agent take a file?", "is its token a Cinna session?", "do its commands come from a folder catalog?" — instead of comparing `source`, `engine` or `kind` to a literal.

This replaced callers that each branched on `source` again, for endpoints, tokens, the re-auth flag, command catalogs and attachments, and two of those callers disagreed.

What is still allowed, and where, is enforced by a test, not by review — see [the kind-branch ratchet](drivers_tech.md#the-kind-branch-ratchet). Sync keeps reading `source`, because ownership is exactly what sync decides. So do a handful of files whose reads are about who may edit, delete or list a row, and each of those is pinned to an exact count. The one behavioural branch on `source` still outside a driver is how agent status refreshes.

### One dispatch point, and it reads the row

`driverFor(agent)` picks the driver from `agents.driver`. A null, empty or unknown value resolves to an unsupported driver. The row stays visible with its raw identity, inert capabilities and a clear readiness refusal; it never falls through to another transport based on ownership. The three callers of `run` and `respond` all use it:
- the direct-chat handler
- the orchestrator's agent tool
- the answer path

It reads no folder and makes no network call. The ACP driver checks its folder itself when it runs a turn, and picks its launcher from what the folder says then.

### The row is a cache; the folder decides a folder agent's engine

A folder row's `driver` is only what the scanner last read. The folder can name the other engine before a rescan catches up: the Runs-with panel or an assistant may have edited the manifest a moment ago. Dispatching on the stale value sends a Claude agent to the OpenCode runner. That runner cannot find the agent in the engine config and answers "try again in a moment" for ever. So a folder driver reads the folder at the start of every turn, and hands the turn to its sibling when the folder disagrees.

**The stored driver is kept whenever the folder cannot speak for itself**: it cannot be read, or it is `invalid` or `contract_too_new`. A manifest is unparseable for a moment every time an assistant saves it. Its runtime then reads as none, and none would hand a Claude agent to the default engine. Both runners refuse such a folder with the same sentence anyway, so nothing is gained by moving the turn.

### The A2A pre-flight lives in one place

These all run inside the A2A driver's `run`:
- the card check
- endpoint and token resolution
- mapping an expired Cinna session to the re-auth code
- telling the agent to cancel its task on a stop

They used to be written twice, in the chat handler and in the orchestrator's agent tool, with different sentences, and only one copy mapped the re-auth code. Every failure there is now a turn result carrying `error`. It therefore arrives after the user's message is saved and is finalised like any other failed turn, which is how a folder agent's failures always arrived. A stop and an orchestrator abort share one cancellation path. Local waiting ends even when the server stops sending frames, headers or body bytes. Once the client and task identity are known, that path makes at most one best-effort `tasks/cancel` request without waiting for its acknowledgement. A stopped turn therefore does not claim that the remote task has stopped.

**Stop keeps the output already shown and preserves the previous session checkpoint.** The turn emits no further events and saves no new remote context or task identity after Stop. A fresh stopped chat has no checkpoint; a chat with a previous checkpoint retains it for a later message. This prevents a locally cancelled exchange from being recorded as a successfully completed session. Endpoint and credential pre-flight also stop waiting promptly; a shared credential refresh may finish in the background but cannot dispatch the stopped turn.

**A missing card URL refuses only an A2A row.** A folder agent is created with no card. A combined "no agent, or no card" guard once matched every folder agent and made the folder branch unreachable for a whole phase. Now only an A2A row reaches the A2A driver, and for that row a missing card really is a misconfiguration. `hasRunConfig` answers the same question for the orchestrator's tool list.

### Capabilities are pure, and the same for a row every time

Capabilities are computed from the row with no I/O. If a capability could change between the list and the send, the composer and the turn would disagree: the composer might offer an attach the turn cannot deliver, or refuse a `/run:` that main would have run. The table is in [Technical Details](drivers_tech.md#capabilities-per-driver).

Two answers depend on the row, not only on the driver:
- **Only a Cinna-synced A2A agent takes a file.** Its bytes go to the Cinna backend and the message carries the file's id
- **Only a synced agent's 401 means re-authenticate.** A hand-added agent's token is one the user typed, so a rejection just means the token is wrong

### Readiness never throws, and only an established answer refuses

Every driver answers `readiness()` without throwing, and **null means "could not tell"**.

- **A2A** fetches the agent's card with the agent's token, with a five-second bound around the whole check.
  - A card that does not answer within the bound gives `null`, not `unreachable`. A turn's own card fetch has no automatic deadline but remains stoppable, so refusing a slow agent would make readiness stricter than the turn it predicts
  - The bound includes the token. A token endpoint that accepted the connection and never answered once held a list-time slot for ever, and every check queued behind it waited too
- **OpenCode** readiness is the folder's alone, and that launcher deliberately has no rungs of its own: whether the binary is resolved is not part of it, because the turn resolves it (downloading it if it must), and a list must never start a download to answer "can this agent run"
- **Claude** — the launcher's rungs, asked about the engine the **folder** names rather than the one the row stores, so an agent just switched over in the Runtime card is answered about where it is going. The folder first, then whether a `claude` is installed, then whether it is logged in. Only a definite `logged_out` refuses. A login probe that could not answer never blocks, which is the same rule the runner applies before a turn

A failure reason is a short sentence that leads with what helps: the status, and where to fix it. It sits beside a disabled Send, cut to whatever width is left. The URL, the status and the network code go in `detail`, which only the tooltip shows. The raw error strings were shown on screen at first: "fetch failed", or a card URL cut off before the status that explained it.

**For a synced agent, checking has side effects.** Its token comes from the Cinna session, and a check refreshes that session when it is near expiry — and clears it if the refresh is refused — exactly as a turn does. Skipping the refresh would be worse: an access token that had merely expired would read as `not_logged_in`, and the composer would refuse an agent that works.

### A list never waits on a probe

Each agent in the list carries whatever readiness is already known. Listing starts a background check for every **enabled** agent whose answer is missing or old. A switched-off or deleted agent's answer is forgotten, and an answer that arrives after its agent was forgotten is dropped rather than kept.

- **An answer that does not refuse is kept until its TTL runs out.** The TTL is a minute for an agent reached over the network and ten seconds for one in a folder on this machine. A network agent's check is a card fetch, so checking on every list render would be a request per render. A folder read is cheap, and the state it reports (a credential typed into `.env`) is one the user fixes by hand and expects to see picked up without pressing anything
- **A refusal is re-checked every time the list is read.** The fix happens outside this service — a re-auth, a credential, a server coming back — and each of those re-reads the list. Holding a refusal for its whole TTL kept Send disabled after the fix, with nothing scheduled to read the list again
- **A refusal waits five seconds before it is re-checked.** A changed answer is pushed, and the push re-reads the list. An agent whose answer differs on every check — a proxy alternating 502 and 504, both in the reason — would otherwise loop check → push → list → check with nothing in between. *Check again* skips the wait
- **A change is pushed only when it shows on screen.** `null` and `ok` look the same everywhere, so a first `ok` is not pushed: pushing it would make the list refetch once per agent on every launch, with nothing on screen to change. A refusal appearing, going away, or changing its state or reason is pushed. The renderer re-reads the list once per push, however many components are listening
- **Background checks start one per event-loop turn, at most four at a time.** A folder agent's readiness is a synchronous folder scan. When the checks started inline, they ran inside the `agent:list` handler before it could answer, one after another, with no gap for an IPC message to get through
- **An older check never overwrites a newer answer.** If a slow list-time check finishes after *Check again*, its result is older news, so it is discarded by start order
- **A check the user asked for is fresh.** It does not reuse a list-time check that is already running. It also goes past every cache a probe keeps: the Claude login probe's window and the tool-detection memo. The channel behind *Check again* once called the refresh without the fresh option, while every layer below it passed the option on. Nothing failed — *Check again* after `claude login` simply kept refusing
- **Readiness lives only in the main process's memory.** It is never saved, and every agent starts at `null` after a relaunch

### What the composer refuses, and what it deliberately does not

- **It refuses only the agent the message goes straight to.** That is the bound agent of a chat that is not orchestrated, or a new chat's single agent when the routing badge says A2A. An agent attached as a tool of the local model is not refused: its failure comes back as a tool result the model can read and work around
- **It refuses rather than just warning.** Sending to an agent the driver says cannot take a turn produces a failed turn the user then has to read, and the reason was already known
- **A bare `/run:<name>` to an agent whose commands come from a folder catalog always runs,** refused or not. It is a script run in the folder on this machine, not a turn on the agent's engine, so the agent's readiness says nothing about whether it can run. The composer matches the same grammar main uses; a looser one would enable Send for text that main then passes to the engine
- **`null` never refuses.** A check that has not run yet, or could not tell, never stops a working agent
- **The line never depends on what is typed**, so nothing appears or moves while the user types ([UX Rules](../../development/ui_guidelines/ux_rules.md), rule 1). What is typed only decides whether Send is blocked
- **The reason has its own fixed-height line under the controls row, kept for every direct agent whether it is refused or not.** A refusal that lands while the user types, or clears after *Check again*, therefore moves nothing. When the reason sat inline in the row, the action and its separator cost about 100px: that wrapped two chips at the narrowest window and four at every width, moved the textarea when the refusal cleared, and squeezed the reason to nothing, leaving "· Check again" with no sentence before it. A composer the local model conducts, where nothing can be refused, keeps no line. The action button is wide enough for either of its labels, so switching to the pending label moves nothing
- **When *Check again* clears the refusal, focus goes to the message box.** The button removes itself, and its focus would otherwise fall to the page body. It happens only from the page body: a refusal that clears in the background never takes focus from wherever the user is
- **While the action runs it is `aria-disabled`, never `disabled`.** A button that disables itself while it has focus sends focus to the page body in the middle of the check
- **The refusal is not checked again when the new chat is created.** An example prompt is refused where it is clicked, and the composer has already decided for a typed message. A guard at chat creation once silently dropped a `/run:` the composer had already allowed
- **Every tooltip is the raw error where the driver kept one**, falling back to the reason. That holds for the composer line, Send, the example prompts and the Settings card

### The index says which driver runs a row

- **Every insert writes `driver`:** `a2a` for a hand-added or synced agent, `acp` for a folder agent, with the launcher in driver_config.
- **Migrations alone backfill legacy driver values.** NULL rows take the historical mapping, then ACP migration moves old engine IDs into launcher configuration. Unknown non-null drivers stay unchanged. There is no boot-time heal or runtime fallback.
- **A scan writes each folder's driver, except when the folder's manifest could not be read.** Then the row keeps its value. A scan may change readiness, never identity, and a Claude folder whose manifest is unparseable for a moment must not come back as an OpenCode row
- **An engine chosen in the app updates the row immediately**, not at the next scan. The agent's capabilities are read from the row, and a bare agent's runtime is stored outside its folder, where no watcher sees it change
- **The driver adds nothing to the folder index's list of values a rebuild cannot recover.** A rescan reads it back from the folder: from the manifest for a kit agent, or from the bare agent's own state
- **`agents.driver_config`** exists for a driver's own settings, and ACP uses its launcher field to choose the CLI process

## Architecture Overview

```
Renderer
  useAgents ── agent:list ─────────────► agentService.listMerged
     ▲                                     ├─ toDto: driver, capabilities, readiness = supported ? peek(id) : invalid
     │                                     └─ agentReadinessService.kick(rows)
     │                                            │ enabled only; one start per macrotask, ≤ 4 at once
     │                                            ▼
     │                                     driverFor(row).readiness(userId, row, {fresh?})
     │                                        a2a → token + card fetch, 5 s bound
     │                                        acp → folder, then the launcher the FOLDER names:
     │                                                opencode → nothing further
     │                                                claude   → install → login
     │                                            │ a refusal arrived, left or changed?
     └── agent:readiness-changed ◄────────────────┘ push; the renderer re-reads the list

  ChatInput ── useComposerReadiness(directTarget, typed)
     │  refusal → reason · Check again | Re-authenticate; Send disabled
     │            (a bare /run: to a catalog agent → Send enabled)
     └── Check again / Test Connection ── agent:check-readiness ── refresh(…, {fresh: true})

  Send ── agent:send-message ──► driverFor(agent)
                                   ├─ resolveCommandRunner(capabilities.commands, …)
                                   │     bare /run: to a catalog agent → commandService
                                   └─ driver.run(userId, row, {chatId, wireContent, …})
                                        a2a → pre-flight → runAgentTurn (+ tasks/cancel)
                                        acp → read the folder → launcherOfFolder →
                                                launcher.plan() (or a refusal, in a sentence)
                                                → pool.acquire → session → prompt
                                   ▼
                                 a2aStreamingService.streamToAgent({run, port})

  Orchestrator ── A2AAsMcpProvider.callTool ──► driverFor(agent).run(…)
  agent:answer-request ─────────────────────► driverFor(row).respond(ask, answer)
                                               row gone → respondToOrphanedAsk
```

## Integration Points

- [The Agent Turn](../local_agents/agent_turn.md) — what the ACP driver does inside `run`, and the parked-ask registry it answers through
- [The Claude Engine](../local_agents/claude_engine.md) — the install and login probes the Claude launcher's readiness asks, and what it declares at `initialize`
- [The Local Engine](../local_agents/engine.md) — why OpenCode readiness is the folder alone: the turn resolves the binary, and the process is the turn's own
- [Agents Home, Scanner & Folder Index](../local_agents/folder_index.md) — the folder readiness that is the first rung of the ACP driver's answer, and the scanner that writes the launcher
- [The ACP Engine Contract](../local_agents/acp_contract.md) — what each engine actually does over this protocol
- [`/run:<name>` — Catalog Commands](../local_agents/commands.md) — decided on `capabilities.commands`, and never refused on readiness
- [Local Agent Permissions](../local_agents/permissions.md) — *Always allow* is written by the ACP driver's `respond`, before the park is settled
- [Agents](../agents/agents.md) — the Settings → Agents card that shows readiness beside Test Connection
- [Cinna Re-authentication](../../auth/cinna_accounts/reauthentication.md) — the flow the composer's Re-authenticate runs
- [Orchestrated Agents](../../chat/orchestrated_agents/orchestrated_agents.md) — the agent tool goes through `driverFor` too, and is never refused on readiness
- [Database Migrations](../../development/migrations/migrations_llm.md) — the legacy-only driver backfill and routing-mirror retirement
- [Main-Process Layering](../../development/main_layering/main_layering_llm.md) — where the drivers folder sits and what it may import

## What is not verified

- **The readiness push has no end-to-end test of its own.** Every renderer surface the E2E spec drives also re-reads the list for another reason — Check again finishing, a query observer mounting — so the spec would still pass with `agent:readiness-changed` broken. Only unit tests cover one list read per push
- **Only an unreachable hand-added A2A agent is driven end to end** (`e2e/specs/driver-readiness.spec.ts`). The folder, Claude and synced-agent branches, the five-second wait before a refusal is re-checked, and the TTLs are covered only by unit tests with fakes and an injected clock
- **A synced agent's check refreshing or clearing the Cinna session** comes from the token resolver. Nobody has watched it happen during a list render against a real server

## Unsupported identity and legacy storage

Only migrations backfill a legacy null driver; there is no boot repair or read-time ownership fallback. Unknown non-null identities remain stored as written by the newer tool. Listing, editing and removal stay available, but readiness and execution refuse without opening a process or network request. A stale cached ready answer cannot override that refusal. This avoids interpreting a future driver as A2A or ACP merely because the row has familiar ownership.

The remaining status, Job-execution and tool-provider behavioral ratchet work is separate. Relocating helpers and retiring compatibility fields does not remove those behavioral sites.
