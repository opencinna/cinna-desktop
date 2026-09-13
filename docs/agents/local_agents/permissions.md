# Local Agent Permissions — what an agent may do, and what it must ask first

> **The engine half of this is verified against the real binary — see [The OpenCode Engine Contract](opencode_contract.md) §2 and §4.** That document records how a pattern in the profile is actually matched, which rule wins when two match, what the shell tool is gated on, and the proof that OpenCode's own saved grants are user-global. Every rule below rests on one of those observations; none of them is inferred from the OpenAPI document.

## Purpose

What a folder agent is allowed to do on the user's machine, who decides, and where the decision is kept. The selected engine supplies its base policy: OpenCode uses a **static profile** generated into its config, while Claude and Codex use their CLI approval mechanisms. A **standing grant** records what the user has since said may stop being asked, and is shared infrastructure for all three engines. On the [Claude](claude_engine.md) engine, the agent's **Approvals** setting decides whether Claude Code's own reviewer answers first, and by default it does.

## Core Concepts

- **Permission Profile** — the `permission` block written onto every OpenCode agent entry in the generated config (`CONVERSATION_PERMISSIONS`). Identical for every OpenCode folder agent unless that agent's `cinna-agent.json` overrides it. It is not per-conversation and not editable from the UI
- **Permission Ask** — the engine parking mid-turn on an ACP `session/request_permission` request, rendered as a [Parked Request](agent_turn.md#permissions-and-questions-are-tool-parts-there-is-no-permission-part-kind) in the transcript with **Allow once / Always allow / Deny**
- **Action** — the name the engine that raised the ask gave the operation. On the OpenCode engine that is a coarse one (`bash`, `edit`, `write`, `read`, `webfetch`, `external_directory`), coarser than the tool: the `write` tool asks under `edit`. On the [Claude](claude_engine.md) engine it is that engine's own tool name (`Bash`, `Edit`, `WebFetch`). Codex uses namespaced `codex:<kind>` actions. **The engine vocabularies remain separate**, so a rule written on one engine cannot silently authorise the other; what they share is only the sentence the user reads
- **Standing Grant** — one remembered decision: this agent may take this action on this resource without asking again. `{action, pattern, scope, decidedAt}`, stored in that agent's desktop state — `app-data/desktop.json` for a kit folder, a file under `<userData>/external-agents/` for a [bare](bare_agents.md) one, since the desktop writes nothing into an adopted folder
- **Grant Scope** — how widely a grant's pattern reaches: `exact` (the resource character for character), `origin` (a URL prefix the desktop synthesised), `action` (the whole action, from an ask that named no resource). **Recorded, never inferred from the pattern's characters**
- **Approvals** — separate per-agent settings for [Claude](claude_engine.md) and [Codex](codex_engine.md). Codex defaults to **Ask for approval** for sandbox escalations; **Automatic** delegates those to Codex's reviewer, within the same workspace-write sandbox. On Claude: who answers an ask *before* the desktop does. **Automatic** (the default) puts Claude Code's own reviewer in front — the classifier a terminal `claude` runs with auto mode on — and the desktop's block is the backstop for what it declines; **Ask every time** brings every command, edit, write and fetch to the block. A per-agent choice, set on the Permissions tab, stored beside the grants for either kind of folder and never in a manifest; null is *no choice made* and reads as the default. There is no third value: the SDK's `bypassPermissions` and `dontAsk` would take the grants and the block out of the decision and are unreachable
- **Permissions tab** — a tab under the agent page's **Settings**: what the profile allows, what the manifest has overridden, and the list of standing grants with a per-row revoke. For a Claude or Codex agent the OpenCode profile paragraph gives way to its own Approvals setting and its control, since the profile describes rules that are not in force on that engine. Its examples name files the folder actually has — for a bare agent, "editing its own `AGENT.md`" rather than the manifest and `credentials/.env`, because two fictional examples out of three is how a reader comes to discount the third, and the third is the sentence about a command reaching anything they can

## User Stories / Flows

### Ordinary work inside the folder, on OpenCode
1. The agent reads a file in its folder, writes a script, runs it. Nothing is asked and nothing appears in the transcript beyond the tool calls themselves
2. That is the profile, not a grant. Nobody had to allow it and there is nothing to revoke

### Something the folder boundary does not cover
1. The agent wants to open a file outside its own folder, fetch a URL, edit its own manifest or workflow prompt, run a command that names a key file, or run `sudo` / `rm -r`
2. The engine parks and a permission block appears **inside the streaming answer**, naming the action as a phrase — "The agent is asking to fetch from the web", not "asking to run webfetch" — with the resources listed under it
3. The user answers. The turn is still streaming; the answer goes back by request id, out of band

### Telling it to stop asking
1. The user clicks **Always allow**
2. Under the buttons, and only where the grant is wider than the ask, a line says what will be remembered — a URL widened to its origin, or an ask with no resources at all that can only be remembered as the whole action. For a path or a command the pattern *is* the resource listed two rows above, so the line is not shown; a sub-line that repeats what it sits under is noise
3. The rule is written to that agent's folder **while the user waits**, the engine is told `once`, and the transcript records "Allowed, and remembered for this agent."

### The same ask, later
1. A matching ask arrives on a later turn
2. **Nothing is written to the transcript.** No block appears, the engine is answered `once` automatically, and the tool call it authorises shows up on its own exactly as it would for anything the profile allows outright
3. A block that appeared and answered itself milliseconds later would be a widget the user cannot act on, in the middle of streaming text

### Reviewing what an agent may do
1. Open the agent page, choose **Settings → Permissions**. The tab states the profile in plain words, names any part of it the folder's own manifest has replaced, and lists every standing grant newest first
2. Each row can be revoked; **Forget all** clears them. The agent asks again next time it needs it
3. The tab carries a count badge, so a standing grant is discoverable without opening the tab

### The rule could not be saved
1. The store refuses the write — the folder has gone away, the disk is read-only
2. **The action still goes ahead.** The user said yes, and a failed write must not cancel a decision they made
3. The block says "Allowed once — the rule could not be saved." They are asked again next time

### Choosing who approves, on Claude
1. On a Claude agent's **Settings → Permissions** tab, the user reads one paragraph describing both settings — *Automatic*, which in testing approved everything it was shown including a force push and a change to the global git config, and *Ask every time* — and picks one from the **Approvals** select. No choice made shows as *Automatic*
2. The change saves at once and the control stays on the pick for the whole round trip. A refused save (the agent is mid-turn) is one line under the control and the select shows the stored value again
3. On *Automatic*, the next turn's routine commands run without a block; what the reviewer would decline reaches the grants and the block as on *Ask every time*. On a model without a reviewer the turn asks every time regardless and a notice in the transcript says why
4. On *Ask every time*, every command, edit, write and fetch is a block — or silent, where a grant already covers it — exactly as on the other engine

## Business Rules

### Codex approvals retain the sandbox and their complete request scope

Codex defaults to **Ask for approval**, with workspace writes permitted and network access disabled until escalated. **Automatic** uses Codex's reviewer inside that same workspace-write policy. Normal temporary-directory allowances remain, and reads do not all require escalation. The adapter calls the first mode `read-only`; the name must never become a claim that workspace files are read-only. `runtime.permissions` is an OpenCode profile override and is not translated for Codex.

The independent `codexApproval` value is stored with desktop state, never in the manifest. Both new and loaded sessions receive the selected mode before a prompt; a refusal stops startup. Grants answer only asks forwarded to Cinna.

Codex execute grants hold raw input, title, content and locations as **one exact scope**. The initial raw-input-only shape omitted SOCKS host and protocol carried in the adapter's presentation fields, allowing a saved grant for one host to cover another. Splitting command, cwd and extra privileges into separate resources would also let unrelated grants combine into broader rights. Edit asks retain every touched path; all must be covered. Unknown requests with no usable scope get an exact request-ID resource, never a whole-action grant. See [Codex security](codex_engine_tech.md#security).

### An agent works freely inside its own folder

The generated rules in this section apply to OpenCode; Codex's sandbox policy is described above.

A session's `location.directory` **is** the agent folder, so every resource the engine names is relative to it and a shell command starts there. `read`, `edit`, `write` and `bash` are therefore `allow`.

This is a deliberate widening. The profile before it allowed writes only under `app-data/` and only three shapes of command, which meant the agent could not write a script it had just been asked to write without a dialog. **A permission prompt that fires constantly is not a control; it is a thing users learn to click through.** What is left asking is what the folder boundary does not cover.

### The catch-all has to be written down

`'*': 'ask'` is an explicit entry. OpenCode's own base rule is allow-everything for every permission name — read back off a running engine, not assumed — so a profile that enumerates only the tools it knows about leaves *every other tool* on allow, which is the opposite of what enumerating them was for.

### The last matching rule wins, not the most specific

The engine resolves a permission with a `findLast` over the concatenated rule list, and the desktop's block is merged **after** OpenCode's own base profile. Two consequences, both load-bearing:

- Our `'*': 'ask'` lands after their allow-everything, which is what makes it take effect
- Inside one permission name, `'*': 'allow'` must come **first** and the narrow shapes after it. Swap them and every narrow entry is dead — and dead in the direction of allow, silently

It also means our `read: {'*': 'allow'}` switches off the engine's own built-in `.env` protection. The desktop's secret-file entries are the only defence left, which is why they are not a duplicate of something the engine already does.

### The pattern language is not a glob, and a missed pattern fails open

A pattern is regex-escaped, then `*` becomes `.*` and `?` becomes `.`, anchored end to end. So `*` crosses `/` freely and **there is no `**`**.

`**/.env` compiles to something that *requires a slash*, so it never matches a `.env` at the agent-folder root — and the root is exactly where a resource is the bare string `.env`, because resources are relative to the worktree and the worktree is the agent folder. Written that way, the entry simply does not apply and the `'*'` rule above it decides: **a missed pattern fails open, and silently.** The profile therefore spells secret files as `*.env` / `*.pem` / `*.key`, spells identity files as exact relative paths, and spells `**` nowhere at all.

### Secret files are denied for writes as well as reads — for the file tools

`credentials/.env`, and anything matching `*.env`, `*.pem`, `*.key`, are `deny` under `read`, `edit` **and** `write`. Reads because the desktop never reads credential values and neither should the agent it runs — the kit's rule is that a value is read from inside a script and never printed, and an `ask` here would put a one-click path to pasting the user's secrets into a transcript behind a dialog nobody reads carefully. Writes because the folder is now writable: without the entry, `'*': 'allow'` would have made `credentials/.env` editable by the agent, which is a regression the widening could have shipped silently. The desktop's own `.env` editor is how a key gets written.

`credentials/.env` is listed even though `*.env` already covers it, so a reader does not have to run the matcher in their head to see that it is denied.

### The agent's own identity files ask

`cinna-agent.json`, `docs/WORKFLOW_PROMPT.md` and `AGENT.md` are what the agent *is* — the system prompt the conversation is running on, and the manifest binding it to a credential. The assembled prompt already ends by telling the agent not to switch to the builder role for this reason, and **an instruction is not a control.** Rewriting them is the one edit inside the folder worth a dialog, and now it is worth exactly one, because *Always allow* remembers it. <!-- nocheck -->

`AGENT.md` is the [bare agent](bare_agents.md) entry, and the list covers both folder shapes at once rather than being built per agent. A kit folder rarely has an `AGENT.md`; where it does, asking before it is rewritten is right for the same reason. One dialog on a file that is not this agent's identity costs far less than the profile's own stated rule quietly not holding for the one kind of agent whose whole identity is a single file.

**`README.md` is deliberately not on the list, so half of one sentence is enforced and half is only instruction.** A bare agent's closing prompt line names `AGENT.md` *and* `README.md` as the builder's, because for that shape the README is what an assistant opening the folder is briefed from. Only the first is a control, and that is a considered position:

- The list is **global**, so adding `README.md` would ask on every kit agent's plain documentation — which the template ships. That is the fires-constantly failure the profile was widened to undo
- "Update the README" is ordinary work to ask an agent pointed at a repository for, in a way "rewrite your own instructions" never is
- The blast radii differ in kind. `AGENT.md` changes what the agent *is* on the next turn, silently and durably, with no human in the path. `README.md` changes text a **person** then reads and pastes, and in the git working tree this shape targets it is visible in `git status` and revertible

What would reverse it: an init prompt consumed automatically rather than pasted by a person. The human is then no longer the control, and `README.md` belongs here — as a bare-only profile, since the first reason still stands.

### `sudo` and `rm -r` are an accident boundary, not a security one

They ask, and the honest reason is small: the accident they exist for is a confused model tidying up. A pattern over a command line is walked around with a `&&`, and anything that runs a shell can do anything the user can. `rm -r *`, `rm -rf *` and `rm -fr *` are three separate entries because each is a literal prefix — `rm -r *` does not match `rm -rf /tmp/x` — and none of them catches `rm --recursive` or `find . -delete`.

The two `.env` shapes under `bash` — `*.env*` and `*credentials/.env*` — are the same kind of guard. What the engine matches there is the full command text of each command node, **redirection included**, which is why `printf 'K=v' >> credentials/.env` asks. So they catch the obvious spelling of the mistake this exists for — a model that decides to `cat` a key file while debugging — and not a path built from a shell variable, a `base64 -d`, or a script that reads the key itself; nothing over a command line could. `*credentials/.env*` and not `*credentials/*`, deliberately: the kit ships `credentials/README.md` and expects the agent to read it, and a prompt on that would teach the user to click through these.

### The folder is a boundary for the file tools, not for the shell

This is the trade `bash: allow` makes, and it is stated here rather than left to be discovered. The engine gates a command by its **text**, and raises `external_directory` only for the path arguments of a fixed list of commands (`cd`, `rm`, `cp`, `mv`, `cat`, …). So `python3 -c "open('~/.ssh/id_rsa')"` raises nothing, and neither does a path assembled at runtime.

The desktop says this on the Permissions card in the user's own words — a command is like a terminal left open in that folder — rather than describing the profile as a fence it is not. **Anyone tempted to call this profile a sandbox should read this rule again.**

### `always` never reaches the engine

OpenCode's own *Always* writes `{projectID: "global", action, resource: "*"}` into `~/.local/share/opencode/opencode.db`: no directory, no session, no agent, shared with the user's personal OpenCode install, surviving restarts. A grant made in one agent folder was watched authorising a *different* folder agent with no prompt at all. The full observation is [the OpenCode contract](opencode_contract.md) §4, and it was re-taken over ACP — see [the ACP contract](acp_contract.md).

Replying `once` persists nothing there — verified the same way. So the desktop opts out of the engine's store completely: the rule is kept beside the agent, the engine is told `once`, and its saved store stays empty forever. `projectID: "global"` never gets a chance to matter.

This is **finer** granularity than OpenCode offers, not merely equivalent: the engine's own `save` only ever offers `["*"]`, while a desktop-held rule names one command, one path or one origin, for one agent.

The lock is now in the option picker, and it is stronger than the two it replaces. The answer path still converts `always` into a stored grant plus `once`, and over ACP `pickPermissionOption` **filters `allow_always` out of the agent's own option list before it searches** — so there is no id to send even by accident, and an agent that offered nothing else usable is answered `cancelled` rather than handed an invented id. The same measurement was re-taken over the new transport: one `allow_always` in one folder silenced every later ask in that folder, **including in a new session in the same process**.

### A grant is matched by string work, never by a regular expression

The scope is recorded because of a bug in the first cut of this feature. Matching compiled the pattern to a regex with `*` left as `.*`, and a resource is very often a command line the *model* wrote. `rm -rf build/*`, remembered by a user who read exactly that string on the button, also covered `rm -rf build/../../Documents` — auto-answered `once`, with no block in the transcript and nothing to see afterwards. Compiling agent-authored text to a regex was a second problem on the same line: `*a*a*a*a*a*` against a long resource is catastrophic backtracking on the main thread.

The fix is to stop guessing which asterisks are wildcards:

- **`exact`** — the resource character for character, `*` included. Everything the engine named is stored this way, including a command line, which is **not** widened to its first word (`git *` reads as harmless and covers `git config --global …`)
- **`origin`** — the one case where a grant is wider than the ask. A webfetch ask names one URL with its query string, which would never match again, so it is stored as `https://host/*`; the origin is the unit a user actually reasons about
- **`action`** — an ask that named no resources at all can only be remembered as the whole action, and the button says so in words

A row with no scope at all — written by another build, or edited by hand — **reads as `exact`, never as a wildcard.** A rule that answers a permission ask without asking must not be able to widen itself by omission.

### Every resource must be covered, not any

An ask naming two paths is one decision about both. Allowing it because one of them was granted earlier would let a second resource ride in on the first one's grant. So a grant is stored **per resource** — which is also the unit the user can revoke: forgetting the path they regret does not forget the one they meant.

### The grant is built from the engine's ask, not from the renderer's payload

The pending-request registry carries the ask the engine made, and that is what a grant is derived from. The renderer is the user's own window, so this is not a trust boundary — it is that an answer sent from a stale block would otherwise store a rule for resources the engine never asked about.

### "Remembered" is only claimed where the rule is on disk

The write happens on the answer path, while the user is still waiting, so a store that refused it can change what they are told. The IPC result carries `remembered`, the transcript's decision line is derived from it, and a failed write settles as an ordinary `once`. **A block that claimed a rule the store refused would be the exact shape of lie this widget's tests exist to prevent.**

### An automatic allow retries once, then rejects

An auto-answered ask has no registry entry and no park timer — that is the point, there is no dialog to abandon. So nothing else will unpark the session if the reply does not land, and the turn would run to the 20-minute ceiling: twenty minutes of nothing on screen.

One retry, because the engine is a local process and the realistic failure is transient; an engine that has actually stopped ends the turn through its own close path instead. If the retry fails too, a `reject` is posted — the agent is told denied, the session goes idle by the same path a deliberate Deny takes, and the user gets an answer rather than a hang.

### A refused answer leaves the controls where they were

The optimistic removal used to happen before the outcome was read, so an answer main refused took the buttons with it: the block greyed out, the error line said the request had expired, and there was no other way to answer it. A refusal now leaves the block exactly as it was, with the error on a line **below** the buttons. It used to render above them, so the line appearing pushed the controls down under the pointer the user was about to retry with.

### A block keeps its buttons while its own answer is in flight

An ask can be reported settled before the answer call that settled it has returned: the stream's `input_resolved`, and the optimistic update beside it, may land first. A block that followed only whether the ask was still open dropped its buttons in that gap, collapsed for a frame and moved everything below it. So a block stays live while its own answer is in flight and turns into its decision line when that answer returns. For the same reason the transcript always gives the block its request id; whether the block is answerable is a separate flag, and having an id does not make a replayed block live.

### A block settled elsewhere says how, and keeps its height until it can

A live ask can also be settled without this window's answer: its park expired, or it was answered in another window. The block then shows the turn's own outcome line in place of its buttons — "No answer — the request expired.", or "Not answered — the turn was stopped." where the user pressed Stop, which the driver distinguishes because a release it caused is not a decision nobody made — and it is the same line a reopened chat shows. The stream says an ask is settled and says how in two separate messages, so between them the block keeps its live look and height with every button disabled. It holds only while the turn is streaming, because a replayed block that recorded no outcome would otherwise hold for ever. Before this, a block settled elsewhere lost its buttons without a word about what had happened and collapsed by the height of the button row, about 43 px, jumping whatever sat below it.

### A second ask does not move the first one's buttons

Asks can arrive back to back. With the transcript following the bottom, the second ask's block scrolled the first one's buttons away and put its own *Allow once* exactly where the pointer was, so a click meant for one ask approved the other. While an ask on the current stream is waiting for an answer, the transcript stops following new content: the view stays where it is, and the *Jump to latest* pill says there is more below. The block that raised the ask is still followed into view, and a change to the viewport itself — the composer gaining a line — is still followed, so the buttons never slide under the composer. A block that went live from the registry alone, after a reload, does not hold the view, and neither does a nested agent's ask, which has no block on screen. The mechanics are in [Transcript Scrolling](../../chat/conversation_ui/scroll_following.md).

### Known issues in the block

- **Answering one of two stacked asks moves the other.** The answered block's button row is replaced by its shorter decision line, so a block below it moves up by about 12 px. The hold stops new content from moving a block; it does nothing about a block above it changing height
- **A block the stream did not announce turns live late, and grows.** After a reload, or for an ask raised before this window subscribed to the turn, the block renders read-only first and becomes the live card only when the registry read lists it — on mount after a reload, up to one 700 ms poll tick mid-stream — growing by about 43 px as its buttons appear
- **A nested agent's ask cannot be answered.** An orchestrated folder agent's ask is recorded but has no control, so it ends at its park timeout — see [Orchestrated Agents](../../chat/orchestrated_agents/orchestrated_agents.md)

### On Claude, Automatic stands in front of both mechanisms, and the block is a backstop there

A Claude agent runs with the CLI's own reviewer in front of the desktop unless told otherwise, and that reviewer was not seen to decline: across seven probes chosen to be declined — a force push, a global git config rewrite, a write under the home directory, commands injected through the system prompt that the user's turn justified none of — the desktop's callback never fired ([the Claude contract, §10](claude_contract.md#10-auto-mode--the-classifier-in-front-of-canusetool-and-what-it-approved)). The callback is still passed, so a grant and the block stand behind whatever it would refuse; but every surface that describes the setting says *backstop* and *without a gate* rather than *asks for anything unusual*, because the second would describe a gate that was not seen to close.

Automatic is the default all the same. Before the setting existed every Claude agent ran the SDK's `default` mode, which asks for every `Bash`, `Edit` and `Write` — including the `ls` and `git status` a terminal `claude` in auto mode runs without a word — and a user who had never seen those prompts in the terminal read the desktop as broken. A prompt that fires on `ls` is the failure this whole document's profile exists to prevent on the other engine, and the same rule holds here.

### The Approvals setting is stored beside the grants, never in a manifest, for either kind of folder

Which engine runs an agent is what the agent *is* and travels in a kit manifest; how far this machine trusts it is the same kind of fact as a standing grant. So the choice lives where the grants do — `app-data/desktop.json` in a kit folder, the file under `<userData>` for a bare one — through one unstamped write that touches nothing the folder publishes, so a kit agent's setting needs no stamp and a bare agent's is not refused. Null means *no choice made* and is stored as null, not as today's default, so a change of default reaches every agent that never chose. A value on disk that is not one of the two settings — a hand edit reaching for the SDK's own vocabulary — reads as null, never as the more permissive setting by accident, and the setter refuses to write one.

### Grants live in the folder, and that is what makes them the agent's

Deleting the folder takes its grants with it; a folder that moves keeps them. `app-data/` is in the contract's `cloud_import_excludes`, so a grant cannot travel inside a published bundle and arrive pre-approved on somebody else's machine.

Reads go to disk on every call rather than through a cache. An ask is a human-paced event and the file is a few hundred bytes; a cache would exist only to go stale against the user's own editor, the agent's own writes to that file, and the revoke button.

### Revoking is not destructive, so it does not confirm

Nothing is lost that the agent cannot ask for again, which is what the empty state promises. A failure is reported in a line under the list rather than in a dialog, and the mutation is owned by the card rather than by the row — a row unmounts the moment its grant is forgotten, and a handler owned there would go with it.

### A manifest can replace part of the profile, and the card says so

`runtime.permissions` in `cinna-agent.json` is merged **shallowly**, one permission name at a time, replacing a whole entry rather than deep-merging its pattern map — a deep merge would let a manifest add `"*": "allow"` *underneath* our `bash` rules and quietly widen them. Where a manifest does override something, the Permissions card names which permissions were replaced, because the fixed paragraph above it is no longer the whole truth and quietly describing rules that are not in force is worse than saying nothing.

> **Flagged, unchanged from Phase 5:** the justification for allowing an override at all is that the folder is the user's own. That stops being true the moment a folder is installed from the cloud into a shell-capable engine. Revisit before cloud install lands.

## What this deliberately does not do

- **It does not prune OpenCode's own saved store.** If `~/.local/share/opencode/opencode.db` already carries a grant — from the user's personal OpenCode usage, or from anything else that has driven this engine on this machine — the engine allows without asking and nothing here is consulted. The desktop can only gate what it is *asked* about. Pruning mutates state the user's own install depends on, so it has to be a consented action rather than a silent one, and it is not built. See [the contract](opencode_contract.md) §4.2
- **It is not a sandbox, and does not claim to be.** See "The folder is a boundary for the file tools, not for the shell"
- **It does not offer profile editing in the UI.** The profile is generated; the only per-agent override is `runtime.permissions` in the manifest, edited as a file
- **It does not survive a publish.** A grant is machine-local by construction, like everything else about a folder agent — see [Local Agents Are Not Synced](local_only.md)
- **It holds no history.** A revoked grant leaves no record that it existed; the list is the current state, not a log
- **On the [Claude](claude_engine.md) engine it does not govern the whole tool surface.** Read-only tools never raise a permission request there at all — a `Read` runs with no ask — so the grants there cover the mutating surface only, on either Approvals setting. Gating everything would need a different mechanism, and this says so rather than claiming a completeness it does not have
- **It offers no way to take the desktop out of the decision.** The SDK's `bypassPermissions` and `dontAsk` are not on the Approvals select, are refused by the setter, and read as *no choice* off disk. Either would run every tool with no grant consulted and no record in the transcript, and a turn run that way is indistinguishable afterwards from one that was not
- **It does not feed the reviewer the user's own environment context.** The `autoMode.environment` lines in `~/.claude/settings.json` are what `settingSources: []` withholds, and the Claude engine never reads that file; the reviewer was seen running with `repoVisibility: unknown` and nothing else

## Architecture Overview

```
Static half — generated at the top of every OpenCode turn
  configGenerator (CONVERSATION_PERMISSIONS + manifest runtime.permissions)
      └─► <userData>/acp/opencode/<hash of agent id>/opencode.json
             └─► the agent's own `opencode acp` child process

Dynamic half — one ask, mid-turn, on either engine
  agent: session/request_permission        (a BLOCKING request; the park is the
      └─► acpDriver.answerPermission        unresolved response, so there is no
             │                              reply endpoint and no id to correlate)
             ├── standing grant covers it? ──► answered `allow_once` at once,
             │                                 nothing written to the transcript
             └── otherwise ──► block in the transcript + pendingRequests.register
                                        │  + needs_input on the turn's stream
                                        │
   Renderer  PermissionRequestBlock ── agent:answer-request ──► IPC
                                        │  driverFor(row).respond
                                        │  always ─► rememberGrant
                                        │            (app-data/desktop.json, or
                                        │             <userData> for a bare agent)
                                        │            then settle as `once`
                                        └──► the blocked request is answered with an
                                             option id — never `allow_always`, which
                                             is filtered out of the options entirely

  Agent page ── local-agent:grants-list / grant-forget / grants-clear ──►
                permissionGrantService ──► app-data/desktop.json

Claude engine — the reviewer in front of all of the above
  Agent page ── Approvals select ── local-agent:set-claude-approval ──►
                desktopStateService.patch {claudeApproval} (beside the grants)
  launcher: session/set_mode  auto | default   (from claudeApproval ?? 'auto',
                                                after EVERY new and load)
      auto    ──► the CLI's own reviewer ──► approved (everything, in the probes)
                                        └─► declined ──┐
      default ──────────────────────────────────────────┤
                                                        ▼
                                         session/request_permission (as above)
  current_mode_update ≠ asked ──► notice: "Automatic approvals are not available here…"
```

## Integration Points

- [The Local Engine, Runtimes & Prompt Assembly](engine.md) — generates the profile into the config, and owns the merge with a manifest's `runtime.permissions`
- [The Agent Turn Runner](agent_turn.md) — where an ask becomes a parked request, how the answer travels out of band, and why there is no `permission` part kind
- [The Codex Engine](codex_engine.md) — workspace sandbox, separate approval default, and exact command/network grant boundaries
- [The Claude Engine](claude_engine.md) — a sibling engine writing into this same grant store, under its own action vocabulary; the Approvals setting that puts the CLI's reviewer in front of it; and why *Always allow* is never persisted into that tool's own rules either
- [The OpenCode Engine Contract](opencode_contract.md) — the matcher, the rule-resolution order, the shell tool's gating, and the proof behind §4
- [Agents Tab & Agent Page](agents_tab.md) — the page the Permissions tab lives on
- [Kit Contract & Manifest Layer](kit_contract.md) — `runtime.permissions` in the manifest schema, and `cloud_import_excludes` keeping `app-data/` out of a publication
- [Local Agents Are Not Synced](local_only.md) — why a grant is machine-local by construction
- Sub-doc: [Technical Details](permissions_tech.md)

## Command-line ACP agents

[Command-line agents](../custom_agents/custom_agents.md) use the same grant-pattern and once-only wire decision rules. Their remembered permissions live under the app’s external-agents state for the captured profile/owner/agent/configuration binding, rather than a local folder. Always writes there before resolving the ACP park; a failed grant write still allows once with remembered false. The command editor lists and revokes current-binding grants, including for disabled configurations. Reconfiguration or ownership changes invalidate captured answers and cannot reuse old grants.
