# Agent Status

## Purpose

Surfaces the per-agent self-reported status — severity, summary, timestamp, markdown body — for **both kinds of agent the desktop knows about**, so users can see at a glance which agents are healthy, which need attention, and jump straight from a status tile into a chat. A **remote** (Cinna) agent's status is the snapshot the platform caches for its environment; a **folder** (local) agent's status is its own `app-data/storage/STATUS.md`, read off this machine's disk. One list, one poll, one overlay, one menu-bar dot.

Phase 7b of Local Agents added the folder leg. Before it, this feature was Cinna-only end to end — and not only in the service: three renderer gates would have kept a folder agent's status off screen even with a perfect main process.

## Core Concepts

- **Status snapshot** — The row every surface renders (`AgentStatusSnapshot`). Two producers:
  - *Remote*: the heartbeat an agent writes to `/app/workspace/docs/STATUS.md` inside its environment, parsed and cached by the backend on the `agent_environment` row and served over REST. Desktop consumes the cached snapshot; it never reads a remote agent's files.
  - *Folder*: the agent folder's own `app-data/storage/STATUS.md` (path taken from the kit contract's `layout.agent.status_file`, never hard-coded), read and parsed locally by the same `readStatus` the folder scanner already used for the agents-list sub-line.
- **Severity** — Normalized level for a snapshot: `ok` · `info` · `warning` · `error` · `unknown` · `null`. Drives card tint, corner indicator, icon, sort order and the menu-bar dot.
- **Severity derivation (folder agents only)** — A remote snapshot arrives with a severity already assigned. A folder agent writes a **free-form word** in its frontmatter (`state:` / `status:` / `health:`), so the desktop derives one. See the rules below — the mapping is anchored on the kit contract's own vocabulary, and an unreadable word never becomes green.
- **`status_refresh_command`** — An optional manifest field on a folder agent naming the command that recomputes its status. Only the `/run:<name>` form — a reference into the agent's own `docs/CLI_COMMANDS.yaml` catalog — is executed. It runs as a subprocess in the agent folder under that agent's turn lock. <!-- nocheck -->
- **Worst severity** — The highest-ranked severity across all snapshots, shown as a coloured dot on the sidebar-footer icon and painted into the menu-bar tray icon. A `null` severity is skipped.
- **Batch list** — The cache-only, poll-safe list every surface consumes. It is the **union** of the folder leg (local disk) and the remote leg (one HTTP call). It runs **no** commands — see the polling rule below.
- **Force refresh** — A one-shot per-agent request. It asks a *different question of each agent kind*: for a remote agent "fetch what exists now" (wake the env, re-read its STATUS.md, bypass the server cache); for a folder agent "**recompute**" (run `status_refresh_command`).
- **Re-read** — A folder agent's status without forcing anything: read `STATUS.md` off disk. Takes no lock, spawns nothing. This is what the post-turn pull and "Refresh all" use for a folder agent.
- **Partial failure / degradation strip** — The Cinna leg failing no longer costs the user the rows it did not invalidate. The list returns folder rows plus a `remoteError`, and both panels render the failure as a **strip above** the rows instead of a panel instead of them.
- **Sentinel snapshot** — A remote row with both `severity == null` *and* `raw == null` — the agent has never published. Hidden. A folder agent with no `STATUS.md` is omitted for the same reason.
- **`environmentId: 'local'`** — A **sentinel, not data**. See the business rules.
- **Status overlay** — Full-window frosted-glass modal opened from the sidebar-footer activity icon: a responsive grid of agent cards, each expandable into a detail view with the full markdown body.
- **Tray popup** — The macOS menu-bar popover showing the same list. See [Menu-Bar Tray](../../ui/tray/tray.md).

## User Stories / Flows

### Seeing at-a-glance agent health

