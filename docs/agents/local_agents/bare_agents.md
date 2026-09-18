# Bare Agents & External Roots

## Purpose

Let a folder the user already owns be an agent. A directory holding an `AGENT.md`, `AGENTS.md` or `CLAUDE.md` — any project that already carries instructions for an assistant — can be adopted as a **bare** agent — no manifest, no kit layout, no conversion — and the folder it was adopted from is registered as an **external** root that the desktop reads and never writes into.

The shape this was built for is a repository of agents a team shares: cloned once, worked on in an editor, and expected to keep working as a repository afterwards. Keeping the folder up to date with its remote is the sibling feature, [Agents Folder Updates](folder_updates.md).

## A note on paths

The same convention as the rest of this folder:

| Written as | Means |
|---|---|
| `src/...`, `docs/...` | A file in **this repository** |
| `AGENT.md`, `AGENTS.md`, `CLAUDE.md`, `README.md` | Inside a **bare agent folder** (a kit folder carries its own `AGENTS.md` and `CLAUDE.md` too; which folder a sentence means is always stated) |
| `Local/<slug>/...`, `cinna-agent.json`, `app-data/desktop.json` | Inside a **kit** agent folder |
| `<userData>/external-agents/...` | Inside the app's own data directory |

## Core Concepts

- **Bare Agent** — A folder that is an agent because it holds an instructions file, and for no other reason. It has no manifest, so no commands, no credential slots, no example prompts and no publications. It *does* choose its own **runtime** — which credential pays for it, and how hard its work is — but the answer is kept outside the folder, because there is no file in the folder to write one into. `LocalAgentDto.kind` is `'bare'`; a kit folder's is `'kit'`
- **Instructions file** — The one file a bare agent *is*: the first of `AGENT.md`, `AGENTS.md`, `CLAUDE.md` its folder holds, resolved in main and carried as `LocalAgentDto.instructionsFile` and `DiscoveredBareAgent.instructionsFile`. Null for a kit agent, and for a bare folder that has none of them right now. `AGENT.md` is the **strong** name; `AGENTS.md` and `CLAUDE.md` are **weak**, and count only where the rules below allow
- **External Root** — A registered `agent_roots` row with `kind = 'external'`: a folder the user pointed at, walked for instructions files. The kit shape is `kind = 'workshop'`
- **The walk** — How an external root's agents are found: up to `BARE_AGENT_MAX_DEPTH` (2) levels below the root, skipping dot-directories and a dependency-tree list, never descending into a folder that is itself an agent
- **Known agent** — A weak folder the walk must keep as an agent whatever appears below it: one with an index row of this root, or with a bare state file that does not read `hidden`. Only a weak folder is ever asked about
- **Positional identity** — A bare agent's row id, `folder:external:<rootId>:<relPath>`. There is no manifest to state a durable one, so where the folder sits *is* its identity
- **Bare state** — `<userData>/external-agents/<basename>-<16 hex of sha256(realpath)>.json`: everything `app-data/desktop.json` holds for a kit agent, kept outside the user's folder, plus the three values only a bare agent keeps there because nothing in its folder can state them — the name the user gave it, whether it is in the list, and its runtime
- **Hidden** — A bare agent that is not in the list although its folder is under a registered root. One state with **two histories** — an agent the user removed, and one they simply did not tick when adopting the folder — because "not chosen" and "removed" have to be the same thing or the next rescan re-adds the ones they declined. Recorded in that agent's state, since the scan walks the whole root every time
- **Re-selection** — Picking a folder that is *already* a registered external root. The dialog reopens its agent list on the state the app is in, and what is ticked when the user saves is the whole set they want: unticking one takes it out of the list, ticking one that was out puts it back
- **Agent role / builder role** — The instructions file is what the agent is told; `README.md` is what anyone *working on* the agent is briefed with — an outside assistant, or the agent itself once the person has asked it to change and it is in building mode. The two documents have different readers, and the split is enforced rather than assumed: `README.md` is named to a building agent, never put into its system prompt

## User Stories / Flows

### Adopting one folder

1. The Agents sidebar's **+** — now "Add an agent" — opens Add an agent: **New agent** scaffolds a kit folder (and a Cinna account also gets **Install from catalog**); **Advanced options** leads to the tiles, where **Add a folder** is adoption and the rest connect external agents
2. **Add a folder** (on the advanced step) opens a native directory picker in main. What was picked is walked, and the result previewed: nothing is registered yet and nothing has been written
3. One folder found means the picked folder *is* the agent. The step shows a single **Name** field, prefilled from the first `# heading` in its instructions file or the folder's own name, so Enter is a complete answer. The hint under it names the file main found — "`CLAUDE.md` is its instructions" — not the first name on the list
4. **Add agent** registers the folder as an external root, scans it, and lands the user on the new agent — adopting is a create in every sense the user cares about, so it obeys the same rule ([UX Rules](../../development/ui_guidelines/ux_rules.md), rule 3). There is no "Build it with…" step: nothing was scaffolded, so there is nothing to hand to an assistant

### Adopting a repository of them

1. Several folders found means the picked folder is a *set*. The step lists them with a checkbox each — the root-relative path underneath — with **Select all** / **Clear all**. The name is the one the app shows: what the user called the agent where they have named it, then the heading in its instructions file, then the folder name, which is the scanner's own order. Listing a renamed agent under the heading in its file is a row the user cannot recognise in a dialog whose whole question is "which of these do you want"
2. A folder that is already an agent under *another* registered root is shown **ticked and disabled**, never filtered out: a list that silently loses the row the user came to add reads as the folder having been scanned wrong. On a first adopt every already-added row is one of those by definition, since the folder being picked is not registered and nothing under it can be its own
3. If the walk stopped at its cap, the step says so above the list — "This is the first N folders found. Pick a folder closer to the agents to see the rest." — because every count under a silently truncated list is true of the wrong set
4. **Add N agents** registers the *whole picked folder* as one root and marks the unticked folders hidden
5. The sidebar puts adopted agents in the picked root's position (with headings governed by the sidebar sections preference), and selects the first adopted agent. Creation/adoption preserves the current page mode; clicking its sidebar row explicitly returns to chat mode

### Coming back to a folder already added

1. Picking a folder that is already a registered external root is a **re-selection**, not a clash. The step opens on the state the app is in: the agents that are in the list ticked, the ones that are not, unticked — so confirming without touching anything changes nothing, and an agent removed earlier is not silently put back by a dialog opened to add a different one
2. A line above the buttons names the root it is already registered as and says the folder on disk is never touched either way; a second, reserved line says what the button is about to do — "1 to add, 2 to remove from the list."
3. There is no single-agent Name step here, however many agents the folder holds. The one thing a re-selection must be able to do is untick, and a step with a text field and no checkbox cannot — and the name field is prefilled from the folder, so sending it back would rename an agent the user had already named themselves
4. Ticking a row that was out puts that agent back, **with its engine sessions**, exactly as ticking it in Settings' **Manage agents** dialog does. Unticking one takes it out of the list, which is the same act as ⋯ → Remove from the list
5. If anything is being taken out, the button confirms first: a step *inside* the dialog — the list the user just edited stays on screen behind it — naming the agents that are leaving, what comes back if they are ticked again, and what does not ([UX Rules](../../development/ui_guidelines/ux_rules.md), rule 5). The checkboxes freeze while it is up, because a question that names agents must act on the set it named
6. **Saving lands on the agent that was added**, not on whichever of the ones already there sorts first. A save that only removed agents lands the user nowhere rather than on somebody else's page

