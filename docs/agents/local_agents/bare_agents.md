# Bare Agents & External Roots

## Purpose

Let a folder the user already owns be an agent. A directory holding an `AGENT.md` can be adopted as a **bare** agent — no manifest, no kit layout, no conversion — and the folder it was adopted from is registered as an **external** root that the desktop reads and never writes into.

The shape this was built for is a repository of agents a team shares: cloned once, worked on in an editor, and expected to keep working as a repository afterwards. Keeping the folder up to date with its remote is the sibling feature, [Agents Folder Updates](folder_updates.md).

## A note on paths

The same convention as the rest of this folder:

| Written as | Means |
|---|---|
| `src/...`, `docs/...` | A file in **this repository** |
| `AGENT.md`, `README.md` | Inside a **bare agent folder** |
| `Local/<slug>/...`, `cinna-agent.json`, `app-data/desktop.json` | Inside a **kit** agent folder |
| `<userData>/external-agents/...` | Inside the app's own data directory |

## Core Concepts

- **Bare Agent** — A folder that is an agent because it holds an `AGENT.md`, and for no other reason. It has no manifest, so no commands, no credential slots, no example prompts and no publications. It *does* choose its own **runtime** — which credential pays for it, and how hard its work is — but the answer is kept outside the folder, because there is no file in the folder to write one into. `LocalAgentDto.kind` is `'bare'`; a kit folder's is `'kit'`
- **External Root** — A registered `agent_roots` row with `kind = 'external'`: a folder the user pointed at, walked for `AGENT.md`. The kit shape is `kind = 'workshop'`
- **The walk** — How an external root's agents are found: up to `BARE_AGENT_MAX_DEPTH` (2) levels below the root, skipping dot-directories and a dependency-tree list, never descending into a folder that is itself an agent
- **Positional identity** — A bare agent's row id, `folder:external:<rootId>:<relPath>`. There is no manifest to state a durable one, so where the folder sits *is* its identity
- **Bare state** — `<userData>/external-agents/<basename>-<16 hex of sha256(realpath)>.json`: everything `app-data/desktop.json` holds for a kit agent, kept outside the user's folder, plus the three values only a bare agent keeps there because nothing in its folder can state them — the name the user gave it, whether it is in the list, and its runtime
- **Hidden** — A bare agent that is not in the list although its folder is under a registered root. One state with **two histories** — an agent the user removed, and one they simply did not tick when adopting the folder — because "not chosen" and "removed" have to be the same thing or the next rescan re-adds the ones they declined. Recorded in that agent's state, since the scan walks the whole root every time
- **Re-selection** — Picking a folder that is *already* a registered external root. The dialog reopens its agent list on the state the app is in, and what is ticked when the user saves is the whole set they want: unticking one takes it out of the list, ticking one that was out puts it back
- **Agent role / builder role** — `AGENT.md` is what the agent is told; `README.md` is what an assistant *working on* the agent is briefed with. The two documents have different readers, and the split is enforced rather than assumed

## User Stories / Flows

### Adopting one folder

1. The Agents sidebar's **+** — now "Add an agent" — opens a choice: **New agent** (scaffold a kit folder, the flow that already existed) or **Add a folder**
2. **Add a folder** opens a native directory picker in main. What was picked is walked, and the result previewed: nothing is registered yet and nothing has been written
3. One folder found means the picked folder *is* the agent. The step shows a single **Name** field, prefilled from the first `# heading` in `AGENT.md` or the folder's own name, so Enter is a complete answer
4. **Add agent** registers the folder as an external root, scans it, and lands the user on the new agent — adopting is a create in every sense the user cares about, so it obeys the same rule ([UX Rules](../../development/ui_guidelines/ux_rules.md), rule 3). There is no "Build it with…" step: nothing was scaffolded, so there is nothing to hand to an assistant

### Adopting a repository of them