1. The activity icon sits in the sidebar footer whichever profile is active. Folder agents are **default-scope shared resources**, so their statuses are visible from every profile; remote statuses additionally require the active profile to be a Cinna account. Neither surface is gated on the account's *type*
2. If any agent has published a status, the icon gains a coloured dot — red for `error`, amber for `warning`, sky for `info`, emerald for `ok`, muted for `unknown` — reflecting the **worst** severity across every agent, local and remote alike
3. Hovering shows *"Agent status — 3 agents · worst: warning"*; with nothing to report it is a plain glyph reading *"Agent status"*, with no dot
4. The background poll (every 45 s) keeps it fresh; window focus also refetches
5. The same worst severity is painted into the menu-bar tray icon's dot

### A folder agent reporting status

1. The user scaffolds an agent (New Agent) or adopts an existing folder into an agents root
2. The agent — or the bundled `scripts/update_status.py` — writes `app-data/storage/STATUS.md` with `status`, `summary` and `timestamp` frontmatter
3. On the next poll (≤ 45 s) the agent appears in the overlay grid, the tray popup, and the worst-severity dot, with no Cinna account involved anywhere
4. If the agent updates its own `STATUS.md` **during** a chat turn — which is the design the scaffolded template encourages — the desktop re-reads it the moment that turn ends, so the tray reflects it immediately rather than at the next tick

### Refreshing a single agent

1. The user clicks Refresh on a card or in the detail view
2. The icon spins. For a **remote** agent this is `force_refresh=true` against the platform. For a **folder** agent this runs its `status_refresh_command`, then re-reads `STATUS.md` — in that order, because reading first would show the status the refresh was about to replace
3. **Each card's spinner reports its own agent.** In-flight state is tracked per agent id, so starting a refresh on one card does not stop another card's spinner or re-enable its button mid-flight, and a second click on an already-refreshing card is a no-op. The stakes are highest for a folder agent: a second concurrent run is refused by that agent's turn lock, swallowed as `busy`, and comes back as a **success** carrying the on-disk snapshot — a click that looks like it worked and did nothing
4. On success the shared batch cache is patched in place, so the card, the detail view and the dot update without a full re-poll
4. **A failure is now reported, in the grid *and* in the detail view.** A broken refresh script, a `/run:` name that is not in the catalog, a folder that has moved, or a manifest asking for something the app will not run all surface as a red strip naming the reason. (Until 7b this button spun, stopped, and said nothing — for remote agents too. The detail view kept the defect one commit longer, which matters because a tray card click opens the overlay *straight into* the detail view: the surface people check instead of opening the app was the one place a broken `status_refresh_command` stayed silent.)
5. **Three outcomes, and only the first two are quiet.** *Nothing to report* — a remote 429, or a folder agent that has never written a STATUS.md — returns no snapshot and shows nothing: the same legitimate nothing the batch list omits rather than rendering a blank card. *Not now* — a folder agent whose turn lock is held by a streaming turn, an editor save or another command — is also silent, but the on-disk snapshot comes back, so the card keeps showing what the file says. *Not any more* — the folder has been moved or deleted — is a **fault**, and surfaces on the card with a reason. This is the same cut the severity rule draws one level down between *claimed nothing* and *claimed something unreadable*: an absence and an unreadable answer are different facts, and collapsing either loses the one that needed acting on

### Refreshing everything

1. "Refresh all" sits in the overlay grid header and in the tray popup
2. It fans out one per-agent call over every currently-cached agent, in parallel
3. Each kind is asked the question that fits it: **remote agents are force-refreshed; folder agents are re-read from disk.** A glance-level "make the panel current" gesture does not start every local agent's health script at once — the file on disk is already the truth, so a re-read answers it completely and instantly
4. The tray flashes green only when nothing failed
5. With nothing cached yet there is nothing to fan out to, so it falls back to the cache-only list refetch

### Inspecting details

