# Agents Tab & Agent Page

## Purpose

The user-facing surface of Local Agents: a top-level **Agents** tab whose rows are folders on disk, a per-agent **page that is a viewer over that folder** (every card names the file it reads, three of them edit it in place), a one-sentence **New agent** flow, and a **Settings → Local Agents** section for the roots, the kit contract and this machine's readiness.

Phase 3 of Local Agents. It is built entirely on [Agents Home, Scanner & Folder Index](folder_index.md) and [Open in… (Local Agent Tools)](open_in_tools.md); it adds no new notion of what an agent *is*. Chatting with a folder agent, running one of its commands and choosing its runtime all arrive with the local engine — those controls render **disabled** rather than hidden, so the shape of the finished page is legible from the first release.

## A note on paths

Three trees are discussed here and their paths look alike, so they are written differently throughout — the same convention as [Agents Home, Scanner & Folder Index](folder_index.md) and the [cinna-core handover](cinna_core_handover.md):

| Written as | Means |
|---|---|
| `src/...`, `docs/...` | A file in **this repository** |
| `Local/<slug>/...` | Inside an **agent folder**, i.e. relative to a registered root |
| `cinna-agent.json`, `credentials/.env`, `app-data/desktop.json` | Also inside an agent folder, where the sentence has already established we are in one |

The one that catches people: an agent folder has its own `Local/<slug>/docs/` holding `WORKFLOW_PROMPT.md`, `ENTRYPOINT_PROMPT.md` and `REFINER_PROMPT.md`. None of them is this repository's `docs/`.

## Core Concepts

- **Agents tab** — Fourth entry in the sidebar tab strip (`Chats | Jobs | Notes | Agents`). Lists every folder agent, grouped by the root it lives in
- **Agent page** — The per-agent screen. Eleven cards, each naming an agent-relative file: Description, Example prompts, the three prompt documents, Runtime, Credentials, Commands, Status, Published to, Runs
- **File editor** — One in-place editor over one file. A pure state machine in `src/renderer/src/utils/localAgents.ts` plus a thin React shell in `src/renderer/src/hooks/useLocalAgents.ts`
- **Stamp** — `{mtimeMs, size, hash}` for an editable file, round-tripped through a save so a write over a file that changed underneath is refused. Defined in `src/shared/localAgents.ts`
- **Save outcome** — Three, not two: *saved*, *conflict* (terminal), *blocked* (retryable)
- **Identity state** — Where an agent's row id comes from: `manifest`, `legacy` or `unresolved`, plus the pseudo-state of a **duplicate** folder that lost an id collision
- **Stamp identity** — The offered, never automatic, write of a fresh UUID `id` into a legacy manifest — which also **re-keys** the agent's row rather than re-creating it
- **AI draft** — The one-shot LLM call that follows a scaffold, filling the workflow prompt, three example prompts and the router trigger
- **Readiness strip** — The line at the top of the agent page saying whether this folder can run, with the validator's own findings under it
- **Counterparty exclusion** — the temporary reason a folder agent did not appear in the composer `@`-list or the Job agent picker while the page's own chat controls were disabled. A named predicate, deliberately not the `enabled` column; gone with the runner that made it unnecessary — see [Folder Agents as Counterparties](counterparty.md)

## User Stories / Flows

### Browsing agents
1. The user clicks **Agents** in the sidebar tab strip. Like Jobs, the tab lands on the empty page rather than auto-selecting — the first agent is ambiguous once the list is grouped by root, and opening one starts reading a folder nobody asked for
2. The list groups agents by root: the default home first, then added roots in registration order. A registered root with no agents still gets a group, so an empty adopted folder reads as empty rather than ignored
3. A root heading only appears once there is more than one root, or one is missing from disk — with a single home labelled "Agents" it would merely repeat the header above it
4. Each row carries a readiness dot and a sub-line. The sub-line order is the design's: what the agent last said about itself (`app-data/storage/STATUS.md` summary) → the *reason* an invalid folder is invalid → the short readiness label → the description