### A pick that cannot be used

The dialog stays on the advanced step and says why, in the Add a folder tile, where the refusal replaces the tile's sub-line. It never closes on a refusal ([UX Rules](../../development/ui_guidelines/ux_rules.md), rule 6). The reasons, in the order they are checked: the folder overlaps a registered root in either direction (including a **workshop** root at exactly this path, where the walk finds nothing anyway), nothing under it has an instructions file that counts, or — outside a re-selection — every agent in it has already been added. Cancelling the picker is not a refusal and says nothing at all.

"Nothing here" lists all three names — except where the picked folder is itself a **kit agent** (`cinna-agent.json`) or a **workshop** (`.cinna-kit/`). Such a folder has an `AGENTS.md` and a `CLAUDE.md` the user can see, which the walk skips on purpose, so "nothing in this folder has one" would be false in front of their eyes ([UX Rules](../../development/ui_guidelines/ux_rules.md), rule 9) and would not say where the folder belongs. The refusal names it as a Cinna agents folder or kit agent, says the `AGENTS.md` / `CLAUDE.md` it actually holds guide building — only the ones present, since naming one that is not there is the same false claim — and points at Settings → Agents → Add an agents folder. A kit-shaped folder holding neither gets the generic copy, which is then true.

Being the *same* external root is no longer among them; that is the re-selection above.

### Working with a bare agent