1. Clicking a card opens the detail view: back arrow, avatar with severity dot, name, Refresh and Start Chat
2. Below: severity label, summary, `reported_at` (and, for a remote agent, `fetched_at`) as relative times with the absolute in parentheses, a `Changed from <prev_severity>` line if the severity moved within the last hour, and — **only when the snapshot really has no environment** — the "Environment is not running — showing last cached status" notice
3. The body (STATUS.md with frontmatter stripped) renders as GitHub-flavoured markdown
4. `Esc` returns to the grid; a second `Esc`, a click outside, or the close button closes the overlay

### When the Cinna leg fails

1. A user with both kinds of agent loses network, or their Cinna session expires
2. The folder agents' rows **stay on screen** — their status came off local disk and nothing the remote leg did invalidates it
3. A red strip appears above them carrying the same message and the same **Re-authenticate** button the full-panel error carries, plus a line saying the agents below are the ones on this machine
4. With nothing left to show, the error is still the whole panel, exactly as before

### Starting a chat from a status tile

1. Clicking the chat button on a card, or "Start Chat" in the detail view, closes the overlay, switches to the chat view with no active chat, preselects the agent and focuses the input
2. **It reaches a folder agent, and it did so before either picker would offer one.** The preselect resolves the id against the *unfiltered* agents list, so it never met the counterparty exclusion that the composer's `@` picker and the Jobs agent picker both applied — a folder agent could be started from a status tile but not chosen from either picker. Phase 7c deleted that exclusion, so the three entry points now agree; **it removed an inconsistency rather than adding a capability**, and this tile is the surface that proves the runner path was already reachable from a real UI. See [Folder Agents as Counterparties](../local_agents/counterparty.md)

## Business Rules

### One rule the rest are instances of

- **Where the truthful answer is unavailable, say less rather than guess.** Three decisions in this feature look unrelated and are the same decision: an unrecognised status word maps to `unknown` rather than `ok`; a folder agent's `environmentId` is the sentinel `'local'` rather than `null`; and the per-agent failure strip names no agent rather than the wrong one. In each case the rejected alternative was **not** *less information* — it was **a confident falsehood**: green over a word nobody read, "environment is not running" over a file read a second ago, a failure attributed to an agent that did not fail.
- **It is this phase's own defects turned into a rule.** Every one of them had the same shape — something failed and the user was shown silence, or health: a blanked panel that hid good rows, a Refresh that spun and said nothing, an inactive session rendered as "no agents have reported status yet", a moved folder reported as "nothing to report". The cure for showing health is not showing *more*; it is **refusing to claim what cannot be supported**. Read the three instances below as one rule with three surfaces, not as three local judgement calls — each is defensible alone, and a rule overturned one instance at a time is how this kind of care disappears.

### Who sees it

- **Not a Cinna-only feature — and the reason is scope, not account type.** *(This rule replaced the opposite claim, which stood until 7b: the batch hook ran with `enabled: false` for every non-Cinna account and the sidebar button was account-gated.)* Folder agents live in the **default scope**, shared and available regardless of which profile is currently active, so a status list has something to report whether or not the active profile is linked to Cinna — which is what makes the no-Cinna-account case work at all. The renderer's account-type condition was therefore **dropped rather than widened** to "cinna user OR has a folder agent": whether a user has anything to report is the main process's question, and it answers it from *two scopes* rather than from the account's type. A second copy of that rule in the renderer is a second thing to be wrong; being wrong the cheap way costs one IPC round trip returning `[]`, with no network call behind it for a profile with no Cinna link.
- **The button is not gated on live data either.** It is the only door into the overlay, and so into "Refresh all"; gating it on whether statuses exist would make the footer's controls move as statuses arrive and go.

- **Two scopes, and the list needs both.** Folder agents are shared machine resources stored in the **default/settings** scope, visible from every profile; remote agents, the Cinna account and its tokens are **profile**-scoped. The status service therefore takes *both* user ids rather than one. Handing it the profile id alone is not an error anyone sees — it is a valid query returning an empty list, which reads as "this user has no folder agents"; that is exactly how the folder leg was, for a time, silently dead for every user except the default guest profile.

