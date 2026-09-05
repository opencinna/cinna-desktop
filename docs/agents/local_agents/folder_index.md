# Agents Home, Scanner & Folder Index

## Purpose

Bring agent **folders on disk** into the app as `agents` rows. This is the layer between the [Kit Contract](kit_contract.md), which knows how to read one folder, and everything that treats an agent as a thing the user can pick: it owns the agents home and the extra roots, scaffolds new agent folders, walks them, derives readiness, watches them for outside edits, and rebuilds the index they produce.

Phase 2 of Local Agents. No UI of its own — the Agents tab and the agent page are built on top of it.

## A note on paths

Three trees are discussed here and their paths look alike, so they are written differently throughout — the same convention the [cinna-core handover](cinna_core_handover.md) uses:

| Written as | Means |
|---|---|
| `src/...`, `resources/...`, `docs/...` | A file in **this repository** |
| `kit.json`, `layout.json`, `templates/...` | Relative to the **contract root** — `resources/cinna-kit-contract/`, or `.cinna-kit/` once copied into a workshop |
| `Local/<slug>/...` | Inside an **agent folder**, i.e. relative to a root. Where the sentence has already established we are inside one, the prefix is dropped: `credentials/.env`, `app-data/desktop.json` |

The third is the one that catches people: an agent folder has its own `docs/`, `scripts/` and `config/`, and none of them is this repository's.

## The governing principle