1. Several folders found means the picked folder is a *set*. The step lists them with a checkbox each — the root-relative path underneath — with **Select all** / **Clear all**. The name is the one the app shows: what the user called the agent where they have named it, then the `AGENT.md` heading, then the folder name, which is the scanner's own order. Listing a renamed agent under the heading in its file is a row the user cannot recognise in a dialog whose whole question is "which of these do you want"
2. A folder that is already an agent under *another* registered root is shown **ticked and disabled**, never filtered out: a list that silently loses the row the user came to add reads as the folder having been scanned wrong. On a first adopt every already-added row is one of those by definition, since the folder being picked is not registered and nothing under it can be its own
3. If the walk stopped at its cap, the step says so above the list — "This is the first N folders found. Pick a folder closer to the agents to see the rest." — because every count under a silently truncated list is true of the wrong set
4. **Add N agents** registers the *whole picked folder* as one root and marks the unticked folders hidden
5. The sidebar groups the new agents under the picked folder's name, and the page opens on the first agent adopted

### Coming back to a folder already added

1. Picking a folder that is already a registered external root is a **re-selection**, not a clash. The step opens on the state the app is in: the agents that are in the list ticked, the ones that are not, unticked — so confirming without touching anything changes nothing, and an agent removed earlier is not silently put back by a dialog opened to add a different one
2. A line above the buttons names the root it is already registered as and says the folder on disk is never touched either way; a second, reserved line says what the button is about to do — "1 to add, 2 to remove from the list."
3. There is no single-agent Name step here, however many agents the folder holds. The one thing a re-selection must be able to do is untick, and a step with a text field and no checkbox cannot — and the name field is prefilled from the folder, so sending it back would rename an agent the user had already named themselves
4. Ticking a row that was out puts that agent back, **with its engine sessions**, exactly as Settings' **Add them** does. Unticking one takes it out of the list, which is the same act as ⋯ → Remove from the list
5. If anything is being taken out, the button confirms first: a step *inside* the dialog — the list the user just edited stays on screen behind it — naming the agents that are leaving, what comes back if they are ticked again, and what does not ([UX Rules](../../development/ui_guidelines/ux_rules.md), rule 5). The checkboxes freeze while it is up, because a question that names agents must act on the set it named
6. **Saving lands on the agent that was added**, not on whichever of the ones already there sorts first. A save that only removed agents lands the user nowhere rather than on somebody else's page

### A pick that cannot be used

The dialog stays on the choice step and says why, in its reserved error line. It never closes on a refusal ([UX Rules](../../development/ui_guidelines/ux_rules.md), rule 6). The reasons, in the order they are checked: the folder overlaps a registered root in either direction (including a **workshop** root at exactly this path, where the walk finds nothing anyway), nothing under it has an `AGENT.md`, or — outside a re-selection — every agent in it has already been added. Cancelling the picker is not a refusal and says nothing at all.

Being the *same* external root is no longer among them; that is the re-selection above.

### Working with a bare agent

1. Its page is the ordinary agent page with the manifest-shaped parts removed: no **Commands** tab, and one card on **Overview** — its **Name**. The **Runs with** panel is the same panel a kit agent gets, controls and all
2. **Prompts** holds `Instructions` (`AGENT.md`, editable in place like any other prompt document) over a read-only `Readme`
3. **Permissions** and **Folder** are unchanged: the permission profile is the same for every folder agent — with `AGENT.md` added to its identity-files list, so rewriting the file the agent *is* asks — and the Folder tab shows the bare findings
4. **Open in <tool>**, **Start chat** and the ⋯ menu all behave as they do for a kit agent

### Renaming

1. The Name card on Overview saves on blur and on Enter — not on a pause, because a rename is a decision the user finishes rather than one that lands mid-word
2. The name is kept in that agent's state under `<userData>`, not in the folder, and the card says so
3. **Emptying the field clears the stored name**, which is the only route back to a name that *follows* the file: re-typing the heading by hand pins the name to a string that merely matches, and it stops following the moment the heading changes again. Clearing falls back to the `AGENT.md` heading, then to the folder name