### Polling and refresh

- **Background polling** runs every **45 s** over the union of both legs. Stale after 15 s, so mounting a new consumer (opening the overlay) reuses the cache. Focus events refetch.
- **The poll runs no commands.** The remote batch route is cache-only by contract; the folder leg is cache-only by decision. `commandService.run()` takes the per-agent turn lock, so a tick that ran `status_refresh_command` would make an editor save — and the user's very next message — refuse **on a timer**, for work nobody asked for. A folder agent's status therefore refreshes on the poll only as fast as the agent itself rewrites the file.
- **`forceRefresh` does not mean the same thing for both kinds.** Remote: *fetch what exists now.* Folder: *make the agent recompute.* Both buttons' tooltips used to say "force refresh from running environments", which was never true of an agent that has no environment; they now say what each kind gets.
- **The per-card Refresh is the only surface that runs a folder agent's command**, and the only one that reports when it fails. It is singular, targeted and explicitly aimed at one agent.
- **"Refresh all" re-reads folder agents.** Two consequences settle it: the fan-out is over *every* cached agent, so one menu-bar click would otherwise start every folder agent's status script simultaneously — per-agent locks make that safe, not cheap, and each running script refuses that agent's chat and page-editor saves for as long as it takes; and the tray's spinner holds until the whole batch settles, so one 30-second script would spin a menu-bar button for 30 seconds.
- **The post-turn pull is a re-read, not a force.** When an agent turn ends (`done` or `error`) the desktop pulls a fresh snapshot for that agent. For a remote agent that stays a force refresh (Cinna accounts only, 429s swallowed). For a folder agent it is a **disk re-read**: a force would run the agent's own health check after every message nobody asked for it on, and hold the lock the user's next message needs — a background refresh refusing a message the user just sent. It is redundant besides, since an agent that updates its own STATUS.md does it during the turn.
- **Rate limits.** User-initiated remote force refresh always fetches; the backend's 1 call / 30 s per-env limit throttles only event-driven refreshes. A 429 is logged at info and treated as a no-op. A folder agent's equivalent of a 429 is a **busy** turn lock, and it is swallowed identically.
- **Refresh cache patch.** A successful per-agent fetch is written back into the batch cache by `agentId`, so cards and the open detail view update in place. A per-agent success says nothing about the batch route's health, so a standing partial-failure marker survives the patch.
- **A failed refresh never costs the user the status they already had** — the failure leaves the cache untouched and the last good snapshot stays on screen behind the error.

### Failure shape

- **Partial results, not a blank panel.** The service returns folder rows plus a `remoteError` when the Cinna leg fails; the overlay and the tray decide the failure's *shape* by whether there is anything left to look at, and by that alone. Rows on screen → a strip above them. Nothing on screen → the whole panel, exactly as before. Nothing is softened: same message, same colour, same Re-authenticate button, which the strip carries too.
- **A failure arrives through one of two doors, and the rule above covers both.** Either the handler **returns** it (`{success:false, code}`), or the *invoke itself rejects* — which is what a handler throwing above its own `try` produces. On the rejecting path the `code` is already gone by the time the renderer sees it: IPC serialises a rejection down to a message and a stack, so a thrown code cannot survive the trip. The hook therefore maps **any** unrecognised rejection onto the same typed error every consumer already branches on, rather than leaving it unclassified. Both doors matter because a reader who knows only the returned path will not think to check the other — and an unclassified rejection does not render as an error, it renders as an empty, healthy-looking panel saying *"No agents have reported status yet."*, which is the worst thing a status surface can say about a session that is simply not activated.
- **An unexpected rejection's message is passed through raw**, IPC plumbing prefix and all. It is meant to be ugly: such a rejection reaching a user is a bug, and a tidied message is a bug that looks handled.
- **This repairs pre-existing behaviour and will read as a regression if you don't know that.** Before 7b, both surfaces rendered *error instead of list*, so a **single transient poll failure blanked a panel full of perfectly good cached snapshots** — for remote-only users as well. Folder agents made the flaw obvious (their status is unaffected by anything the Cinna leg does), but the fix was always owed to remote agents too.
- **The remote failure is never swallowed.** A Cinna user's remote agents going silently stale behind a healthy-looking panel is this feature's worst failure class — worse than the blanking it replaces — so the failure is carried out to be surfaced, and `reauth_required` survives the trip because both surfaces branch on that code to offer re-authentication.
- **With no folder rows, the list still throws.** Nothing to show plus something failed means the error is the whole answer; degrading to an empty list would report "no agents have reported status yet" for what is really a network fault or an expired session.

