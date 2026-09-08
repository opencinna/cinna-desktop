# Local Agent Permissions — what an agent may do, and what it must ask first

> **The engine half of this is verified against the real binary — see [The OpenCode Engine Contract](opencode_contract.md) §2 and §4.** That document records how a pattern in the profile is actually matched, which rule wins when two match, what the shell tool is gated on, and the proof that OpenCode's own saved grants are user-global. Every rule below rests on one of those observations; none of them is inferred from the OpenAPI document.

## Purpose

What a folder agent is allowed to do on the user's machine, who decides, and where the decision is kept. Two mechanisms, and they answer different questions: a **static profile** generated into the engine config says what never needs asking, and a **standing grant** stored beside the agent records what the user has since said may stop being asked.

## Core Concepts

- **Permission Profile** — the `permission` block written onto every agent entry in the generated engine config (`CONVERSATION_PERMISSIONS`). Identical for every folder agent unless that agent's `cinna-agent.json` overrides it. It is not per-conversation and not editable from the UI
- **Permission Ask** — the engine parking mid-turn on a `permission.v2.asked` event, rendered as a [Parked Request](agent_turn.md#permissions-and-questions-are-tool-parts-there-is-no-permission-part-kind) in the transcript with **Allow once / Always allow / Deny**
- **Action** — the engine's coarse name for the operation (`bash`, `edit`, `write`, `read`, `webfetch`, `external_directory`). Coarser than the tool: the `write` tool asks under `edit`
- **Standing Grant** — one remembered decision: this agent may take this action on this resource without asking again. `{action, pattern, scope, decidedAt}`, stored in that agent's desktop state — `app-data/desktop.json` for a kit folder, a file under `<userData>/external-agents/` for a [bare](bare_agents.md) one, since the desktop writes nothing into an adopted folder
- **Grant Scope** — how widely a grant's pattern reaches: `exact` (the resource character for character), `origin` (a URL prefix the desktop synthesised), `action` (the whole action, from an ask that named no resource). **Recorded, never inferred from the pattern's characters**
- **Permissions tab** — the agent page's fifth tab: what the profile allows, what the manifest has overridden, and the list of standing grants with a per-row revoke. Its examples name files the folder actually has — for a bare agent, "editing its own `AGENT.md`" rather than the manifest and `credentials/.env`, because two fictional examples out of three is how a reader comes to discount the third, and the third is the sentence about a command reaching anything they can

## User Stories / Flows

### Ordinary work inside the folder
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
1. The agent page's **Permissions** tab states the profile in plain words, names any part of it the folder's own manifest has replaced, and lists every standing grant newest first
2. Each row can be revoked; **Forget all** clears them. The agent asks again next time it needs it
3. The tab carries a count badge, so a standing grant is discoverable without opening the tab

### The rule could not be saved
1. The store refuses the write — the folder has gone away, the disk is read-only
2. **The action still goes ahead.** The user said yes, and a failed write must not cancel a decision they made
3. The block says "Allowed once — the rule could not be saved." They are asked again next time

## Business Rules

### An agent works freely inside its own folder

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

OpenCode's own *Always* writes `{projectID: "global", action, resource: "*"}` into `~/.local/share/opencode/opencode.db`: no directory, no session, no agent, shared with the user's personal OpenCode install, surviving restarts. A grant made in one agent folder was watched authorising a *different* folder agent with no prompt at all. The full observation is [the contract](opencode_contract.md) §4.

Replying `once` persists nothing there — verified the same way. So the desktop opts out of the engine's store completely: the rule is kept beside the agent, the engine is told `once`, and its saved store stays empty forever. `projectID: "global"` never gets a chance to matter.

This is **finer** granularity than OpenCode offers, not merely equivalent: the engine's own `save` only ever offers `["*"]`, while a desktop-held rule names one command, one path or one origin, for one agent.

There are two locks on that rule, not one. The answer path converts `always` into a stored grant plus `once`; the runner's engine door **downgrades any stray `always` to `once` and logs loudly**, because a caller that settled a request with `always` some other way would otherwise write a user-global row authorising every folder agent, and nothing in a test would notice.

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

The optimistic removal used to happen before the outcome was read, so an answer main refused took the buttons with it: the block greyed out, the error line said the request had expired, and there was no other way to answer it. A refusal now leaves the block exactly as it was, with the error beside the control that raised it.

### Grants live in the folder, and that is what makes them the agent's

Deleting the folder takes its grants with it; a folder that moves keeps them. `app-data/` is in the contract's `cloud_import_excludes`, so a grant cannot travel inside a published bundle and arrive pre-approved on somebody else's machine.

Reads go to disk on every call rather than through a cache. An ask is a human-paced event and the file is a few hundred bytes; a cache would exist only to go stale against the user's own editor, the agent's own writes to that file, and the revoke button.

### Revoking is not destructive, so it does not confirm

Nothing is lost that the agent cannot ask for again, which is what the empty state promises. A failure is reported in a line under the list rather than in a dialog, and the mutation is owned by the card rather than by the row — a row unmounts the moment its grant is forgotten, and a handler owned there would go with it.

### A manifest can replace part of the profile, and the card says so

`runtime.permissions` in `cinna-agent.json` is merged **shallowly**, one permission name at a time, replacing a whole entry rather than deep-merging its pattern map — a deep merge would let a manifest add `"*": "allow"` *underneath* our `bash` rules and quietly widen them. Where a manifest does override something, the Permissions card names which permissions were replaced, because the fixed paragraph above it is no longer the whole truth and quietly describing rules that are not in force is worse than saying nothing.

> **Flagged, unchanged from Phase 5:** the justification for allowing an override at all is that the folder is the user's own. That stops being true the moment a folder is installed from the cloud into a shell-capable engine. Revisit before cloud install lands.

## What this deliberately does not do

- **It does not prune OpenCode's own saved store.** If `~/.local/share/opencode/opencode.db` already carries a grant — from the user's personal OpenCode usage, or from another client on the same `opencode serve` — the engine allows without asking and nothing here is consulted. The desktop can only gate what it is *asked* about. Pruning mutates state the user's own install depends on, so it has to be a consented action rather than a silent one, and it is not built. See [the contract](opencode_contract.md) §4.2
- **It is not a sandbox, and does not claim to be.** See "The folder is a boundary for the file tools, not for the shell"
- **It does not offer profile editing in the UI.** The profile is generated; the only per-agent override is `runtime.permissions` in the manifest, edited as a file
- **It does not survive a publish.** A grant is machine-local by construction, like everything else about a folder agent — see [Local Agents Are Not Synced](local_only.md)
- **It holds no history.** A revoked grant leaves no record that it existed; the list is the current state, not a log

## Architecture Overview

```
Static half — generated once per config build
  configGenerator (CONVERSATION_PERMISSIONS + manifest runtime.permissions)
      └─► <userData>/engine/opencode.json  ──► opencode serve

Dynamic half — one ask, mid-turn
  engine: permission.v2.asked
      └─► TurnStream.permissionAsked
             ├── standing grant covers it? ──► asked{auto:true}, nothing written
             │        └─► runner.autoAllow ──► POST …/permission/{id}/reply {once}
             │                                  (retry once, then reject)
             └── otherwise ──► block in the transcript + pendingRequests.register
                                        │
   Renderer  PermissionRequestBlock ── agent:answer-request ──► IPC
                                        │  always ─► rememberPermissionGrant
                                        │            (app-data/desktop.json)
                                        │            then settle as `once`
                                        └──► runner replies to the engine
                                             (any stray `always` → `once`)

  Agent page ── local-agent:grants-list / grant-forget / grants-clear ──►
                permissionGrantService ──► app-data/desktop.json
```

## Integration Points

- [The Local Engine, Runtimes & Prompt Assembly](engine.md) — generates the profile into the config, and owns the merge with a manifest's `runtime.permissions`
- [The Agent Turn Runner](agent_turn.md) — where an ask becomes a parked request, how the answer travels out of band, and why there is no `permission` part kind
- [The OpenCode Engine Contract](opencode_contract.md) — the matcher, the rule-resolution order, the shell tool's gating, and the proof behind §4
- [Agents Tab & Agent Page](agents_tab.md) — the page the Permissions tab lives on
- [Kit Contract & Manifest Layer](kit_contract.md) — `runtime.permissions` in the manifest schema, and `cloud_import_excludes` keeping `app-data/` out of a publication
- [Local Agents Are Not Synced](local_only.md) — why a grant is machine-local by construction
- Sub-doc: [Technical Details](permissions_tech.md)