1. Selecting its sidebar row opens the ordinary chat landing. Choose **Settings** for runtime controls and the detail tabs, with the manifest-shaped parts removed: no **Commands** or **Schedules** tab, and two cards on **Overview** — its **Name**, then its folder's `Readme`, rendered read-only and absent altogether where the folder has no `README.md`. The **Runs with** panel is the same panel a kit agent gets, controls and all
2. **Prompts** is `Instructions` alone (the agent's instructions file, named in the card header — the whole system prompt, editable in place like any other prompt document and rendered as markdown while it is being read)
3. **Permissions** and **Folder** are unchanged: the permission profile is the same for every folder agent — with all three instruction names on its identity-files list, so rewriting the file the agent *is* asks — and the Folder tab shows the bare findings
4. **Open in <tool>**, **Start chat** and the ⋯ menu all behave as they do for a kit agent, with one item fewer in the Open-in menu: **Open credentials/.env** is withheld, because a bare folder declares no credential slots and the desktop never seeds that file there — the same reason the Folder tab hides its Credentials card

### Renaming

1. The Name card on Overview saves on blur and on Enter — not on a pause, because a rename is a decision the user finishes rather than one that lands mid-word
2. The name is kept in that agent's state under `<userData>`, not in the folder, and the card says so
3. **Emptying the field clears the stored name**, which is the only route back to a name that *follows* the file: re-typing the heading by hand pins the name to a string that merely matches, and it stops following the moment the heading changes again. Clearing falls back to the heading in the instructions file, then to the folder name

### Removing

1. **⋯ → Remove agent…** — the wording differs from a kit agent's "Delete agent…" because the outcome does
2. The dialog offers two radio options: **Remove from the list only** (the default) and **Remove and move the folder to the Trash**. The recoverable one is first and selected
3. Removing from the list marks the agent hidden. The folder is untouched, and there are two routes back, both of which the dialog names: re-picking the folder in **+ → Advanced options → Add a folder** reopens its list with this agent unticked, and Settings → Agents shows the count under that root, and that row's **Manage agents** dialog is where the user ticks which ones come back. Naming only a route that does not work is how a choice offered as the recoverable one becomes a dead end ([UX Rules](../../development/ui_guidelines/ux_rules.md), rule 5) — which is what this hint did while re-picking a registered folder was still refused
4. The copy owns the half that cannot be undone: a job that uses the agent "will need it selected again even if you put the agent back". Removing drops the `agents` row and `job_agents` cascades with it; restoring re-creates the row under the same positional id, so chats re-bind, but the job's link does not come back

## Business Rules

### One file makes an agent, under one of three names

A directory holding an `AGENT.md`, `AGENTS.md` or `CLAUDE.md` is an agent, and the first of those it has, in that order, is its instructions file. That is the whole contract for a bare agent, and it is deliberately the smallest one available: the folder the user points at was written before Cinna was involved, and asking it to gain a manifest first is asking for a conversion nobody wanted. What the folder gives up in exchange is everything the manifest carries — see [Kit Contract & Manifest Layer](kit_contract.md#a-folder-that-keeps-none-of-it).

**Three names, because a project that already carries instructions for an assistant is already the thing this feature adopts.** `AGENTS.md` is the cross-tool convention and `CLAUDE.md` is Claude Code's. Accepting only `AGENT.md` told a user pointing at a repository full of either that nothing in it was an agent, and asked them to copy or rename a file they already had. `AGENT.md` is the name only this feature uses, which is why it wins a folder holding several and why it alone is strong.

**The file is resolved in main, per folder, and travels on the DTO.** The system prompt, the Prompts tab's editor, the stamps, the validation findings, the name read from a heading, building mode and the init prompt all use `instructionsFile`. No surface assumes `AGENT.md`, because a card naming `AGENT.md` in a `CLAUDE.md` folder asserts a file that is not there ([UX Rules](../../development/ui_guidelines/ux_rules.md), rule 9). Where none resolved, copy lists the three names instead of picking one.

**The weak names do not count in a kit-shaped folder** — one holding a `cinna-agent.json` file or a `.cinna-kit/` directory. The kit scaffolds both `AGENTS.md` and `CLAUDE.md` into every agent and every workshop root, so counting them there would turn every kit agent in an adopted tree into a bare one, losing its commands, credential slots and declared runtime. `AGENT.md` still counts beside a manifest, as it always has; what that does to the state location is in "The state lives outside the folder".

**A heading that only repeats the file's name is not a name.** `# CLAUDE.md` is a very common first line; a sidebar of rows all called "CLAUDE.md" says nothing. A first H1 equal to the resolved file's name, with or without `.md` and in any case, falls back to the folder name, as an over-long heading already did. Only the first H1 is considered.

### Cinna installs nothing into an external root

No templates, no `.cinna-kit/`, no `Local/`, no `app-data/`. `addExternalRoot` is `addRoot` with exactly those three installs removed, and the state a bare agent needs is kept under `<userData>` instead.

This is the promise the whole shape rests on, and it is not a UI promise: every screen in the adopt flow looks identical whether or not a file was dropped into the user's repository. The E2E specs snapshot the folder tree before and after and compare, because that is the only witness ([E2E Testing](../../development/e2e/e2e.md)).

**It is "installs nothing", not "read only", and the difference is one file.** The agent page's Instructions card is a live editor over the agent's instructions file, so a folder the user edits there *is* written to — by them, deliberately, in the one place the page says so. The Settings badge therefore says "Cinna installs nothing here. The only file it writes is an agent's instructions file (AGENT.md, AGENTS.md or CLAUDE.md), and only when you edit it on the agent's page", and the root's sub-line reads `· not a kit folder` rather than `· read only`. A "read only" promise would leave a user with a modified working tree in a repository they share — and, because a dirty tree refuses a fast-forward, a blocked **Update** two rows below, with neither surface admitting the two are connected. <!-- nocheck -->

### The walk, and what it refuses to look at

- **Depth 0 is the folder itself**, which is why "one agent folder" and "a repository of them" are the same walk: a single agent is found at depth 0, `<repo>/local_agents/<agent>/AGENT.md` at depth 2. `BARE_AGENT_MAX_DEPTH` is 2; deeper than that an ordinary source tree starts matching — a fixture, a vendored dependency, a docs example
- **A folder that is an agent is not descended into.** An agent's own working tree often holds sub-projects with their own instructions; a nested one is part of that agent, not a sibling of it, and listing both gives the user two rows they cannot tell apart
- **An `AGENT.md` below a weak folder wins over it.** A folder whose file is `AGENTS.md` or `CLAUDE.md` is an agent only when no `AGENT.md` folder sits below it within the walk's reach. Otherwise it is walked like any other folder, and the same rule applies again to what is under it. Team repositories of `local_agents/<x>/AGENT.md` very often carry a root `CLAUDE.md` for the people working on them. Read as the one agent, that root would, on the next rescan of a root already registered, prune every agent adopted from it, and their sessions with them. The look below uses the walk's own depth and skips, and never counts toward the cap. A weak folder with only weak folders below it is itself the agent, and is not descended into
- **Unless the weak folder is already a known agent.** The user adopted it or chatted with it, and an `AGENT.md` arriving underneath is one `git pull` away. Turning it into a container would prune its row and cascade its sessions away. Known means an index row of **this** root at that path, or a bare state file for that path that does not read `hidden`. A **hidden** weak folder, removed or never ticked, is deliberately not known. Once an `AGENT.md` appears below it, it becomes an ordinary folder and the walk finds the agents underneath. Nothing is lost, because hiding already deleted its row, and keeping it would leave those agents unreachable behind an agent the user had chosen not to have. A kept folder is an agent like any other, so it is not descended into. Only a weak folder with an `AGENT.md` below it is asked about, so the common walk reads neither the index nor a state file
- **Every walk that answers "which agents are in this root" uses the same known-agent answer**: the scan, the pick preview, adopt, restore, the settings count and the Linux fallback watcher. A preview walked without it would list rows that are not what adopting indexes. A first pick has no root and no rows, so there only a state file that does not read `hidden` makes a folder known
- **Dot-directories and a dependency-tree skip list are never entered** (`node_modules`, `venv`, `__pycache__`, `dist`, `target`, `Pods`, …). Not an optimisation: a dependency tree is exactly where somebody else's stray `AGENT.md` or `CLAUDE.md` lives, and fifteen agents out of `node_modules` would make the picker useless the one time it mattered
- **Symlinked directories are followed**, because a curated set assembled out of links is a real shape. `withFileTypes` reports a link as a link rather than as what it points at, so each entry is stat-ed
- **The walk never throws.** An unreadable subdirectory contributes nothing and the walk continues; one permission-denied folder must not take the whole pick with it
- **It stops at 200 agents** and reports that it did. `truncated` travels all the way out — onto `PickAgentFolderResult` for the dialog and onto `AgentRootDto` for the settings row — rather than only being logged, because a list that is silently partial reads as the scanner having *missed* the folders the user came for, which is the exact diagnosis the cap exists to prevent. The settings side is the worse half: a capped root stays capped, so an agent added to the repository later never appears and no rescan fixes it. The cap is a constant; `discoverBareAgents` takes a **clamped** `limit` that exists only so a test can assert the reporting without building two hundred folders, and clamping is what stops a test-only seam becoming a way to raise it
- **A capped scan does not prune the indexed agents it did not reach.** The cap counts folders in walk order, so a root such as `~/dev` — a few adopted agents among hundreds of `CLAUDE.md` repositories — can stop before reaching some of them. The index is rebuilt from what the scan lists, so an agent the walk missed would be pruned and its sessions cascaded away. The cap exists to bound a pick, not to take agents out of a list the user already built. So when the scan's walk is truncated, each indexed row it did not return is scanned back. That happens only while the folder would still be an agent to an uncapped walk, as far as that can be told without doing it: inside the root within the depth, still resolving an instructions file, and not inside another listed agent. The rows kept this way are sorted into path order with the rest, so the list reads as an uncapped walk would have produced it rather than with the rescued agents at the bottom. `truncated` is still reported. This is the scan's alone; see Known gaps for what that leaves in the pick preview, Manage agents and the cold settings count

### Identity is positional, and `external` is not `legacy`

A bare agent's row id is `folder:external:<rootId>:<relPath>`, keyed by root **and** root-relative path: one root can hold `a/support` and `b/support`, and two roots can hold the same layout. The path is POSIX-separated so the id does not depend on which platform scanned the folder — `a2a_sessions` cascades from this value, and a row written on one machine has to read as the same agent on another.

`LocalAgentIdentity` gained `'external'` as a value distinct from `'legacy'`, even though both are positional. The fix offered for a legacy folder is **Stamp identity**, which writes a UUID into a manifest; a bare folder has no manifest to write one into, so a surface keyed on `legacy` would offer a button that cannot work.

The consequence is the same one a legacy folder carries, and it is worth stating plainly: **moving or renaming a bare agent's folder starts a different agent.** Its chats stay, and stop resolving.

### The state lives outside the folder, and the *root* decides that

`desktopStatePath(agentDir, kind)` returns `<agentDir>/app-data/desktop.json` for `'kit'` and `<userData>/external-agents/<basename>-<hash>.json` for `'bare'`. The hash is over the folder's `realpath`, so a symlink and its target are one agent; the basename is kept in the filename because a directory of pure hashes is impossible to reason about when something has gone wrong.

Why outside the folder: a bare folder is very often a git working tree shared with other people. Dropping an untracked `app-data/` into fifteen agent folders of one repository is a change to their repository nobody asked for — visible in `git status` forever, and exactly the noise the update check beside this feature exists to keep clean.

**The kind comes from the root row (`kindOf(root)`), never from probing the folder.** Deciding it from `existsSync('cinna-agent.json')` would have let every caller keep a one-argument signature, and it was wrong in two reachable ways:

- The walk counts an `AGENT.md` whatever sits beside it, so a folder carrying **both** it and a manifest is adopted as a bare agent — and the probe would then send the adopt's own `hidden` write *into* it, creating the untracked `app-data/` this location exists to avoid, on the first action of adopting the folder
- A bare folder that later **gains** a manifest — one `git pull` away — would silently change where its state lives: `hidden` reverts (a removed agent comes back), `displayName` reverts (the rename is lost), and its sessions, token and standing grants are orphaned

Every caller already knows: the scanner and the service hold `root.kind`, the turn runner holds the agent's DTO.

`DesktopState` therefore gained three fields that only a bare agent uses — `displayName` (the user's own name for it, because no file states one), `hidden`, and `runtime` (the rule below) — and `forgetAt(path)`, which deletes the state file when a bare folder is trashed. Without it the sessions, the token and the permission grants of a deleted agent would sit under `<userData>` forever and be inherited by whatever the user next creates at that path, since the path is the key. A kit agent needs no equivalent: its state was inside the folder and went to the Trash with it.

**`forgetAt` takes the path, not the folder, and the caller resolves it before anything moves.** The key is `realpathSync(agentDir)`; once the folder is in the Trash that call throws and the key falls back to the raw path — a *different* digest wherever any component is a symlink, which on macOS includes everything under `tmpdir()` (`/var` → `/private/var`), an explicitly permitted root location. The unlink then raised `ENOENT` on a file that was never there and left the real one behind, which is precisely the leak the function exists to prevent.

### A bare agent picks its own runtime, and the answer is kept where the folder is not

Which credential pays for an agent and how hard its work is are the two questions a user most needs an answer to, and a folder adopted from somebody's own repository is not a lesser agent for having no manifest. So the **Runs with** panel is the same panel for both kinds, with the same `Runs on` picker, the same Work-Complexity/Advanced pair and the same reserved status line. That includes the **engine**: a bare agent can be put on [Claude](claude_engine.md) or [Codex](codex_engine.md) from the same select, and the same rules follow it — no credential on that path, the tier surviving the switch, the Advanced picker gone.

What differs is one thing: where the choice goes.

- A **kit** agent's runtime is a `runtime` block in `cinna-agent.json`, written under the file's stamp so an assistant editing the manifest at the same moment cannot be clobbered
- A **bare** agent's goes into that agent's state under `<userData>`, as `DesktopState.runtime`. There is **no stamp**, and there is nothing to stamp: the write touches no file in the folder, so no other tool can have changed it underneath, and nothing appears in the user's `git status`. It travels on its own channel for the same reason renaming does — `local-agent:update-field`'s whole contract is a stamped write to a file in the folder, and a stamp for a file the write does not touch guards nothing

The **validation is shared**, deliberately: `runtimeService.validate` is what both writers run, so a key-shaped credential, a model-and-tier pair and an engine-with-credential pair are all refused on this path too. A bare agent's choice never leaves the machine, but a pasted API key does not become safe by landing in `userData` rather than in a file the user commits.

**Every key the panel can write has to be on the read side's allowlist, and the engine is the case that proves why.** `desktopStateService.coerceRuntime` narrows what it reads back to the fields the picker can set — a deliberate narrowing, so a hand-edited state file cannot smuggle in something no control produced. When `engine` was added to the panel and not to that list, the write succeeded and the next read silently dropped it: the picker snapped back to Default in front of the user with nothing reporting a failure, because nothing *had* failed. Caught in review, and the same shape of bug `complexity` would have had at contract 1.1.0.

The scanner then puts both on the same DTO field, `LocalAgentDto.runtime`. That is what keeps this to one difference: `runtimeService.resolve`, the engine's config source, the tier resolution and every message the panel can produce read one field and ask nothing about where it came from. Neither was changed to add this.

**The consequence is the one the rest of the bare state already carries, and the panel says it in a line of its own**: the key is the folder's path, so moving the folder starts a different agent, which runs on the Default runtime until it is told otherwise. That note is scoped to *this choice* — "nothing is written to the folder" would be one tab away from false, since the Prompts tab is a live editor over the instructions file ([UX Rules](../../development/ui_guidelines/ux_rules.md), rule 9).

Only the three keys a picker can set survive a read of the state file — credential, model, complexity. The manifest's block is round-tripped whole because another tool may have written keys we do not know about; this file has exactly one writer, so keeping anything else would be a way for a stale `permissions` map to reach the engine long after the surface that wrote it was gone. A stored object naming none of the three reads as no choice at all, which is the same as the key being absent.

### A bare agent runs like a terminal session in its own folder

**No flag, no manifest key: having no `cinna-agent.json` *is* the choice.** A kit folder is a harness the desktop scaffolded and its session stays sealed; a bare folder is somebody's own repository, so a turn in it is the turn a terminal `claude` or `codex` in that folder would get. The folder's own setup — its settings files, its hooks, its skills, its plugins, its `.mcp.json`, its `.claude/agents/`, and the user's own configuration alongside — is loaded **by the engine**, not assembled by Cinna.

- **The desktop decides this once**, where the folder view for a turn is built, and no launcher asks what kind of folder it has. Cinna's own local-development build session presents as a bare folder — its synced workspace has no manifest — and stays **isolated**, which a rule written as "bare means native" would have got wrong in the one case that matters.
- **What the desktop still supplies is only what the folder cannot know**: that this is a Cinna conversation or an unattended task, where human input comes from, the machine's locale and time zone, where long output belongs, and building mode. That block is appended to the engine's own preset rather than replacing it.
- **The approval setting is the one thing the folder does not get to decide.** The desktop's **Approvals** choice is applied after every session is created or loaded, and it overrides the `defaultMode` in the folder's `.claude/settings*.json`. See [The Claude Engine](claude_engine.md#the-mode-is-set-never-requested-and-permissionmode-is-inert).

**The cost, stated rather than discovered.** A bare folder's `.claude/settings*.json` and its `.mcp.json` now take effect on every turn in that folder, including a user-typed one, and the MCP server starts with **no trust step** — the interactive CLI asks before enabling a project MCP server; the SDK path Cinna uses does not (watched 2026-09-17, `claude` 2.1.274 / adapter 0.76.0). Anything that can land a commit in that repository — a `git pull` included — can therefore choose a process that runs the next time the user chats with that agent. This is exactly why running a *handover* unattended in a bare folder is a per-agent opt-in and not a default.

### The instructions file is pasted in only for the engine that would not read it

The folder is adopted for any of `AGENT.md`, `AGENTS.md` or `CLAUDE.md`, but the two engines read different ones by themselves:

| Engine | Reads by itself | So Cinna pastes in |
|---|---|---|
| Claude | `CLAUDE.md` (as memory) | `AGENT.md`, `AGENTS.md` |
| Codex | `AGENTS.md` | `AGENT.md`, `CLAUDE.md` |

**Claude's half is watched; Codex's is decided.** On 2026-09-17, against `claude` 2.1.274, a folder holding only a `CLAUDE.md` had its fact quoted in the first answer with no tool call, while folders holding only an `AGENTS.md` or only an `AGENT.md` did not: the model went and ran `ls`, `cat` and `grep` to find the same fact. Those two names are **not memory** to Claude Code, so leaving them out would have produced an agent that has to search its own folder for its own job. Codex reading `AGENTS.md` rests on the CLI's documented behaviour; no Codex install was available for that probe.

Pasting in the file the engine has *already* read would be the opposite mistake: the same instructions twice, once as the folder's memory and once as a system prompt the folder never wrote. Nothing in the native prompt says "the instructions above", because on the engine's own native file there is nothing above.

**OpenCode is deliberately still on the old path.** Its prompt travels through the generated engine config, and whether `OPENCODE_CONFIG` merges with or replaces the project's own config is unanswered, so a bare OpenCode agent keeps the whole assembled prompt until it is.

### The prompt is the instructions file and nothing else the folder contains

The kit assembler reaches into `scripts/`, `credentials/` and `knowledge/` because a kit folder has a known shape. A bare folder has no shape at all — it is somebody's repository — so concatenating whatever `.md` files are lying in it would put a changelog, a licence or another agent's notes into the system prompt as instructions.

- **One file, resolved again at every read and every write.** Prompt assembly, the Instructions card's read and its save all resolve the file the way the scan does, so an `AGENT.md` added beside a `CLAUDE.md` is what the agent runs on from its next turn. A save does not trust the file the editor had open. It writes to whichever file the folder has at that moment, under the stamp the editor read. A stamp read from a different file, or from one that has since gone, is refused rather than written over the wrong file. With no instructions file at all nothing is written, so an edit never creates an `AGENT.md` beside a `CLAUDE.md`
- **`README.md` is deliberately excluded.** It is written for the person developing the agent — how to install it, how to run it, what it needs — and a model reads "run `uv sync` first" as a step it should take
- **`README.md` is instead the entry document of the init prompt**, the briefing handed to an assistant opening the folder, falling back to the instructions file. That order is the agent-role / builder-role split made concrete: a README reads to a builder as a briefing, and the instructions file reads to one as a job description — even an `AGENTS.md` or `CLAUDE.md`, which a kit folder would be briefed from first. See [Open in Tools](open_in_tools.md#the-init-prompt)
- **The same split decides where the page shows it: `README.md` is read on Overview, not on Prompts.** Beside `Instructions` it read as a second thing the agent is told, and it was the longer of the two, so the tab whose whole point is the system prompt opened on the document that is not it. Overview asks what this agent is, and for an adopted folder the README is usually the only prose that answers. It is rendered, read-only and whole — no clamp — and where the folder has no README — or holds an empty one — the card is not there at all, because `bare.readme.missing` already states the absence on the Folder tab with the consequence attached. The card's own footer keeps the split explicit: this is what an assistant opening the folder is briefed from, and the agent itself is told only its instructions file, which the footer names. See [Agents Tab & Agent Page](agents_tab.md#a-file-rendered-in-a-card-is-not-a-chat-message)
- **Three of the kit context block's rules are dropped rather than reworded** — run scripts with `uv run`, write only under `app-data/`, and the `credentials/.env` rule. Each describes a folder convention a bare folder never agreed to, and stating a rule about a file that does not exist is how a model ends up refusing ordinary work in the folder it was pointed at. What replaces them is one line saying the folder's own instructions govern how it is run, and that Cinna imposes no convention of its own
- **Building mode is kept, pointed at this shape's own guide.** A person's request to change the agent switches it into building mode exactly as it does a kit agent — no confirmation, for the rest of the conversation, never on its own initiative or for an unattended task ([The Local Engine](engine.md#the-desktop-context-block-and-building-mode)). What differs is where it is sent: `README.md` where the folder has one, the same document the init prompt briefs an outside assistant from, and otherwise the instructions file, which is the whole definition. The README is to be read for how the agent is organised and developed, **as background, not as setup steps to run**. A repository README is install instructions as much as guidance, and a model told to *follow* it runs `make install` before making a one-line change to its instructions. The README is **named, never inlined**, so the exclusion above still holds, and named only when it exists, because a rule pointing at a missing file is how a model ends up refusing the work. Building mode may edit the instructions file, the README where there is one, and whatever else in the folder the change needs; on OpenCode rewriting any of the three instruction names still asks, and nothing asks before the README ([Local Agent Permissions](permissions.md#the-agents-own-identity-files-ask))
- **An empty instructions file never produces a promptless agent.** A stand-in section names the empty file and suggests the person tell the agent what it should do, so it can write the file in building mode — the same rule the kit path keeps for an empty workflow prompt. A folder with none of the three (between the file going and the rescan) gets a stand-in listing them, and building mode is pointed at `AGENT.md`, the file it would write

### Readiness: one error, one warning, two infos

| Finding | Grade | Meaning |
|---|---|---|
| `bare.prompt.missing` | error | The folder has none of the three names (the message lists them, and the finding carries no path, since there is no file to point at), or its instructions file could not be read (the message and path name that file). The folder is not an agent any more, and readiness is `invalid` |
| `bare.prompt.empty` | warning | The instructions file is there and empty, and the message names it. The agent still runs, on the stand-in prompt |
| `bare.readme.missing` | info | No `README.md`, so an assistant opening the folder is briefed from the instructions file instead — or, with no instructions file either, has nothing to be briefed from. Overview shows no `Readme` card, this finding being where the absence is stated |
| `bare.no_manifest` | info | Always present: this folder runs without commands or credential slots, and the credential picked for it is kept in Cinna rather than in the folder |

**Empty is a warning and not an error**, matching the kit path exactly. An error makes the folder `invalid`, and an invalid folder is dropped from the engine's config with nothing on screen explaining it — the user would be left with an agent that silently cannot run because a file they can see is blank.

`contractStatus` is `ok`, deliberately not `unknown`: that value means "a manifest states a version we could not parse" and the page offers a re-stamp for it. A bare folder makes no claim about the contract at all.

**`local-agent:validate` short-circuits for an external root** and returns the scan's own findings. The kit validator run on a bare folder reports a wall of errors about a missing manifest, missing prompt documents and a missing layout — a contract the folder never agreed to keep, contradicting the findings the same page is already showing.

**Infos are rendered.** They were produced and displayed nowhere, for every kind of agent; the Folder tab's Validation card now lists them under the errors and warnings, quieter. They stay **out** of the tab's count badge, which remains errors + warnings: a badge on every healthy folder is the banner-in-the-healthy-state failure, and an info is by definition not attention. For a bare folder this is where "no `cinna-agent.json`, so no commands or credential slots, and the credential you pick is kept in Cinna rather than in the folder" has its home — until then the only place that fact appeared was a note in the Runs-with panel restating a label two lines above it.

### Adopting is two calls, and the pick is what authorises the second

`local-agent:folder-pick` opens the native dialog in main and previews what it found; `local-agent:folder-add` registers it. The path therefore has to travel out to the renderer and back, so the service records the pick in a module-level `pendingPick` and the adopt refuses any path that is not the one last picked (and any other user). That is the two-step form of the rule `local-agent:root-add` keeps in one step: **the renderer may not name a folder the user did not just choose.** The record is cleared on a successful adopt and on a refused pick, so a stale one cannot authorise a later call.

Splitting pick from adopt is what makes the preview possible at all — the user sees the fifteen agents that were found before anything is registered.

**An adopt that indexes nothing is a failure, and the root it just created is dropped.** Everything up to the scan can succeed against a folder that is no longer there: the preview is a separate call, and between the two the user can eject the volume, move the folder or delete it. Without the check the dialog closed on a folder that never appeared, leaving a registered root with no agents and nothing anywhere saying why — and the *next* attempt then refused for overlapping a root the user could not see the point of. `addAgentFolder` answers `AddAgentFolderResult { root, agentIds }` rather than the root alone, so the dialog can land the user on the agent they just added.

**Only a root this call created is dropped again.** A folder that was already registered keeps its registration when the folders the user ticked turn out to be gone: with the root would go its watcher, its git update check and every agent the user did not just touch, and none of that should fall over because one folder went missing between the preview and the confirm.

**An empty list is a failure on a first adopt and a real answer on a re-selection.** "Nothing ticked" cannot be adopted, so it is refused; the same list on a folder already registered means "take all of these out", and it is performed — the root stays, the folders stay, and both routes back (re-pick, or the row's **Manage agents** dialog in Settings) still work. Disabling the button there would promise a removal in one line of copy and refuse it silently in the next.

### The whole picked folder becomes the root, whatever was ticked

The root is *where to look*, not *what was found*. Two reasons: the walk has to be able to find an agent folder that arrives later, and the update check works on the repository rather than on one folder inside it.

So an unticked folder is recorded as **hidden** rather than left out. "Not chosen" and "removed from the list" have to be the same state, because the scan walks the whole root and the next rescan would otherwise add the folders the user declined. The flag is written for every folder whose state would *change*, not only the unwanted ones: re-adopting a repository whose agents were previously removed has to clear it, or the second add appears to do nothing — and on a re-selection, unticking one is how it leaves the list again. A folder whose state already reads that way is skipped, because the patch is a read-modify-write of the whole file and doing it for fifteen untouched agents is fifteen chances to land on a stale snapshot, the engine session a running turn wrote a millisecond ago among them.

### `relPaths` is the whole desired set, not an addition to it

On a re-selection, what the user ticked *is* the list they want: a path left out is removed exactly as ⋯ → Remove from the list would remove it. Three rules follow, and each of them was a defect first:

- **Every removal's turn lock is checked before anything is written.** The locks used to be taken one at a time inside the loop, and acquiring one throws — so an agent earlier in the walk was already hidden on disk when a later one refused, and the dialog said "nothing was changed" ([UX Rules](../../development/ui_guidelines/ux_rules.md), rule 5) over a folder where something had been. The index was never reconciled either, so that agent vanished from the sidebar at the next unrelated rescan with no action of the user's to attribute it to. The removal itself still takes the lock, for the turn that started in the intervening few lines
- **A `name` is applied only to an agent being *added*.** The field is prefilled from the folder, so writing it back over an agent already in the list renamed it — silently, from a dialog whose copy promises the folder is untouched and says nothing at all about names. Main ignores it for an agent it is not adding, and the renderer does not send it on a re-selection at all: the same rule on both sides of the boundary
- **An agent put back this way gets its engine sessions back**, through the same reseed a Settings restore runs: `a2a_sessions` cascaded away with the row, so without it the chats re-bind and the model has forgotten the conversation the transcript still shows

The root's watcher is refreshed afterwards as well. `watchRoot` returns early for a root already watched at this path, which would leave the agents a re-selection just added without a per-directory watcher on the non-recursive fallback.

The result is the ticked agents, ordered **newly added first**, and that only matters here: re-selecting a repository to add its sixteenth agent must land on that agent, not on whichever of the fifteen already there sorts first. On a first adopt every entry is new and the order is the walk's. Where the user's own selection produced no readable agent — a ticked folder that has gone since the preview — the answer falls back to everything the scan did index, rather than being empty and reading as the deliberate emptying below.

### Overlap is checked first, before anything about what was found

It is the security rule — every registered root becomes an allowed area for the "open in…" path guard, so adopting a parent of one widens that guard over the whole subtree ([Open in Tools](open_in_tools.md)) — and it is the most specific true thing about the folder.

Checked last it produced answers that sent the user after the wrong problem: pointing at the *parent* of the agents home answered "nothing in this folder has an `AGENT.md`", and re-picking a registered folder answered "everything here has already been added" — true, but not why it was refused.

**The one case the overlap pass no longer refuses is the folder being exactly a registered *external* root**, which is a re-selection and is checked in the same loop. Being exactly a **workshop** root still refuses: that shape holds kit folders, which this walk does not look for at all, so falling through would only reach the no-agents refusal — a true thing about it, but not the useful one. Every other overlap, in either direction, is refused as before.

A row that is an agent under a *different* root stays ticked and disabled even while re-selecting: this pick speaks for one folder's contents and that agent belongs to another. Registered roots may not overlap, so it takes a symlink to reach — which is why `DiscoveredBareAgent.addedElsewhere` is a computed field rather than something the dialog infers from `alreadyAdded`.

### Removal asks, and only a bare agent has a choice

`DeleteLocalAgentInput` carries `trashFolder`. A **kit** agent refuses `false`: its row is a derived index over its folder, so dropping the row and leaving the folder means the very next scan puts it straight back. A **bare** agent's folder is the user's own, so the two outcomes are genuinely different and the dialog asks.

- Both branches take the agent's **turn lock**. Forgetting an agent mid-turn would leave a stream writing into a chat whose agent has gone, and the hidden flag is a write into that agent's state
- Trashing a bare folder also calls `desktopStateService.forget`, for the reason above
- `restoreHiddenAgents` puts a root's removed agents back **under the same ids**, because the ids are positional and the folders never moved — and **re-seeds `a2a_sessions`** from each agent's state file, so a restored agent resumes the engine sessions its chats were bound to instead of starting fresh ones. `job_agents` genuinely cannot be restored: the row cascaded away and nothing remembers which jobs held it, which is why the delete dialog says the job will need the agent selected again
- Settings surfaces the count as "**N agents in this folder are not in the list — choose which ones with Manage agents above**". The row's **Manage agents** dialog replaced an **Add them** button that could only put back all of them or none. Not "removed from the list": the same hidden state also covers the agents the user simply did not tick, so adopting 1 of 15 used to report "14 agents removed from the list" about agents that had never been in it

### The watcher's filter is inverted for an external root

An external root is watched recursively at its own path — there is no `Local/` to watch instead — and that path is the user's ordinary working directory: a `.venv`, a `data/` an agent writes to on every run, a `node_modules`. The kit classifier would turn most of that churn into a whole-root rescan.

So `classifyExternalEvent` acts on **only what can change the agents list**, and ignores everything else:

| Outcome | When |
|---|---|
| `ignore` | A dot-entry anywhere on the path (`.git` alone would fire on every command the update check runs), any other path deeper than the walk can reach, or an ordinary **file** within reach |
| `root` | An `AGENT.md`, `AGENTS.md`, `CLAUDE.md` or `README.md` basename (what an agent *is*); a `cinna-agent.json` basename or a last segment of exactly `.cinna-kit` (the two kit markers that decide whether the weak names count — `.cinna-kit` is the one dot-entry acted on, and only as the last segment, never for what is written inside it); a **directory** appearing or disappearing within the scan depth (which agents there *are*); a path that cannot be stat'd; or no filename from the platform |

**The basenames are compared case-insensitively.** On a case-insensitive disk — macOS by default — a `claude.md` *is* the folder's `CLAUDE.md` to the scan, so an edit to it has to rescan. On a case-sensitive disk the same match costs a rescan that finds nothing new, which is harmless. The `.cinna-kit` comparison is exact.

**Whether a path within reach is a directory is stat'd, not assumed.** Assuming it made the branch fire for every ordinary file an agent writes — `notes.md` at the root of an adopted single-agent folder, `out/result.json` one level down — each costing a full walk, one state read per agent, a database transaction and a renderer refetch that replaced an identical list. Invisible, and therefore never attributed to anything. A path that cannot be stat'd rescans, because that is the *removed* directory: the case the branch exists for, and the one that cannot be inspected.

There is no `agent` outcome. A bare agent's id comes from the walk rather than from a file, so an event cannot be attributed to one agent without redoing the walk — which is the scan. The scan is idempotent and non-destructive, which is what makes "rescan the root" a correct answer rather than a lazy one.

On the Linux fallback (no recursive watch) the root, each agent folder found and each agent's *parent* are watched — the parent is what notices a new agent folder appearing beside its siblings.

**Never above the root, ever.** When the root *is* the agent — a single adopted folder — that agent's parent is the directory *containing* the registered root, which nothing else in this feature may touch. Worse than the scope breach is what the events would mean: `fs.watch` names a file relative to the directory being watched and the callback classifies against the *root's* path, so a sibling project's file would arrive looking like a path inside the root and be stat'd against the wrong base — a build in an unrelated checkout next door rescanning this root. Dropping it costs nothing: the root has its own watcher, and a new sibling of a single adopted folder is not an agent of that root anyway.

### The engine treats it as an agent with no manifest

- The prompt branches on the folder's **runtime mode**, not only on the absence of a manifest: a bare folder on Claude or Codex gets `assembleBareNativePrompt` (the desktop's context, appended to the engine's preset), and `assembleBareAgentPrompt` — the whole document, replacing it — is what OpenCode and any still-isolated manifest-less folder get. The only other engine change is three entries in the permission profile's identity-files list, `AGENT.md`, `AGENTS.md` and `CLAUDE.md` → `ask`, so the rule "the agent's own identity files ask" also holds for the agent whose identity is one file ([Local Agent Permissions](permissions.md#the-agents-own-identity-files-ask))
- `LocalAgentDto.runtime` is filled from the agent's **desktop state** rather than from a file in the folder, and `runtimeService.resolve` is handed it unchanged. An agent that has been given no runtime carries `null` and falls straight through to the **Default runtime** selected for this machine; the default chat mode supplies only the OpenCode credential/model fallback; one that has been given a credential or a tier resolves through exactly the chain a manifest's block does, floor and all. No third fallback for a *credential* exists anywhere in this feature — see [The Local Engine](engine.md#runtime-resolution-the-agents-own-runtime-then-the-default-runtime)
- The **Runs with** panel is the same component for both kinds. What a bare agent adds is one static note saying the choice is kept in Cinna and not in the folder, and the removal of the one remedy that named a file it does not have — "models can still be typed into `cinna-agent.json`" when the registry fails to load

### Every surface says something true of *this* folder

The page was reused wholesale from the kit agent page, and ten separate surfaces each asserted a file this folder shape has never had. That is now [UX rule 9](../../development/ui_guidelines/ux_rules.md) — a surface that names a file is asserting that file exists — and the fix in each case was to say something true about the second kind, not to soften the sentence:

| Surface | For a bare agent |
|---|---|
| Overview | The three manifest/STATUS cards are replaced by the **Name** card, and — where the folder has one — the folder's own read-only `Readme` below it |
| Runs-with note | Says where the choice is kept — in Cinna, not in the folder — instead of naming `cinna-agent.json`. Scoped to that one choice, because "nothing is written to the folder" is one tab away from false |
| Prompts → Instructions | The card header names and reveals the agent's own instructions file. With none resolved it names no file and offers no reveal, and its missing note lists the three names |
| Folder → Files | Lists the folder's **own two** files, its instructions file and `README.md`, not the kit layout's seven. With no instructions file the row reads "AGENT.md, AGENTS.md or CLAUDE.md" and reveals the folder, not a file that is not there |
| Name and Readme cards | Cleared, the name falls back to the heading in the named instructions file; the Readme footer says the agent is told only that file |
| Add a folder | The advanced-step tile offers "A project folder with agent instructions. Nothing in it changes."; a single find's hint names the file main found |
| Manage agents (Settings) | An empty list says no folders with any of the three names were found, and adds no red refusal on top — that would repeat it and point at a folder picker the dialog does not have |
| Folder → Identity | No `Kit` row — a folder with no manifest was reporting an *old* one ("legacy manifest"), which is both false and the wrong story — and a line saying the agent is identified by where its folder sits, so moving it starts a new agent |
| Folder → Runs | Names no file; says the run state is kept on this machine, outside the folder |
| Folder → Credentials, Published | Not rendered. Each could only say "none declared" / "not published" over a file the folder does not have — an absence presented as a configuration the user might fill in. The Open-in menu's **Open credentials/.env** item is withheld for the same reason: it would create the file it names |
| Permissions | The card names no file, and its examples say "editing its own" followed by the folder's instructions file (or the three names, where none resolved) instead of naming the manifest and `credentials/.env`. Two fictional examples out of three is how a reader comes to discount the third — and the third is the one that matters, because it is the sentence about a command reaching anything they can |
| Settings badge and sub-line | "Added folder" with the installs-nothing tooltip, which names the three instruction files; `· not a kit folder` |

The same review produced [rule 10](../../development/ui_guidelines/ux_rules.md) — a control's accessible name is its visible name. Two controls here carried names written when only one kind of agent existed: the sidebar `+` (now **Add an agent**) and the delete dialog, whose `aria-label` is **Remove agent** where its heading is.

### Root counts come off the scan, never a second walk

`AgentRootDto.agentCount`, `hiddenAgentCount` and `truncated` are read from the cached `ScanRootResult`, which carries `hiddenCount` and `truncated` for exactly this. The list serves agents from that cache precisely because re-walking every folder on every call blocks the main thread, and the renderer refetches on every watcher push; counting independently in `toDto` put the walk straight back — plus one state read per agent — for the row two lines below the agents it had just avoided re-reading. It also gave the settings row its own answer to a question the scan had already answered, which is how the two could come to disagree. A root never scanned in this process falls back to the cheap name-less walk.

### Only a bare folder has a handover inbox, and running one unattended is opt-in per project

A brief left in `<folder>/.cinna/handovers/<id>/brief.md` becomes a task for that folder's agent — see [File Handovers](../../jobs/tasks/file_handovers.md) for the contract. Two rules belong here, on the agent:

- **Bare folders only.** A kit folder is published and Cinna already writes into it, so a `.cinna/handovers` there would travel to whoever installed the kit. A kit agent is still a perfectly good *requester*; every folder agent's prompt carries the requester's half of the protocol, with its own Cinna agent id in it.
- **The Permissions tab carries a `Handovers` choice — *Ask before running* (the default) or *Run automatically* — for a bare agent on any engine**, because a handover is a thing the *folder* has whatever engine reads it. It sits outside the engine-specific Approvals control for that reason. Under it, a line always says what git answered about `.cinna/handovers`: ignored, not in `.gitignore`, tracked, not a repository, or could-not-be-checked. That line is always rendered because it has something true to say in every state, and because in the two states that forbid *Run automatically* it is the only thing on the card explaining why that option is greyed out rather than gone.
- **The control shows what would happen, not what was stored.** A folder set to *Run automatically* whose `.cinna/handovers` git has since started tracking asks anyway, so the select reads *Ask before running* and the line under it says the setting is there and not in force. A select displaying a value the app will not act on made the refusal look like the bug. The stored choice is not lost — it comes back into force by itself once git stops objecting — and since picking *Ask* in a select already showing *Ask* changes nothing, that line carries the one control that clears it: **Switch to ask**.
- **That git answer is a refusal, not a warning beside a switch that already flipped.** `Run automatically` is refused while git tracks or does not ignore the directory, and an answer git could not give counts as "could not be checked", which also refuses. A folder that is not a repository at all is allowed — nothing can arrive there by pull. The reason is the section above: a turn in a bare folder runs on that folder's own settings, hooks and `.mcp.json`, so a brief that runs unattended is arbitrary code chosen by whatever can write to the repository.

### What a bare agent deliberately does not get

Everything downstream of a manifest, because there is no file to read it from and no honest place to write one:

- **Commands.** No `docs/CLI_COMMANDS.yaml`, so no `/run:<name>` and no Commands tab — a permanently empty tab saying "no commands" would be about a file the folder was never asked to have. See [`/run:<name>` — Catalog Commands](commands.md) <!-- nocheck -->
- **Credential slots**, and so no `credentials_needed` readiness and no secrets line
- **Example prompts**, so the `#` popup and the agents-as-MCP tool description fall back to their own framing rather than to an invented one
- **Publications, content hash and the contract gate** — all three are properties of a manifest
- **Stamp identity**, for the reason in the identity rule above
- **A description.** Nothing in the folder states one the desktop can trust, so the header shows nothing rather than inviting the user to add one under a tab that has no such field
- **Scaffolding.** A bare agent is adopted by path and never created; the New agent flow still scaffolds kit folders and only kit folders

## Known gaps

Known and not addressed:

- **A root registered before `AGENTS.md` and `CLAUDE.md` counted gains agents nobody ticked.** Its subfolders whose only instructions are one of those two, and with no `AGENT.md` below them, are agents to the next scan. So they appear in the list without having been offered. Only a pick records what the user declined, and that root's pick happened when those folders were not agents. They can be taken out through the root's **Manage agents** dialog or ⋯ → Remove from the list
- **An engine may load the instructions file a second time.** The assembled prompt already carries it, but the engine runs in the agent's folder. OpenCode's session cwd is the folder and its child environment does not set `OPENCODE_DISABLE_CLAUDE_CODE`, so OpenCode's own project-rules loading may add an `AGENTS.md` or `CLAUDE.md` again. Codex reads a project `AGENTS.md` itself, on top of the developer instructions Cinna passes. Neither is verified in the app. **For Claude this is no longer a gap but the design**: a bare folder runs with `settingSources: ['user','project','local']`, so the engine reads its `CLAUDE.md` on purpose and Cinna does not paste that file in — see [the rule above](#the-instructions-file-is-pasted-in-only-for-the-engine-that-would-not-read-it). `settingSources: []` still holds for **kit** folders and for Cinna's own build session ([The Claude Engine](claude_engine.md)). This is not specific to bare folders: a kit folder's scaffolded `AGENTS.md` and `CLAUDE.md` are exposed the same way, and were before bare folders could use those names
- **Only the scan rescues agents past the cap.** The pick preview, the **Manage agents** dialog and the settings row's cold-path count walk without it. On a capped root, re-selecting it or opening Manage agents can list fewer rows than the sidebar holds, and the cold count can undercount
- **Manage agents' empty state still names the three files for a root that has since become kit-shaped.** The dialog drops main's refusal whenever the list is empty, so a registered external root that gained a `.cinna-kit/` or a `cinna-agent.json` reads "No folders with an AGENT.md, AGENTS.md or CLAUDE.md were found here" over the `AGENTS.md` and `CLAUDE.md` it visibly holds, instead of the kit-specific refusal the pick gives
- **`.cinna-kit` is matched case-sensitively by the watcher**, while the instruction basenames and `cinna-agent.json` match in any case. A differently-cased `.cinna-kit` appearing does not rescan the root
- **Saving an instructions file that is a symlink replaces the link with a regular file.** The write is temp-file-then-rename, which replaces the directory entry rather than writing through it. `AGENT.md` has always behaved this way; the wider names make a linked `CLAUDE.md` likelier
- **The overlap comparison is textual, and does not `realpath`.** A symlink pointing at a registered root is therefore adoptable, and the same folders index twice under two roots with two id schemes. This pre-dates bare agents and is shared with `addRoot`; fixing it means resolving **both sides** — the stored roots as well as the candidate, since resolving only the candidate leaves the mirror case open, where it is the stored root that is the symlinked path — which touches the workshop path as much as this one

## Architecture Overview

```
Agents sidebar "+" ─► NewLocalAgentModal
                        ├─ New agent  ─► local-agent:create        (kit, unchanged)
                        └─ Advanced options ─► Add a folder
                             ├─ local-agent:folder-pick  ─► native dialog (main)
                             │                              discoverBareAgents  → preview
                             └─ local-agent:folder-add   ─► addExternalRoot (writes nothing
                                                              into the folder; returns the
                                                              existing row on a re-pick)
                                                            relPaths = the whole desired set
                                                            hidden/displayName → bare state
                                                            scanExternalRoot · watchRoot

Agent page Settings → "Runs with" ─► local-agent:set-runtime ─► desktop state (no stamp)
                                                    ─► agentRepo.setFolderLauncher
                                                       (the row's engine; no watcher
                                                        sees a bare agent's runtime)

scanExternalRoot(root)
  discoverBareAgents(root.path, depth 2, keep = knownBareAgentFilter)
    │  resolveBareInstructionsFile: AGENT.md → AGENTS.md → CLAUDE.md
    │  (weak names: not in a kit-shaped folder; not above an AGENT.md unless known)
    ├─ truncated? + indexedPastTheCap  (indexed agents the capped walk missed)
    └─ per folder: scanBareAgentFolder  ── instructions file ──► LocalAgentDto
                     { kind: 'bare', instructionsFile }
                     id = folder:external:<rootId>:<relPath>
                     state = <userData>/external-agents/<name>-<hash>.json
    hidden folders dropped before the index is built
  replaceFolderIndex(root)                     (the same prune every root goes through)

Engine   collectEngineAgents ─► assembleBareAgentPrompt(instructions file + desktop context)
                                runtime from bare state ─► same resolve() as a manifest's,
                                null ─► Default runtime

Files on disk ── truth ──► agents rows ── derived index
     ▲                          │
     └── the user, their editor, their assistant, `git pull`
```

## Integration Points

- [Agents Home, Scanner & Folder Index](folder_index.md) — the roots, the scan, the prune, the watcher and the turn lock this shape plugs into; and the two extra columns the index now owns
- [Kit Contract & Manifest Layer](kit_contract.md) — what a bare folder is defined against: everything it does not keep
- [Agents Tab & Agent Page](agents_tab.md) — the Add-an-agent choice, the folder step, the bare page's tabs and the remove dialog
- [The Local Engine, Runtimes & Prompt Assembly](engine.md) — the bare prompt assembler, and the resolution chain a bare agent's runtime goes through once it has one
- [Agents Folder Updates](folder_updates.md) — fast-forwarding a registered root that is a git working tree; the reason a repository of agents is worth adopting as a set
- [Open in Tools](open_in_tools.md) — the registered roots are the allowed area of its path guard, which is why overlap is refused first; and the init prompt's entry-document order for a bare folder
- [Local Agent Permissions](permissions.md) — the profile is identical for a bare agent; only where its standing grants are stored differs, and the tab carries the Handovers choice above
- [File Handovers](../../jobs/tasks/file_handovers.md) — `.cinna/handovers/` in a bare folder: what a brief and a report mean, and why running one unattended is a per-project permission
- [The Agent Turn](agent_turn.md) — a bare agent runs a turn on the same path as a kit one; the driver passes the agent's kind so its session lands in the right state file
- [Local Agents Are Not Synced](local_only.md) — a bare agent is a directory on one machine, and nothing here changes that
- [UX Rules](../../development/ui_guidelines/ux_rules.md) — rules 9, 10 and 11 were written from this feature's review: a surface that names a file asserts that file exists, a control's accessible name is its visible name, and a control must not look like the text beside it. The last came from a "Show more" toggle on this page's `Readme` card, muted grey at the size of the footer note under it; the toggle is gone with the clamp it opened, but the styling mistake is the general one

Sub-doc: [Technical Details](bare_agents_tech.md)