### Folder-agent specifics

- **Only the `/run:<name>` form of `status_refresh_command` executes.** The manifest schema also permits a raw shell string; that comes back as an error naming the supported syntax. **The reason is not that shell is dangerous** — the commands feature already spawns agent-supplied shell out of the same folder, so that argument would prove too much. The distinction that holds is **visibility and validation**: a catalog command is displayed on the agent page with its name and command text, is validator-checked, and is started by the user; a `status_refresh_command` runs **on the user's behalf and is never shown**. Widening this later is one branch; narrowing it after arbitrary strings have started executing is not.
- **Severity is derived from a free-form word, anchored in the contract.** The kit contract's own `scripts/update_status.py` declares `STATUSES = ("ok", "attention", "error", "unknown")` and normalises anything else to `unknown` *before writing*, so those four are normative and a compliant agent can only write one of them. `attention` maps to `warning`; the rest map to themselves. A small, explicit synonym table (`healthy`/`green`/`pass`/`passing`/`success` → `ok`; `warn`/`degraded`/`blocked` → `warning`; `fail`/`failed`/`failure`/`critical` → `error`; `info` → `info`) is a tolerance layer for files that do not go through that script. Matching is trimmed and case-insensitive.
- **An unrecognised word maps to `unknown`, never to `ok`** — an instance of *say less rather than guess*. This feeds a menu-bar dot someone glances at *instead of* opening the app; green over a word nobody read is silent false reassurance — strictly worse than grey, because grey is a question and green is an answer.
- **No word at all maps to `null`**, which the worst-severity computation skips and which sorts *below* `unknown`. "Claimed nothing" and "claimed something unreadable" are different facts and the type had room for both.
- **`environmentId: 'local'` is a sentinel, not data** — the same rule again. The renderer reads `environmentId === null` as *the remote environment is not running* and prints "· env not running" / "Environment is not running — showing last cached status". Over a file read off this machine's disk a second ago that is a confident, visible falsehood on every folder-agent card. Nothing renders the value itself; the non-null sentinel is how "not applicable" is said without adding a field to a type that is declared in two places.
- **Timestamps.** `readStatus` accepts `timestamp` first, then the synonyms `updated` / `updated_at` / `last_updated` / `generated_at`. **`timestamp` is the only key the contract's own `update_status.py` ever writes** — and it was not in that list until 7b, so *every* status a scaffolded agent has produced since Phase 3 arrived with no time on it: no time on the agents-list sub-line, no time on the agent page's Status card. Users of scaffolded agents will now see a reported time where there was none. The defect survived because the test that covered the field used the `updated` **synonym** rather than the bytes the emitter writes — the transferable lesson being that a fixture written from a format's *documentation* instead of its *emitter* passes while the real bytes fail.
- **A missing timestamp falls back to the file's mtime**, reported as `file_mtime` and labelled in the UI as inferred — the same treatment the remote platform gives it.
- **Severity history is not invented.** `prevSeverity` / `severityChangedAt` stay `null` for a folder agent: that history is the remote platform's, kept server-side across polls, and claiming a transition from a single read would claim something never observed. `raw` is `null` too — nothing reads it, and re-reading the file to fill it would cost a second syscall on a 45-second poll.
- **A folder agent with no `STATUS.md` is omitted**, mirroring the remote sentinel rule: a surface listing agents that have reported should not list one that has not.
- **The batch list skips what the per-agent path reports, and that is one decision rather than two.** A folder the app cannot locate is *omitted* from the poll but *thrown* from a Refresh, and the question both answers is **who asked**: nobody asked about that agent in a 45-second tick, and taking the whole panel down over one moved directory is a worse answer than a shorter list — whereas a per-agent Refresh was aimed at that agent by a user who is owed a reason. The asymmetry is stated in both places in the code so neither side reads as an oversight.
- **One bad folder never costs another its row.** An agent whose row has gone stale, whose folder has moved, or whose kit contract will not load is skipped and logged, not propagated. An unreadable *manifest* does not withhold a `STATUS.md` sitting right there — that is the agent page's finding to report.
- **One `fetchedAt` for the whole batch**, because per-agent stamps would encode nothing but loop order.