### Removing

1. **⋯ → Remove agent…** — the wording differs from a kit agent's "Delete agent…" because the outcome does
2. The dialog offers two radio options: **Remove from the list only** (the default) and **Remove and move the folder to the Trash**. The recoverable one is first and selected
3. Removing from the list marks the agent hidden. The folder is untouched, and there are two routes back, both of which the dialog names: re-picking the folder in **+ → Add a folder** reopens its list with this agent unticked, and Settings → Local Agents shows the count under that root with an **Add them** button that puts *all* of them back at once. Naming only a route that does not work is how a choice offered as the recoverable one becomes a dead end ([UX Rules](../../development/ui_guidelines/ux_rules.md), rule 5) — which is what this hint did while re-picking a registered folder was still refused
4. The copy owns the half that cannot be undone: a job that uses the agent "will need it selected again even if you put the agent back". Removing drops the `agents` row and `job_agents` cascades with it; restoring re-creates the row under the same positional id, so chats re-bind, but the job's link does not come back

## Business Rules

### One file makes an agent

A directory holding an `AGENT.md` is an agent. That is the whole contract for a bare agent, and it is deliberately the smallest one available: the folder the user points at was written before Cinna was involved, and asking it to gain a manifest first is asking for a conversion nobody wanted. What the folder gives up in exchange is everything the manifest carries — see [Kit Contract & Manifest Layer](kit_contract.md#a-folder-that-keeps-none-of-it).

### Cinna installs nothing into an external root

No templates, no `.cinna-kit/`, no `Local/`, no `app-data/`. `addExternalRoot` is `addRoot` with exactly those three installs removed, and the state a bare agent needs is kept under `<userData>` instead.

This is the promise the whole shape rests on, and it is not a UI promise: every screen in the adopt flow looks identical whether or not a file was dropped into the user's repository. The E2E specs snapshot the folder tree before and after and compare, because that is the only witness ([E2E Testing](../../development/e2e/e2e.md)).

**It is "installs nothing", not "read only", and the difference is one file.** The agent page's Instructions card is a live editor over `AGENT.md`, so a folder the user edits there *is* written to — by them, deliberately, in the one place the page says so. The Settings badge therefore says "Cinna installs nothing here. The only file it writes is an agent's `AGENT.md`, and only when you edit it on the agent's page", and the root's sub-line reads `· not a kit folder` rather than `· read only`. A "read only" promise would leave a user with a modified working tree in a repository they share — and, because a dirty tree refuses a fast-forward, a blocked **Update** two rows below, with neither surface admitting the two are connected. <!-- nocheck -->

### The walk, and what it refuses to look at

- **Depth 0 is the folder itself**, which is why "one agent folder" and "a repository of them" are the same walk: a single agent is found at depth 0, `<repo>/local_agents/<agent>/AGENT.md` at depth 2. `BARE_AGENT_MAX_DEPTH` is 2; deeper than that an ordinary source tree starts matching — a fixture, a vendored dependency, a docs example
- **A folder that is an agent is not descended into.** An agent's own working tree often holds sub-projects with their own `AGENT.md`; a nested one is part of that agent, not a sibling of it, and listing both gives the user two rows they cannot tell apart
- **Dot-directories and a dependency-tree skip list are never entered** (`node_modules`, `venv`, `__pycache__`, `dist`, `target`, `Pods`, …). Not an optimisation: a dependency tree is exactly where somebody else's stray `AGENT.md` lives, and fifteen agents out of `node_modules` would make the picker useless the one time it mattered
- **Symlinked directories are followed**, because a curated set assembled out of links is a real shape. `withFileTypes` reports a link as a link rather than as what it points at, so each entry is stat-ed
- **The walk never throws.** An unreadable subdirectory contributes nothing and the walk continues; one permission-denied folder must not take the whole pick with it
- **It stops at 200 agents** and reports that it did. `truncated` travels all the way out — onto `PickAgentFolderResult` for the dialog and onto `AgentRootDto` for the settings row — rather than only being logged, because a list that is silently partial reads as the scanner having *missed* the folders the user came for, which is the exact diagnosis the cap exists to prevent. The settings side is the worse half: a capped root stays capped, so an agent added to the repository later never appears and no rescan fixes it. The cap is a constant; `discoverBareAgents` takes a **clamped** `limit` that exists only so a test can assert the reporting without building two hundred folders, and clamping is what stops a test-only seam becoming a way to raise it

### Identity is positional, and `external` is not `legacy`

A bare agent's row id is `folder:external:<rootId>:<relPath>`, keyed by root **and** root-relative path: one root can hold `a/support` and `b/support`, and two roots can hold the same layout. The path is POSIX-separated so the id does not depend on which platform scanned the folder — `a2a_sessions` cascades from this value, and a row written on one machine has to read as the same agent on another.

`LocalAgentIdentity` gained `'external'` as a value distinct from `'legacy'`, even though both are positional. The fix offered for a legacy folder is **Stamp identity**, which writes a UUID into a manifest; a bare folder has no manifest to write one into, so a surface keyed on `legacy` would offer a button that cannot work.

The consequence is the same one a legacy folder carries, and it is worth stating plainly: **moving or renaming a bare agent's folder starts a different agent.** Its chats stay, and stop resolving.

### The state lives outside the folder, and the *root* decides that

`desktopStatePath(agentDir, kind)` returns `<agentDir>/app-data/desktop.json` for `'kit'` and `<userData>/external-agents/<basename>-<hash>.json` for `'bare'`. The hash is over the folder's `realpath`, so a symlink and its target are one agent; the basename is kept in the filename because a directory of pure hashes is impossible to reason about when something has gone wrong.

Why outside the folder: a bare folder is very often a git working tree shared with other people. Dropping an untracked `app-data/` into fifteen agent folders of one repository is a change to their repository nobody asked for — visible in `git status` forever, and exactly the noise the update check beside this feature exists to keep clean.

**The kind comes from the root row (`kindOf(root)`), never from probing the folder.** Deciding it from `existsSync('cinna-agent.json')` would have let every caller keep a one-argument signature, and it was wrong in two reachable ways:

- The walk tests for `AGENT.md` and nothing else, so a folder carrying **both** files is adopted as a bare agent — and the probe would then send the adopt's own `hidden` write *into* it, creating the untracked `app-data/` this location exists to avoid, on the first action of adopting the folder
- A bare folder that later **gains** a manifest — one `git pull` away — would silently change where its state lives: `hidden` reverts (a removed agent comes back), `displayName` reverts (the rename is lost), and its sessions, token and standing grants are orphaned

Every caller already knows: the scanner and the service hold `root.kind`, the turn runner holds the agent's DTO.

`DesktopState` therefore gained three fields that only a bare agent uses — `displayName` (the user's own name for it, because no file states one), `hidden`, and `runtime` (the rule below) — and `forgetAt(path)`, which deletes the state file when a bare folder is trashed. Without it the sessions, the token and the permission grants of a deleted agent would sit under `<userData>` forever and be inherited by whatever the user next creates at that path, since the path is the key. A kit agent needs no equivalent: its state was inside the folder and went to the Trash with it.

**`forgetAt` takes the path, not the folder, and the caller resolves it before anything moves.** The key is `realpathSync(agentDir)`; once the folder is in the Trash that call throws and the key falls back to the raw path — a *different* digest wherever any component is a symlink, which on macOS includes everything under `tmpdir()` (`/var` → `/private/var`), an explicitly permitted root location. The unlink then raised `ENOENT` on a file that was never there and left the real one behind, which is precisely the leak the function exists to prevent.

### A bare agent picks its own runtime, and the answer is kept where the folder is not

Which credential pays for an agent and how hard its work is are the two questions a user most needs an answer to, and a folder adopted from somebody's own repository is not a lesser agent for having no manifest. So the **Runs with** panel is the same panel for both kinds, with the same credential picker, the same Work-Complexity/Advanced pair and the same reserved status line.

What differs is one thing: where the choice goes.

- A **kit** agent's runtime is a `runtime` block in `cinna-agent.json`, written under the file's stamp so an assistant editing the manifest at the same moment cannot be clobbered
- A **bare** agent's goes into that agent's state under `<userData>`, as `DesktopState.runtime`. There is **no stamp**, and there is nothing to stamp: the write touches no file in the folder, so no other tool can have changed it underneath, and nothing appears in the user's `git status`. It travels on its own channel for the same reason renaming does — `local-agent:update-field`'s whole contract is a stamped write to a file in the folder, and a stamp for a file the write does not touch guards nothing

The **validation is shared**, deliberately: `runtimeService.validate` is what both writers run, so a key-shaped credential and a model-and-tier pair are refused on this path too. A bare agent's choice never leaves the machine, but a pasted API key does not become safe by landing in `userData` rather than in a file the user commits.

The scanner then puts both on the same DTO field, `LocalAgentDto.runtime`. That is what keeps this to one difference: `runtimeService.resolve`, the engine's config source, the tier resolution and every message the panel can produce read one field and ask nothing about where it came from. Neither was changed to add this.

**The consequence is the one the rest of the bare state already carries, and the panel says it in a line of its own**: the key is the folder's path, so moving the folder starts a different agent, which runs on the Default runtime until it is told otherwise. That note is scoped to *this choice* — "nothing is written to the folder" would be one tab away from false, since the Prompts tab is a live editor over `AGENT.md` ([UX Rules](../../development/ui_guidelines/ux_rules.md), rule 9).

Only the three keys a picker can set survive a read of the state file — credential, model, complexity. The manifest's block is round-tripped whole because another tool may have written keys we do not know about; this file has exactly one writer, so keeping anything else would be a way for a stale `permissions` map to reach the engine long after the surface that wrote it was gone. A stored object naming none of the three reads as no choice at all, which is the same as the key being absent.

### The prompt is `AGENT.md` and nothing else the folder contains

The kit assembler reaches into `scripts/`, `credentials/` and `knowledge/` because a kit folder has a known shape. A bare folder has no shape at all — it is somebody's repository — so concatenating whatever `.md` files are lying in it would put a changelog, a licence or another agent's notes into the system prompt as instructions.

- **`README.md` is deliberately excluded.** It is written for the person developing the agent — how to install it, how to run it, what it needs — and a model reads "run `uv sync` first" as a step it should take
- **`README.md` is instead the entry document of the init prompt**, the briefing handed to an assistant opening the folder, falling back to `AGENT.md`. That order is the agent-role / builder-role split made concrete: a README reads to a builder as a briefing, and `AGENT.md` reads to one as a job description. See [Open in Tools](open_in_tools.md#the-init-prompt)
- **Three of the kit context block's rules are dropped rather than reworded** — run scripts with `uv run`, write only under `app-data/`, and the `credentials/.env` rule. Each describes a folder convention a bare folder never agreed to, and stating a rule about a file that does not exist is how a model ends up refusing ordinary work in the folder it was pointed at. What replaces them is one line saying the folder's own instructions govern how it is run, and that Cinna imposes no convention of its own
- **The "do not switch to the Builder role" line survives verbatim.** The same folder is opened by a builder whose job is to rewrite `AGENT.md` and `README.md`, and an agent that decides mid-conversation that it is the builder starts editing its own prompt while the user is talking to it
- **An empty `AGENT.md` never produces a promptless agent.** A stand-in section says the file is empty and suggests opening the folder in an assistant — the same rule the kit path keeps for an empty workflow prompt

### Readiness: one error, one warning, two infos

| Finding | Grade | Meaning |
|---|---|---|
| `bare.prompt.missing` | error | `AGENT.md` is gone or unreadable. The folder is not an agent any more, and readiness is `invalid` |
| `bare.prompt.empty` | warning | The file is there and empty. The agent still runs, on the stand-in prompt |
| `bare.readme.missing` | info | No `README.md`, so an assistant opening the folder is briefed from `AGENT.md` instead |
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

**An empty list is a failure on a first adopt and a real answer on a re-selection.** "Nothing ticked" cannot be adopted, so it is refused; the same list on a folder already registered means "take all of these out", and it is performed — the root stays, the folders stay, and both routes back (re-pick, or Settings' **Add them**) still work. Disabling the button there would promise a removal in one line of copy and refuse it silently in the next.

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

**The one case the overlap pass no longer refuses is the folder being exactly a registered *external* root**, which is a re-selection and is checked in the same loop. Being exactly a **workshop** root still refuses: that shape holds kit folders, which this walk does not look for at all, so falling through would only reach "nothing in this folder has an `AGENT.md`" — the true thing about it, but not the useful one. Every other overlap, in either direction, is refused as before.

A row that is an agent under a *different* root stays ticked and disabled even while re-selecting: this pick speaks for one folder's contents and that agent belongs to another. Registered roots may not overlap, so it takes a symlink to reach — which is why `DiscoveredBareAgent.addedElsewhere` is a computed field rather than something the dialog infers from `alreadyAdded`.

### Removal asks, and only a bare agent has a choice

`DeleteLocalAgentInput` carries `trashFolder`. A **kit** agent refuses `false`: its row is a derived index over its folder, so dropping the row and leaving the folder means the very next scan puts it straight back. A **bare** agent's folder is the user's own, so the two outcomes are genuinely different and the dialog asks.

- Both branches take the agent's **turn lock**. Forgetting an agent mid-turn would leave a stream writing into a chat whose agent has gone, and the hidden flag is a write into that agent's state
- Trashing a bare folder also calls `desktopStateService.forget`, for the reason above
- `restoreHiddenAgents` puts a root's removed agents back **under the same ids**, because the ids are positional and the folders never moved — and **re-seeds `a2a_sessions`** from each agent's state file, so a restored agent resumes the engine sessions its chats were bound to instead of starting fresh ones. `job_agents` genuinely cannot be restored: the row cascaded away and nothing remembers which jobs held it, which is why the delete dialog says the job will need the agent selected again
- Settings surfaces the count as "**N agents in this folder are not in the list**", with **Add them**. Not "removed from the list": the same hidden state also covers the agents the user simply did not tick, so adopting 1 of 15 used to report "14 agents removed from the list" about agents that had never been in it

### The watcher's filter is inverted for an external root

An external root is watched recursively at its own path — there is no `Local/` to watch instead — and that path is the user's ordinary working directory: a `.venv`, a `data/` an agent writes to on every run, a `node_modules`. The kit classifier would turn most of that churn into a whole-root rescan.

So `classifyExternalEvent` acts on **only what can change the agents list**, and ignores everything else:

| Outcome | When |
|---|---|
| `ignore` | A dot-entry anywhere on the path (`.git` alone would fire on every command the update check runs), anything deeper than the walk can reach, or an ordinary **file** within reach |
| `root` | An `AGENT.md` or `README.md` basename (what an agent *is*), a **directory** appearing or disappearing within the scan depth (which agents there *are*), a path that cannot be stat'd, or no filename from the platform |

**Whether a path within reach is a directory is stat'd, not assumed.** Assuming it made the branch fire for every ordinary file an agent writes — `notes.md` at the root of an adopted single-agent folder, `out/result.json` one level down — each costing a full walk, one state read per agent, a database transaction and a renderer refetch that replaced an identical list. Invisible, and therefore never attributed to anything. A path that cannot be stat'd rescans, because that is the *removed* directory: the case the branch exists for, and the one that cannot be inspected.

There is no `agent` outcome. A bare agent's id comes from the walk rather than from a file, so an event cannot be attributed to one agent without redoing the walk — which is the scan. The scan is idempotent and non-destructive, which is what makes "rescan the root" a correct answer rather than a lazy one.

On the Linux fallback (no recursive watch) the root, each agent folder found and each agent's *parent* are watched — the parent is what notices a new agent folder appearing beside its siblings.

**Never above the root, ever.** When the root *is* the agent — a single adopted folder — that agent's parent is the directory *containing* the registered root, which nothing else in this feature may touch. Worse than the scope breach is what the events would mean: `fs.watch` names a file relative to the directory being watched and the callback classifies against the *root's* path, so a sibling project's file would arrive looking like a path inside the root and be stat'd against the wrong base — a build in an unrelated checkout next door rescanning this root. Dropping it costs nothing: the root has its own watcher, and a new sibling of a single adopted folder is not an agent of that root anyway.

### The engine treats it as an agent with no manifest

- `collectEngineAgents` branches to `assembleBareAgentPrompt`. The only other engine change is one entry in the permission profile's identity-files list, `AGENT.md` → `ask`, so the rule "the agent's own identity files ask" also holds for the agent whose identity is one file ([Local Agent Permissions](permissions.md#the-agents-own-identity-files-ask))
- `LocalAgentDto.runtime` is filled from the agent's **desktop state** rather than from a file in the folder, and `runtimeService.resolve` is handed it unchanged. An agent that has been given no runtime carries `null` and falls straight through to the **Default runtime** derived from the user's default chat mode; one that has been given a credential or a tier resolves through exactly the chain a manifest's block does, floor and all. No third fallback for a *credential* exists anywhere in this feature — see [The Local Engine](engine.md#runtime-resolution-the-agents-own-runtime-then-the-default-runtime)
- The **Runs with** panel is the same component for both kinds. What a bare agent adds is one static note saying the choice is kept in Cinna and not in the folder, and the removal of the one remedy that named a file it does not have — "models can still be typed into `cinna-agent.json`" when the registry fails to load

### Every surface says something true of *this* folder

The page was reused wholesale from the kit agent page, and ten separate surfaces each asserted a file this folder shape has never had. That is now [UX rule 9](../../development/ui_guidelines/ux_rules.md) — a surface that names a file is asserting that file exists — and the fix in each case was to say something true about the second kind, not to soften the sentence:

| Surface | For a bare agent |
|---|---|
| Overview | The three manifest/STATUS cards are replaced by the **Name** card |
| Runs-with note | Says where the choice is kept — in Cinna, not in the folder — instead of naming `cinna-agent.json`. Scoped to that one choice, because "nothing is written to the folder" is one tab away from false |
| Folder → Files | Lists the folder's **own two** files, `AGENT.md` and `README.md`, not the kit layout's seven |
| Folder → Identity | No `Kit` row — a folder with no manifest was reporting an *old* one ("legacy manifest"), which is both false and the wrong story — and a line saying the agent is identified by where its folder sits, so moving it starts a new agent |
| Folder → Runs | Names no file; says the run state is kept on this machine, outside the folder |
| Folder → Credentials, Published | Not rendered. Each could only say "none declared" / "not published" over a file the folder does not have — an absence presented as a configuration the user might fill in |
| Permissions | The card names no file, and its examples say "editing its own `AGENT.md`" instead of naming the manifest and `credentials/.env`. Two fictional examples out of three is how a reader comes to discount the third — and the third is the one that matters, because it is the sentence about a command reaching anything they can |
| Settings badge and sub-line | "Added folder" with the installs-nothing tooltip; `· not a kit folder` |

The same review produced [rule 10](../../development/ui_guidelines/ux_rules.md) — a control's accessible name is its visible name. Two controls here carried names written when only one kind of agent existed: the sidebar `+` (now **Add an agent**) and the delete dialog, whose `aria-label` is **Remove agent** where its heading is.

### Root counts come off the scan, never a second walk

`AgentRootDto.agentCount`, `hiddenAgentCount` and `truncated` are read from the cached `ScanRootResult`, which carries `hiddenCount` and `truncated` for exactly this. The list serves agents from that cache precisely because re-walking every folder on every call blocks the main thread, and the renderer refetches on every watcher push; counting independently in `toDto` put the walk straight back — plus one state read per agent — for the row two lines below the agents it had just avoided re-reading. It also gave the settings row its own answer to a question the scan had already answered, which is how the two could come to disagree. A root never scanned in this process falls back to the cheap name-less walk.

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

Both are recorded in the code beside the rule they qualify, and both are deliberate rather than pending:

- **`AGENTS.md` is not accepted — only `AGENT.md`, singular.** This is the requested contract, and also the likeliest support question the feature has: `AGENTS.md` is the emerging cross-tool convention *and* what the kit's own `templates/agent/` scaffolds, so a user pointing at a repository full of them is told "nothing in this folder has an `AGENT.md`". Two conditions would have to hold together if it were widened: `AGENTS.md` may count **only** where no `cinna-agent.json` sits beside it, or every kit agent in an adopted tree is demoted to a bare one and loses its commands, credential slots and declared runtime; and the walk must still stop at the **first** match in a folder and not descend, or a folder holding both files at different levels yields two agents for one directory
- **The overlap comparison is textual, and does not `realpath`.** A symlink pointing at a registered root is therefore adoptable, and the same folders index twice under two roots with two id schemes. This pre-dates bare agents and is shared with `addRoot`; fixing it means resolving **both sides** — the stored roots as well as the candidate, since resolving only the candidate leaves the mirror case open, where it is the stored root that is the symlinked path — which touches the workshop path as much as this one

## Architecture Overview

```
Agents sidebar "+" ─► NewLocalAgentModal
                        ├─ New agent  ─► local-agent:create        (kit, unchanged)
                        └─ Add a folder
                             ├─ local-agent:folder-pick  ─► native dialog (main)
                             │                              discoverBareAgents  → preview
                             └─ local-agent:folder-add   ─► addExternalRoot (writes nothing
                                                              into the folder; returns the
                                                              existing row on a re-pick)
                                                            relPaths = the whole desired set
                                                            hidden/displayName → bare state
                                                            scanExternalRoot · watchRoot

Agent page "Runs with" ─► local-agent:set-runtime ─► desktop state (no stamp)
                                                    ─► engineManager.applyConfigChange

scanExternalRoot(root)
  discoverBareAgents(root.path, depth 2)
    └─ per folder: scanBareAgentFolder  ── AGENT.md ──► LocalAgentDto { kind: 'bare' }
                     id = folder:external:<rootId>:<relPath>
                     state = <userData>/external-agents/<name>-<hash>.json
    hidden folders dropped before the index is built
  replaceFolderIndex(root)                     (the same prune every root goes through)

Engine   collectEngineAgents ─► assembleBareAgentPrompt(AGENT.md + desktop context)
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
- [Local Agent Permissions](permissions.md) — the profile is identical for a bare agent; only where its standing grants are stored differs
- [The Agent Turn Runner](agent_turn.md) — a bare agent runs a turn on the same path as a kit one; the runner passes the agent's kind so its session lands in the right state file
- [Local Agents Are Not Synced](local_only.md) — a bare agent is a directory on one machine, and nothing here changes that
- [UX Rules](../../development/ui_guidelines/ux_rules.md) — rules 9 and 10 were written from this feature's review: a surface that names a file asserts that file exists, and a control's accessible name is its visible name

Sub-doc: [Technical Details](bare_agents_tech.md)