**Files are the truth; the database is an index.** The `agents` row for a folder agent is a cache. Dropping every folder row and rescanning must reproduce exactly what was there before, with one deliberate exception: `enabled`, which no file states (see [What `enabled` means](#what-enabled-means)).

Its corollary is the rule the pruning code is written around: **a scan can only speak for the folder it walked.** A scan has evidence about the agents under a root's *current* path at *this* moment, and about nothing else — not about a folder it could not parse, and not about a location the root used to have.

## Core Concepts

- **Folder Agent** — An agent that *is* a folder on disk (`agents.source = 'folder'`, row id `folder:<manifest uuid>`). Contrast with `'local'` (a hand-added A2A URL) and `'remote'` (Cinna-synced)
- **Agents Root** (a.k.a. workshop) — A registered folder holding `Local/` (one directory per agent), `Cloud/`, the root markdown files and a `.cinna-kit/` copy of the contract
- **Agents Home** — The one root marked default: `~/Documents/CinnaAgents` unless the `localAgentsHome` app setting says otherwise. Where the New Agent button writes. Cannot be removed, only moved
- **Folder Index** — The `agents` rows derived from a scan, plus the `agent_roots` rows saying where to look
- **Readiness** — How ready a folder is to run: `ok`, `credentials_needed`, `invalid`, `contract_too_new`. A *state*, never an exception
- **Scan** — One walk of `Local/*/` in a root: parse each manifest, validate, derive readiness, fold in `app-data/storage/STATUS.md` and `app-data/desktop.json`, rebuild that root's slice of the index in one transaction
- **Turn Lock** — A per-agent, in-process lock. The runner holds it for the length of a turn; editors refuse to save while it is held; the watcher defers its rescan until it is released
- **Stamp** — `{mtimeMs, size, hash}` for a file the page can edit, round-tripped through a save so a write over a file that changed underneath is refused
- **Desktop State** — `app-data/desktop.json`, the one file in an agent folder the desktop owns
- **Counterparty** — An agent the user can pick and then expect an answer from. A folder agent is one, on the same terms as every other source: the pickers filter on `enabled` and nothing else. See [Folder Agents as Counterparties](counterparty.md)

## User Stories / Flows

### Opening the Agents tab for the first time
1. The home is resolved from the `localAgentsHome` setting, or the built-in default
2. The folder is created if missing, the root templates (`AGENTS.md`, `CLAUDE.md`, `README.md`, `.gitignore`, `Local/`, `Cloud/`) are installed, and `.cinna-kit/` is populated from the bundled contract
3. Each root is scanned; every folder becomes a list entry and (where its identity could be read) an `agents` row
4. Each root starts being watched

### Creating an agent
1. The user supplies a name, and optionally one sentence describing what the agent should do. Absent or blank, the name is written as the description — the kit schema requires a non-empty one, and a folder invalid from its first second is a worse start than a redundant sentence. The index row's `description` column is `null` in that case, so no picker renders the name twice
2. A slug is derived from the name unless one was given
3. The agent skeleton is copied out of the active contract's `templates/agent/` into a hidden staging directory, `{{TOKEN}}` placeholders are substituted, the dotless `gitignore` files are restored to their dotted names, and a manifest is written carrying a fresh UUID `id`, the contract version and the kit version
4. The staging directory is renamed into `Local/<slug>/` — all-or-nothing, so no half-agent is ever visible to the scanner or the watcher
5. The root is rescanned, which is what inserts the row

### An assistant edits the folder while the app is open
1. Claude Code / Codex / OpenCode rewrites files in `Local/<slug>/` — including, for a moment, an invalid `cinna-agent.json`
2. The watcher debounces the burst, attributes it to that agent, and rescans just that folder
3. While the manifest is unparseable the agent shows as `invalid` with a finding naming the file; its row, its id and its chats are untouched
4. When the manifest parses again the next event restores it to its real readiness

### Saving an edit from the agent page
1. The page sends the field, the new value, and the stamp it last read **for the file that write touches** — the manifest, or one prompt document. A save that handed back the manifest's stamp for a prompt document would be waved through by a guard comparing two unrelated files, so the mapping from field to file is shared rather than main-private
2. The turn lock is taken — a save that arrives mid-turn is refused with "this agent is busy", never queued
3. The file on disk is re-stamped and compared; a mismatch refuses the write with a stale-write code and asks the page to reload
4. The write is atomic (temp file → fsync → rename), the folder is re-read, and what the folder now says is returned — never an echo of what was sent

### Adopting an existing workshop
1. The user picks a folder in a **native directory dialog opened in main** — the renderer never supplies the path
2. The path is validated against the path rules, then against the roots already registered (no nesting in either direction)
3. If the folder is non-empty and does not already look like a workshop, a native confirmation explains that template files will be added and nothing existing will be changed
4. The templates and `.cinna-kit/` are installed, the root is registered, scanned and watched

### Moving the agents home
1. The setting is validated at the boundary and rejected if it is not a usable root
2. The default root row is repointed at the new path and the new location is scanned
3. Rows still pointing under the old location are **kept**, not pruned — the setting moved, the agents did not. Pointing the home back re-adopts them, sessions intact

### Removing an extra root
1. The home cannot be removed; the settings screen offers to move it instead
2. An extra root's index rows are pruned in one transaction, its watcher is closed, and the row is deleted
3. **The folder on disk is never touched**

## Business Rules

### Roots and the agents home

- Exactly one root per user is the home. It is created lazily and idempotently: everything missing is created, everything present is left alone (every root file is `survives_update: true` in the contract layout)
- A root already registered at the home's path is adopted as the home rather than duplicated
- The `.cinna-kit/` copy is refreshed only when the workshop's copy is **older** than the bundled contract. An equal or newer copy is left alone — overwriting would undo a contract refresh, or an edit an assistant is entitled to make in the workshop, and copying on every call would defeat the contract cache
- The configured home is re-validated on **every read**, not trusted. A value that no longer passes the path rules falls back to the default and is logged; the user keeps a working Agents tab instead of an app that refuses to open one
- Folder agents are **machine-local**: they live in the default (settings) scope alongside hand-added A2A agents and follow every profile. See [Settings Scope](../../core/settings_scope/settings_scope.md)

### Root containment is a security rule

`addRoot` refuses a folder that **contains, or is contained by**, a root already registered.

- Every registered root is handed to the "Open in…" path guard as an allowed area. Adopting `~/Documents` — the parent of the default home — would widen that guard to the whole subtree, so anything that can reach the open-in channel could open any folder beneath it. The guard is careful, but it is only ever as good as the roots it is given, and nothing else validates those. See [Open in Tools](open_in_tools.md)
- Overlap also sets the per-root prune scoping against itself: two roots would claim the same folders, and each scan would see the other's agents as absent

### Scanning never throws for a bad folder

- A half-written manifest, a folder with no manifest, a `STATUS.md` full of nonsense: each is a *state* the list can render, because the alternative is one broken folder taking the whole tab with it
- The only thing that stops a scan is the **root** being unreadable — an unmounted volume, a folder the user moved. That is reported, and the index is left **untouched**: writing an empty index would prune every row of that root and cascade their sessions away
- Dot-directories are skipped: that is where the scaffolder stages a folder before renaming it into place, and where editors leave their bookkeeping
- Symlinked agent folders are followed (a workshop assembled out of links still scans)

### Readiness, in the order the user cares about

1. `contract_too_new` — the folder records a contract major this build cannot operate. Read-only until the app is updated
2. `invalid` — validation failed, or the manifest could not be read at all. A command entry in `Local/<slug>/docs/CLI_COMMANDS.yaml` that could not be parsed also lands here: a dropped command is silent by construction, and "the list looks fine, it just lost one" is the worst way for that to surface
3. `credentials_needed` — valid, but a required `credentials/.env` variable is missing
4. `ok`

Only variable **names** are ever read from `credentials/.env`. No value is read, returned or logged. A slot that declares no keys cannot be checked and counts as satisfied rather than blocking the agent on something unverifiable.

### An unreadable manifest never changes an agent's identity

This is the rule with the sharpest failure mode behind it.

- A folder whose manifest cannot be parsed still gets a **list entry**, with the folder name standing in for the missing name and the finding that explains it
- That entry is **never written to the index**, and the row already at that path is **held back from the prune**
- The entry **adopts the id of the row already at that path**, so the list, the page and any open chat keep pointing at the same agent while it is being repaired
- The one thing that changes is **readiness**. Identity is protected by *path*

Why: a synthetic id would insert a substitute row and prune the real one, and `a2a_sessions` and `job_agents` both cascade from `agents.id`. A manifest that is unparseable for the second an assistant saves it would take the engine session with it — permanently, since no later fix brings it back. That editing window is the *designed* workflow, not an exotic case. See [A2A session continuity](../agents/agents.md).

A legacy manifest (no `id` at all — contract 1.0.0's one exemption from the identity requirement) is a *different* case, and does **not** travel that path. It parsed; it simply says no `id`, so the folder is a supported agent: it is indexed under a **positional** id (`folder:legacy:<rootId>:<folderName>`, keyed by root as well as folder name because two roots can each hold a `Local/assistant`), it opens, and it edits. What it cannot have is a durable identity — renaming or moving the folder produces a different agent — which is what "Stamp identity" fixes. See [Agents Tab & Agent Page](agents_tab.md).

### Pruning: three conditions, one rule

A folder row survives a scan's prune on any of three grounds:

1. **Its id was scanned** — the folder is there and readable
2. **Its folder is there but unreadable** — the path was passed to the prune as protected (the rule above)
3. **Its path is not under the root's current path** — the root moved, so this scan never examined it

The single rule behind all three: *a scan can only speak for the folder it walked.* Deleting on any of these grounds would cascade real sessions away for a condition that is merely "we did not look there".

Two more properties:

- Pruning is **scoped to one root**, so an agent folder moved between roots keeps its row (the upsert repoints `local_root_id`) and keeps its chats
- Removing a root is the explicit, unscoped prune — the only path that drops rows the scan did not disprove

**Deleting an agent from its page is not a fourth path.** The page's Delete moves the folder to the OS Trash (under the agent's turn lock, so a turn in flight refuses it) and then rescans the root; the row goes because the scan walked the root and the folder was not there — ground 1 failing, honestly. Nothing deletes an `agents` row by id. A second removal path with its own idea of what to drop is how the cascade reasoning above would stop being the whole story. See [Agents Tab & Agent Page](agents_tab.md#delete-goes-to-the-trash-and-through-the-prune).

### What `enabled` means

**`enabled` means exactly one thing: the user's choice.**

- It is never overwritten by a rescan and no file states it — it is deliberately the one column the folder does not own. Newly indexed folder agents insert **enabled**
- The scanner cannot know it, so the service overlays the row's value back onto every scanned snapshot before it reaches the renderer

The "folder agents have no runner yet" restriction was therefore never carried by `enabled`. It lived in a separate named predicate applied at exactly two places — the `@`-mention list in `src/renderer/src/components/chat/ChatInput.tsx` and the agent list in `src/renderer/src/components/jobs/JobEditForm.tsx` — and both of those filters now read `a.enabled` alone. Borrowing `enabled` would have made the two meanings indistinguishable exactly when the runner arrived: nothing could then have safely turned back on the agents that were only ever off because the feature did not exist.

**That is why lifting the restriction was a deletion rather than a migration** — no column had to be rewritten and no user's toggle had to be guessed at. See [Folder Agents as Counterparties](counterparty.md).

Every other consumer of the agents list looks an agent up by id for display, which is already correct for a folder agent.

### Watching a folder

- One debounced watcher per root. Nothing ever watches a **file**: almost every editor writes `file.tmp` and renames it over the target, which replaces the inode and kills a file watcher. Directories survive their contents being replaced
- Recursive watching is macOS/Windows only; on Linux a per-directory fallback watches `Local/`, each agent folder, and each agent's `docs/` and `credentials/` — re-armed after each root scan so a newly scaffolded folder is covered
- A watcher that errors is closed and re-armed **once**, after a delay, so an unmounted volume that returns is picked up while a permanently gone folder stops retrying

Every event is classified into exactly **three** outcomes — `ignore`, `root`, `agent`:

| Outcome | When | Response |
|---|---|---|
| `ignore` | A dot-entry, or anything under `app-data/` | Nothing at all |
| `root` | No filename from the platform, or a bare agent-folder name (membership changed) | Rescan the whole root |
| `agent` | A path inside one agent folder | Rescan that agent only |

The three-way result is load-bearing, not a stylistic choice. Collapsing "ignore this", "cannot attribute this" and "root membership changed" into one nullable value **inverts the ignore rule**: `app-data/` — the one directory deliberately not watched, and the one the agent writes constantly while a turn runs — then triggers the most expensive response available on every `STATUS.md` write. A single-value assertion also cannot tell the three apart in a test.

**Both** rescan branches honour the turn lock:

- The per-agent branch defers its rescan until that agent's lock is free
- The **whole-root** branch waits on the first held lock in the root and **re-evaluates on each release**, so several concurrent turns need no tracking — the scan runs when the last one is gone

The whole-root branch is the easy one to miss, and it is also where an unattributable event lands: a per-agent-only guard could be bypassed by nothing more than a platform that declined to name the file that changed.

### Platform note: a rescan can fire with nothing having changed

macOS FSEvents replays a backlog of changes made shortly **before** a watcher is armed. That happens on every arm, not only the first:

- the initial arm of a root,
- the one-shot re-arm after a watcher error,
- each Linux-fallback refresh when the agent set changes.

So a rescan can be triggered by a watcher's own recovery, with no user action and no file having changed. **Idempotent, non-destructive rescans are therefore load-bearing** — it is why the identity and pruning rules above matter at cold start, not only during editing. A watcher test must drain and reset before asserting, or it will see its own setup writes and fail for the wrong reason.

### Writes into an agent folder

- The desktop writes only through the page editors and the scaffolder, never anywhere else
- Every write takes the **turn lock**, which never queues: a save arriving mid-turn tells the user the agent is running rather than landing silently seconds later
- Every write is guarded by the **stamp the caller read**, not one taken at write time — a stamp taken microseconds before the write would guard nothing. Metadata is only a pre-check; the SHA-256 of the bytes decides, because a second writer that replaces a file at equal size with preserved timestamps (`cp -p`, `rsync -t`, `git checkout`, a backup restore) passes an mtime+size comparison
- A refused write carries a **stale-write code** of its own (`file_modified` for a prompt document, `manifest_modified` for the manifest), distinct from "you typed something unusable", so the page can show a reload prompt. It must never be retried with a fresh stamp — that retry is exactly the clobber the guard exists to prevent
- The lock coordinates this process with itself only. A coding assistant editing from a terminal is covered by the stamp instead — the two guards are complementary, and both are needed

### `app-data/desktop.json`

The **only** file in an agent folder the desktop owns. Everything else belongs to the kit, the assistant, or the agent.

- Holds per-machine runtime state nobody else needs: where the agent's local API answered, the token it was linked with, engine session ids per chat, persisted permission decisions, and the last status snapshot
- Created **lazily** — a freshly scaffolded folder does not have one, and a folder that never ran should not gain one — and written atomically, because a scan may read it while a turn writes it
- Reading it is **total**: a file another build wrote degrades to defaults rather than throwing, since the scanner reads it for every agent on every pass
- `agentToken` is a secret and never leaves the main process. The renderer gets a summary reporting *presence* only

### Paths that arrive from outside

Two different questions, answered by two different mechanisms that must not be merged:

| | `pathGuard` (`src/main/services/pathGuard.ts`) | `pathRules` (`src/main/services/localAgents/pathRules.ts`) |
|---|---|---|
| Question | "Did the user hand us this exact path just now?" | "May this location be an agents root?" / "Is this file inside one?" |
| Shape | TTL allowlist populated by file dialogs and drop events | Stateless allowlist of locations + containment test |
| Lifetime | One hour per recorded path | Permanent rule |
| Used by | File ingest for chat attachments | Roots, the home setting, agent-relative reveals |

Both are real and both stay. Further rules:

- `local-agent:root-add` **never accepts a renderer-supplied path.** It opens a native directory dialog in main and uses what the user picked — the pattern any future path-taking channel should follow
- A root may live in the user's home directory, on a mounted volume (`/Volumes`, `/media`, `/mnt`, `/run/media`) or in the temp dir, and nowhere else. Not the home directory itself, not `/`. Existing paths are re-checked after `realpath`, so a symlink at an allowed location pointing at `/etc` is refused
- An agent-relative path from the renderer (the "reveal in Finder" affordance) must be relative, must not climb, and must still be inside the agent folder **after** symlink resolution
- A refused path is never logged — only its length. A hostile renderer must not be able to use the log as a filesystem-layout oracle

### A folder agent is not editable through the agents form

- `agents:upsert` rejects a `folder:` id the way it rejects `remote:`: a folder agent is edited by writing the files its row is derived from
- Deleting the row is refused with its own error code (`folder_immutable`, distinct from the sync-managed `remote_immutable`, which the renderer explains with an entirely different story). Deleting the row would only make the next scan re-create it — the folder *is* the agent

## Architecture Overview

```
Agents tab / agent page (renderer)
  -> useLocalAgents, useLocalAgentWatch   (window.api.localAgents.*)
       -> local-agent:list | :get | :create | :update-field | :rescan
                           | :validate | :open-path
                           | :roots-list | :root-add | :root-remove
            -> localAgentService                (composition root of the slice)
                 -> agentsHomeService   the home, extra roots, .cinna-kit copy
                 -> scaffoldService     templates/agent -> Local/<slug>/
                 -> scannerService      folder -> DTO -> agents rows (one transaction)
                 -> desktopStateService app-data/desktop.json
                 -> turnLock            per-agent write / rescan gate
                 -> pathRules           may this be a root / is this inside one
                 -> watcherService      fs.watch per root
                                          -> local-agent:changed -> renderer

Files on disk  ── truth ──►  agents rows + agent_roots rows  ── derived index
      ▲                                   │
      └── assistant, agent, scaffolder ───┘ (rebuildable at any time)
```

## Integration Points

- [Kit Contract & Manifest Layer](kit_contract.md) — the manifest reader, validator, layout rules and templates every scan and scaffold runs on; also the stamp used by every write
- [Open in… (Local Agent Tools)](open_in_tools.md) — the registered roots are exactly the allowed area of its path guard, registered by this slice at IPC registration. Until that runs, open-in refuses everything
- [Agents](../agents/agents.md) — folder agents join the same merged agents list, the same id-prefix scope resolution, and the same `enabled` toggle; A2A endpoint and token resolution short-circuit for them
- [cinna-core handover](cinna_core_handover.md) — the folder shape this layer reads, and the changes asked of the kit and the server
- [Settings Scope](../../core/settings_scope/settings_scope.md) — folder agents are machine-local and live in the default (settings) scope
- [Database Migrations](../../development/migrations/migrations_llm.md) — `agent_roots`, the `agents` columns, and why the chain moved into its own module
- [Resource Activation](../../core/resource_activation/resource_activation.md) — every channel here requires an activated user session
- [Jobs](../../jobs/jobs/jobs.md) and [Orchestrated Agents](../../chat/orchestrated_agents/orchestrated_agents.md) — both pick counterparties from the agents list, and both offer folder agents; see [Folder Agents as Counterparties](counterparty.md)

Sub-doc: [Technical Details](folder_index_tech.md)