### Creating an agent
1. **+** opens the New agent form. The user writes one sentence: what the agent should do
2. A name is suggested from that sentence — mechanically, by stripping the framing words ("an agent that…", "I want it to…") and title-casing the first few remaining words. A suggestion visibly derived from the user's own words is easier to correct than one a model invented
3. A folder name (slug) is derived from the name and shown as a real path preview (`<root>/Local/<slug>`). It is editable, because it is a directory an assistant will `cd` into and a Cinna instance will import by
4. **Create agent** scaffolds the folder and returns immediately. The user lands on the agent page
5. The page — not the form — then asks for the AI draft, so closing the form neither cancels nor hides it. The readiness strip shows "Drafting…", then the outcome
6. With no AI credential configured the folder is still created; the draft comes back `skipped` and the strip says what to add

### Editing a prompt in place
1. The user clicks the Workflow prompt card's text. No edit mode, no Save button — the Notes inline-editor pattern
2. Typing autosaves 700 ms after the last keystroke; blurring saves immediately
3. The save carries the stamp **the rendered text was read with**. Main re-stamps the file, compares, and writes atomically only if they match
4. The card shows "Saving…", then the text the folder now holds — read back from the returned agent, not echoed from the request

### An assistant edits the same file
1. Claude Code rewrites `Local/<slug>/docs/WORKFLOW_PROMPT.md` while the card is open
2. The watcher pushes `local-agent:changed`; the query invalidates and a new snapshot arrives
3. **Clean editor**: the new text is adopted silently — an assistant's edit appears without a click
4. **Dirty editor**: the user's text is kept, a conflict banner appears, autosave stops. The banner offers the disk contents in a disclosure and a **Reload** button. Nothing is discarded without the user saying so

### A save that arrives too late
1. The user types while an assistant has already changed the file; the save is sent with a now-stale stamp
2. Main refuses it (`manifest_modified` for the manifest, `file_modified` for a prompt document)
3. The same conflict banner appears, worded "your save was refused". The save is **never retried** — retrying with a fresh stamp is exactly the overwrite the refusal prevented

### A save during a run
1. A turn holds the agent's lock; the desktop must not write into the folder mid-stream
2. Main refuses with `turn_in_progress`. This is **not** a conflict: nothing was written, nothing changed underneath, the stamp is still good
3. The card says quietly "This agent is running. Your changes are saved as soon as it finishes.", keeps the text, and the autosave timer re-arms at a longer interval (3 s rather than 700 ms — a turn runs for minutes)

### Giving a legacy folder a durable identity
1. A folder whose `cinna-agent.json` states no `id` opens and edits normally, but its identity is *positional* — root plus folder name — so renaming or moving it starts a different agent
2. The readiness strip says so, as information rather than a fault, and offers **Stamp identity**
3. Clicking it writes a fresh UUID `id` (and `contract_version` when absent) through the ordinary stamped write — the same guard as any other edit, because an assistant may have that file open
4. The agent's row is **re-keyed**: its chats, sessions, job links and message attributions follow it to the new id
5. The page follows the selection to the returned agent, because the old row id no longer exists

### Two folders claiming the same id
1. Copying an agent folder to start a new one duplicates its manifest `id` — ordinary, not exotic
2. The first folder alphabetically owns `folder:<id>`. The loser is still listed, marked invalid, with a finding naming the other folder
3. The loser is **selectable but never indexed**. Clicking it lands on the page's "This agent is not indexed" state, whose copy explains the collision and offers a rescan