### Ordering, rendering, presentation

- **Severity rank** (most → least urgent): `error`, `warning`, `info`, `ok`, `unknown`, then `null`. `null` is ignored when computing worst severity.
- **Severity colouring** is theme-aware, via `--color-severity-*` tokens with `-text` variants; no hardcoded palette classes.
- **Frosted-glass surfaces** are theme-aware, so the modal never forces a dark wash onto a light UI.
- **Never-staleness colouring.** Update cadence is agent-specific — we never colour a tile "stale". The user reads the reported time and judges.
- **Body safety.** `body` renders through `react-markdown` + `remark-gfm` only (no `rehype-raw`), so raw HTML in a STATUS.md — remote or local — is neutralized.
- **Fade transition.** Open and close animate opacity over 350 ms; the overlay stays mounted through the close animation.

## Architecture Overview

```
Main process
  agentStatusService.list(userId)                    [cache-only, safe to poll]
      ├── folder leg   (first, and before anything that can fail)
      │      agentRepo.listFolder → localAgentService.locate
      │      → readFolderAgentSnapshot → scannerService.readStatus
      │      → severityFromState                     [runs no command]
      └── remote leg   GET /api/v1/agents/status
             failure → { items: folderRows, remoteError } (degrade)
             failure + no folder rows → throw

  agentStatusService.get(userId, agentId, forceRefresh)
      ├── folder agent → forceRefresh ? runStatusRefresh() then read : read
      │                   (/run:<name> only; busy + aborted are no-ops)
      └── remote agent → GET /api/v1/agents/{uuid}/status?force_refresh=…

IPC
  agent-status:list  ← { success, items, remoteError } | { success:false, code, error }
  agent-status:get   ← { success, item }               | { success:false, code, error }

Renderer
  useAgentStatus()                 ── 45 s poll, EVERY account, re-raises remoteError
  useForceRefreshAgentStatus       ── per-card Refresh: force both kinds (folder = run command)
  useRereadAgentStatus             ── post-turn pull for a folder agent (no lock, no subprocess)
  useForceRefreshAllAgentStatuses  ── "Refresh all": force remote, re-read folder

  Sidebar footer → AgentStatusButton (dot = worst severity, no account gate)
        │ click
        ▼
  AgentStatusOverlay      grid + detail; failure is a STRIP when rows survive,
                          a PANEL when nothing does
  TrayPanel / useTrayIcon same list, same rule, same dot in the menu bar

  "Start chat" → setActiveView('chat') + setPendingAgentId(agentId) → MainArea
```

## Known Limitations

Stated as limitations rather than omitted:

- **A folder agent whose `STATUS.md` is only ever written by `status_refresh_command` looks static on the poll.** The batch path deliberately runs nothing, so such an agent's tile never changes on its own and only updates when the user presses its card's Refresh. The decision behind it is right — a 45-second tick that took every agent's turn lock would refuse editor saves and the user's next message on a timer — but nothing on screen tells the user the design is asking them to press Refresh, so **this is correct behaviour that will attract a bug report**. The cure, if one is wanted later, is on the agent's side: have it write its status during its turn, which is what the scaffolded template encourages.
- **The per-agent failure strip does not say which agent failed.** With two Refreshes in flight, the mutation's `variables` names the latest *call* while its `data` holds the latest *settled result*, and the two can disagree — so attributing the message to an agent would sometimes name the wrong one, which is worse than naming none (*say less rather than guess*, again). The strip is therefore shared and deliberately un-attributed; with one refresh at a time, the ordinary case, there is no ambiguity to resolve. **This is permanent rather than pending:** attributing it properly means carrying `{agentId, message}` per call, which reworks the very error path that was mutation-pinned two commits before — so the cost is known and was weighed, not deferred. `AgentStatusOverlay.tsx`'s own comment points here for this reason.
- **Nothing in 7b has been through a live `npm run dev` run.** The behaviour above is what the code and its tests say; none of it has been watched in the running app.
- **`useTrayIcon` is not directly tested.** It reads the same hook as everything else and therefore inherits the widened gate, but no test asserts that the menu-bar icon repaints for a folder agent's severity.
- **`runStatusRefresh`'s abort branch has no production caller.** The function accepts an `AbortSignal` and treats a cancel as a soft no-op, but the only caller passes none, so that branch is exercised by tests alone.
- **The severity mapping rests on agents actually writing the contract's vocabulary.** An agent that invents its own word lands on `unknown` by design — correct, but it means a bespoke status vocabulary shows grey until either the agent or the synonym table changes.

## Integration Points

- [Agents Home, Scanner & Folder Index](../local_agents/folder_index.md) — supplies the folder rows, the roots, and `readStatus` itself; the status file's location comes from the kit contract's `layout.agent.status_file`.
- [Agents Tab & Agent Page](../local_agents/agents_tab.md) — the same `readStatus` output drives the agents-list sub-line and the page's Status card, which is why the `timestamp` fix shows up there too.
- [`/run:<name>` — Catalog Commands](../local_agents/commands.md) — a `status_refresh_command` *is* a catalog command: same parser, same subprocess, same per-agent turn lock (owner `'command'`), same output cap and ceiling.
- [Kit Contract & Manifest Layer](../local_agents/kit_contract.md) — owns `status_refresh_command` in the manifest schema, the validator rule that a `/run:` reference must resolve, and the `update_status.py` template that defines the normative status vocabulary.
- [The Agent Turn Runner](../local_agents/agent_turn.md) — the post-turn re-read hangs off the end of a folder-agent turn, and the turn lock it declines to take is that runner's.
- [Remote Agents](../remote_agents/remote_agents.md) — the remote leg is keyed by the `remoteTargetId` written on each `agents` row during `agent:sync-remote`.
- [Agents](../agents/agents.md) — "Start Chat" uses the existing `pendingAgentId` → `MainArea` → agent-preselect flow.
- [Cinna Accounts](../../auth/cinna_accounts/cinna_accounts.md) — the remote leg authenticates per request; `reauth_required` reaches the overlay and the tray as a Re-authenticate affordance, now in strip form when rows survive.
- [Menu-Bar Tray](../../ui/tray/tray.md) — the third surface for this list; it shows the same union and the same degradation rule, and its "Refresh all" is the one place a folder agent is re-read rather than asked to recompute.
- [UI — Settings / Theming](../../ui/settings/settings.md) — severity and overlay tokens live alongside the existing `--color-*` palette.
- [Logger](../../development/logger/logger.md) — remote requests, folder skips, unsupported command forms and failed refreshes all log through scoped loggers visible in the in-app overlay.