### Settings → Local Agents
1. **Agents folders** — each registered root with its path, agent count and resolved kit contract version; Reveal on each; Forget on the added ones (the home cannot be removed); a rescan-everything button
2. **Add an agents folder** — opens the OS directory picker in main; a non-empty folder gets a native confirmation before templates are installed
3. **Readiness** — three lines: AI credential (does the *default chat mode's own provider* resolve to a usable key?), Local engine (not installed yet), Agents (how many need attention, by name)
4. **Developer tools** — the detected CLI assistants and editors, with a Refresh, plus the bundled kit contract version

## Business Rules

### The editor state machine is pure, and lives outside React

`src/renderer/src/utils/localAgents.ts` holds the entire Invariant 3 rule as plain functions over a `FileEditorState` — no React, no `window`, no DOM: `seedFileEditor`, `editFileText`, `receiveFileSnapshot`, `saveRequest`, `saveSucceeded`, `saveRefused`, `saveBlocked`, `reloadFileEditor`, `isDirty`. `useAgentFileEditor` is only the glue (debounce, mutation, cache writes). The rules it encodes are correctness requirements, not details:

- **The stamp handed back on save is the one taken by the read that produced the text the UI rendered.** `saveRequest` returns `state.stamp` and nothing else. A stamp re-read at save time, or taken from a snapshot that arrived since, detects nothing — the guard becomes a rubber stamp
- **The stamp is not refreshed while the editor holds unsaved work.** That is what makes a save over an assistant's edit refusable at all
- **A refused save is never retried.** `saveRequest` returns `null` while a conflict stands, so continued typing cannot resume saving. Only the user's explicit reload clears it
- **`reloadFileEditor` pairs `diskText` with `diskStamp` from the same read.** A text reloaded against some other read's fingerprint simply bounces the next save. The conflicting read is preferred when there is one, because it is the pair the conflict was raised from
- **"My slice didn't move" is a distinct branch of `receiveFileSnapshot`.** Three editors share `cinna-agent.json` (description, example prompts, router trigger). Saving the description restamps the file under the other two. When the file's stamp changed but *this editor's value* did not, the editor adopts the new stamp and stays usable. Without that branch, editing one manifest card would raise false conflicts on the other two
- **A save in flight does not lose later keystrokes.** `saveSucceeded` writes back only `savedText`/`stamp`; text typed meanwhile stays dirty and saves next

### Three save outcomes, not two

| Outcome | Code | Meaning | Response |
|---|---|---|---|
| Saved | — | Written; the folder was re-read | Adopt the read-back text and the new stamp |
| **Conflict** | `manifest_modified`, `file_modified` | Someone else changed this file. The edit can no longer be applied | Terminal. Banner, disk preview, Reload or discard. **Never retried** |
| **Blocked** | `turn_in_progress` | *Not yet*. Nothing was written, nothing changed | Retryable. Keep the text, say so quietly, re-arm the debounce at 3 s |

Collapsing blocked into conflict would read Invariant 3 as "discard what the user typed during a run", which it does not say. Reporting it as a plain error is just as bad: the edit is then left with no armed timer and no path back, and is lost the moment the user navigates away.

**`saveBlocked` must return a fresh state object even when the flag is already set.** The autosave effect keys off state identity; returning the same object leaves a blocked editor with no armed timer and the user's text stranded until they happen to type another character. This is asserted by a test, because it looks exactly like a redundant allocation.

### One save at a time, and one armed timer at a time

Two guards inside `useAgentFileEditor`, both fixing the same class of bug:

- Whatever triggered a save — the timer firing or a blur — the armed timer is cleared first. A blur at t=200 ms used to leave the t=700 ms timer armed, and that second save went out with the *same* stamp while the first was still in flight: the first landed, the second was refused as `manifest_modified`, and the user was told their file had changed on disk for a save that had just succeeded — with Reload (which discards their text) the only way out
- An in-flight flag blocks a second send for the same reason: a request built from the pre-save stamp is guaranteed to be refused. Work typed during the flight is not lost — the settle handler changes state, which re-arms a fresh timer

### IPC error codes do not survive a thrown rejection

**Two** boundaries drop an error's own properties: `ipcMain.handle` serialises a rejection to `{message, stack}`, and `contextBridge` then clones whatever preload throws into the renderer's world as a fresh `Error`. `src/main/ipc/_wrap.ts` attaches `err.code` faithfully and both crossings discard it, so `isStaleWriteError` answered `false` for a genuinely stale write and the reload prompt it gates never fired.

The two channels whose codes drive renderer behaviour therefore return the failure **as data**:

- `local-agent:get` — `not_found` is a routine destination (a duplicate folder has no row), and the page must say "not indexed", not "your folder is missing"
- `local-agent:update-field` — three refusals, three different behaviours; only the code separates them

Both return `LocalAgentOutcome<T>` (`{ok:true,value}` | `{ok:false,code,name,message}`); `unwrapLocalAgentOutcome` turns it back into a throw **in the renderer**, past the second boundary. Unwrapping in preload would put the rebuilt error on the wrong side of `contextBridge`.

**This is the pattern for any future channel whose failure code drives behaviour.** It is deliberately *not* applied everywhere: the rest of the app uses an older convention — a **returned** `{success:false, code}` that the renderer re-throws — and a channel whose failure is only ever shown as a sentence keeps throwing. A side benefit of the outcome shape is the message: the raw crossing wraps main's sentence as *"Error invoking remote method '<channel>': …"*, which is a sentence about our IPC layer, not about the user's folder.

### Identity states, and what the user sees

| State | Cause | Row id | User sees |
|---|---|---|---|
| `manifest` | The manifest states an `id` | `folder:<uuid>` | Nothing special — the ordinary agent |
| `legacy` | The manifest parsed but states no `id` (the contract tolerates this on purpose) | `folder:legacy:<rootId>:<folderName>` | An informational strip explaining that the identity is the folder's *place*, with a **Stamp identity** button |
| `unresolved` | The manifest could not be read at all | The id of the row already at that path | Listed and selectable; readiness `invalid` with the parse finding. Never re-indexed, so the row, its id and its chats are untouched |
| *duplicate* | Two folders claim the same manifest `id` | `folder:duplicate:<rootId>:<folderName>` | Listed, marked invalid, sub-line names the other folder. Selectable but **not indexed** — clicking lands on the "not indexed" page |

The duplicate case earns its own id for a reason with teeth: leaving both rows on `folder:<id>` gave React a **duplicate key**, and a click on the loser opened the **winner's editable page** — the user then edited a different agent's files with nothing on screen saying so. A positional, never-indexed id makes `locate()` refuse, and refusal is what routes the page to its explanatory state.

### "Stamp identity" re-keys rather than re-creates

Letting the ordinary scan absorb a new manifest `id` is an insert plus a prune. The prune cascades `a2a_sessions`, `chat_on_demand_agents` and `job_agents` away, and leaves `chats.agent_id`, `jobs.agent_id`, `agent_overrides.agent_id` and the three `messages.*_agent_id` columns dangling, because none of those declares a foreign key. That is precisely backwards: the action is *offered* as the cure for "this folder loses its chats if you rename it", so it must not lose them.

`agentRepo.rekeyFolderRow` therefore moves the row and repoints all nine sites in **one transaction**, ordered insert-copy → repoint → delete. Because the children are moved while both parent rows exist, nothing references the old row by the time it is deleted, so its `ON DELETE CASCADE` removes nothing and no `defer_foreign_keys` is needed.

The `messages.*` columns deserve their own note: they are the ones no cascade touches. They do not disappear when the row does — they stop **resolving**, which is a silently broken transcript (lost per-agent colouring and sub-thread grouping) rather than a visibly missing one.

**A manifest `id` changed on disk is a different event.** An assistant editing `id` is a new identity claim about the folder, and the scanner is right to prune and re-insert. Stamping is the desktop completing an identity the folder always had, so the rows follow it. The write itself is refused if the manifest already has an `id`.

### The AI draft

- **Runs in main** (`src/main/services/localAgents/draftService.ts`), on the existing one-shot AI function — the same primitive as Auto Chat Titles. See [AI Functions](../../llm/ai_functions/ai_functions.md)
- **Bounded**: `AbortSignal.timeout` at 90 s per call, output capped (8 000 chars for the workflow document, 2 000 for the metadata block). A wedged provider must not wedge creation
- **A down provider degrades the draft, never the creation.** A failed call returns `null` rather than throwing; the folder already exists
- **No credential is a supported state, not an error.** The call resolves `skipped` with a sentence naming what to add
- **Stamps are taken before the model runs.** A stamp taken after a 30-second call would certify nothing about the file the write lands on. An assistant that edits the folder during the call has its work refused-into rather than overwritten, and a refused part is reported, never retried
- **It only ever fills a blank.** A workflow document that no longer carries the scaffold template's markers, a non-empty `example_prompts`, an already-set `router_trigger_prompt` — each is left alone. The user and their assistant own those files the moment they touch them
- **Every field is validated exactly as a hand edit**, because it goes through the same `local-agent:update-field` path with the same stamp guard and the same length limits
- **Partial success is reported honestly**: the outcome names which parts failed ("Drafted, except the example prompts — edit that card on this page")
- **Two guards against a concurrent draft.** A renderer `useRef` in the agent page, because React StrictMode runs mount → cleanup → mount with no render between and the second invocation still sees the pre-`null` Zustand value — a ref is written synchronously and is what that invocation actually reads. And an in-flight `Set` in `draftService`, which covers every future caller including a retry button nobody has written yet. Without them: two billed calls of up to 90 s each, both capturing the same pre-call stamps, the loser correctly refused and then reporting "the draft could not be written" for a folder that drafted perfectly well — and, because it settles last, it is the *successful* run that gets hidden

The parse of the model's metadata output is line-based (`TRIGGER:` / `PROMPT:`) rather than JSON: a small model that fumbles one line still yields the others, where one stray character in a JSON object yields nothing at all. Anything unrecognised is dropped rather than guessed at.

### Slug diagnosis is not slug generation

`slugifyAgentName` returns `''` for three unrelated reasons, and a form that reports them with one sentence tells two of those users something false. `describeAgentSlug` therefore returns a diagnosis — `ok` | `empty` | `too_short` | `not_transliterable` — with its own sentence and an editable **suggestion**. Both share one reducer, so the previewed folder and the folder the scaffolder creates cannot drift.

**A non-Latin name is not blocked.** "日本語エージェント" has plenty of letters; saying "no letters or digits" to that user is both wrong and a dead end. Instead:

- The folder field is editable and **prefilled** with a usable suggestion (`agent`, or `<reduced>-agent` for a one-character name)
- The hint renders as **muted text, not an error**
- **Create stays enabled**
- The manifest keeps the user's real name; only the folder is ASCII

Typing in the folder field holds the raw text rather than normalising per keystroke — normalising on every keystroke makes a hyphen impossible to type, since the rule strips a trailing one. The finished value is derived on blur.

### Example prompts round-trip through a textarea

`example_prompts` is a list in the manifest and one-prompt-per-line in the card. Blank lines are how a list is edited, not entries, so they are dropped. Two edge cases are decided in the shared util rather than in the component:

- A prompt containing a **newline** (only an assistant or a hand edit can produce one) is *flattened* to one line on display, never split into two. Flattening is visible and reversible; splitting silently changes how many prompts the agent has
- A line that is too long, or too many lines, is reported **with its number** before the save is sent. Main can only answer "one of these is too long", which against a ten-line textarea is not something a user can act on. The list is still built in full — never silently shortened

### Chat controls render disabled

The runner is Phase 6. **Start chat** on the page header and **Run** on each command row are present, disabled and titled with why. Hiding them would make the finished page's shape invisible; enabling them would produce an error where the user expected a reply. (Both are live now: `/run:<name>` in [Catalog Commands](commands.md), **Start chat** with it.)

(The Runtime card's pickers were disabled in Phase 3 for the same reason and became interactive in Phase 5, which also gave the card an engine status line and a skip line — see [The Local Engine](engine.md).)

The same restriction elsewhere was a named predicate — a **temporary** exclusion of folder agents from the composer `@`-mention list and the Job agent picker. It was deliberately *not* expressed by clearing `enabled`: `enabled` means only the user's own choice and survives every rescan, so borrowing it here would have made "the user turned this off" and "no runner exists yet" indistinguishable exactly when the runner arrived.

The predicate and its two call sites were deleted rather than migrated, in **Phase 7c** — not Phase 6, which built the runner but did not open the pickers to it. Both filters now read `a.enabled` alone. See [Folder Agents as Counterparties](counterparty.md).

### Readiness, drafting and stamping share one strip

The strip's findings are the validator's own — same codes, same messages as the kit's `validate` — so the page agrees with whatever the user's assistant sees in the terminal. The strip also hosts the legacy-identity notice, the drafting spinner and the draft outcome, so an agent page has exactly one place where "something about this folder needs your attention" appears.

### Project rules this phase honours

- Every colour is a `var(--color-*)` token, severity tokens included. No hardcoded colour anywhere in the slice
- `src/renderer/src/assets/main.css` is **untouched**, so there is no `@layer base` ordering risk from this phase
- **No `window.api.*` in any component.** Every call goes through `src/renderer/src/hooks/useLocalAgents.ts` or `src/renderer/src/hooks/useLocalTools.ts`
- Server state lives in **React Query**; Zustand holds UI-only state (which agent is selected, one pending-draft intent)
- Agent-authored markdown (`STATUS.md`, and any prompt document rendered as markdown) goes through `react-markdown` with `remark-gfm` and **no `rehype-raw`** — the content is written by a model and by third-party tooling, and raw HTML must not be a rendering path
- The prompt documents render as **plain text**, not markdown: they are written for a model, the scaffold template leads with an HTML comment, and rendering would either show that comment as prose or hide part of a file the page claims to be a viewer over

## Known gaps

Documented rather than papered over:

- **Six local-agents sites still render `err.message` raw** — the list's load error, the New agent form's create error, the Open-in row, and three in Settings (add root, forget root, reveal). Those channels throw, so a failure shows as *"Error invoking remote method '<channel>': …"*. Only the two outcome-returning channels are clean
- **The autosave-race fix has no automated test.** There is no jsdom or testing-library in the repo (`vitest.config.ts` runs `environment: 'node'`), so the double-save-with-one-stamp bug was proven by a manual probe in the running app, and the probe reverted. The pure state machine underneath *is* fully tested; only the React glue is not. Adding renderer test infrastructure is a tracked follow-up
- **`draftService`'s `wantsWorkflow && !workflowStamp` branch is untested**, and marked as such in a comment. Reaching it needs the workflow document deleted between two reads in the same scan; covering it would mean a seam whose only purpose is that branch
- **The readiness strip's headline for a valid-but-warned folder reads slightly oddly** — warnings are listed under "This folder is valid and every credential it needs is set." Known, deliberately unchanged

## Architecture Overview

```
Sidebar tab strip ── Agents ──► LocalAgentsList ──► LocalAgentPage
                                     │                    │
                                     │                    ├─ ReadinessStrip (readiness, legacy, draft)
                                     │                    ├─ OpenInRow      (local-tools:*)
                                     │                    ├─ ManifestCards  ┐
                                     │                    ├─ PromptDocCard  ├─ InlineFileEditor
                                     │                    └─ ReadOnlyCards  ┘   (pure state machine)
                                     │
Settings ── Local Agents ──► LocalAgentsSettingsSection

  useLocalAgents / useAgentFileEditor / useLocalTools        (the only window.api callers)
       │
       ├─ React Query   list, get, read-doc, roots           (server state)
       └─ Zustand       activeLocalAgentId, pendingDraftAgentId   (UI only)
       │
       ▼
  local-agent:list | :get* | :create | :draft | :update-field* | :read-doc
                   | :rescan | :validate | :open-path
                   | :roots-list | :root-add | :root-remove
       (* returns LocalAgentOutcome<T> — the code must survive two boundaries)
       │
       ▼
  localAgentService ──► scannerService / scaffoldService / turnLock / pathRules
  draftService      ──► aiFunctions.runSingleShot  (timeout, length cap, stamps taken first)
  agentRepo.rekeyFolderRow                          (stamp identity: move, don't re-create)
       │
       ▼
  Files on disk ── truth ──► agents rows ── derived index
       │
       └── watcherService ──► local-agent:changed ──► query invalidation ──► editors adopt or conflict
```

## Integration Points

- [Agents Home, Scanner & Folder Index](folder_index.md) — everything this surface renders: the roots, the scan, readiness, the identity rules, the turn lock and the stamp guard
- [Kit Contract & Manifest Layer](kit_contract.md) — the manifest schema and validator behind every card, and the templates the scaffold and the draft's "untouched?" check read
- [Open in… (Local Agent Tools)](open_in_tools.md) — the Open-in row on the agent page and the Developer tools card in Settings
- [AI Functions](../../llm/ai_functions/ai_functions.md) — the single-shot primitive the draft runs on; the draft resolves the adapter from the user's **default chat mode**
- [Chat Modes](../../chat/chat_modes/chat_modes.md) — the default mode supplies the Runtime card's fallback model and the Settings readiness line's credential check
- [Notes](../../notes/notes/notes.md) — the inline-editor pattern (no edit mode, autosave on pause and blur) this page reuses over files instead of rows
- [Orchestrated Agents](../../chat/orchestrated_agents/orchestrated_agents.md) and [Jobs](../../jobs/jobs/jobs.md) — the two counterparty pickers this page's agents are offered in, and what an attached folder agent does once picked
- [App Shell](../../ui/app_shell/app_shell.md) and [Settings](../../ui/settings/settings.md) — the tab strip, the view routing and the settings menu this phase extends
- [Settings Scope](../../core/settings_scope/settings_scope.md) — Local Agents is machine-local, so its settings section sits in the **default** menu, not the profile one
- [Resource Activation](../../core/resource_activation/resource_activation.md) — every channel here requires an activated user session
- [Main-Process Layering](../../development/main_layering/main_layering_llm.md) — thin IPC controllers, services own the logic, repos own SQL; the outcome-returning channels are the documented exception to "throw a `DomainError`"

Sub-doc: [Technical Details](agents_tab_tech.md)
