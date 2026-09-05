# Agents Tab & Agent Page

## Purpose

The user-facing surface of Local Agents: a top-level **Agents** tab whose rows are folders on disk, a per-agent **page** that is a control surface first — open the folder in your own tool, start a chat, choose what it runs with — and a **viewer over that folder** underneath (every card names the file it reads, three of them edit it in place), a name-only **New agent** flow that ends by handing the new folder to the tool the user builds agents with, and a **Settings → Local Agents** section for the roots, the kit contract, the default tool and this machine's readiness.

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
- **Agent page** — The per-agent screen. A header (readiness dot, name, description, path) with three controls — **Open in <tool>**, **Start chat**, and a **⋯ menu** — then a **Runs with** panel, a readiness strip that appears only when something needs attention, and four tabs: **Overview** (Status, Description, Example prompts), **Prompts** (the three prompt documents), **Commands**, **Folder** (validation findings in full, identity, credentials, files, publications, runs). Every card still names the agent-relative file it reads
- **⋯ menu** — What a user does to an agent *occasionally*: Rescan folder, Reveal folder, Open terminal here, Stamp identity (legacy folders only), and **Delete agent…**, which always confirms
- **Default tool** — The `cli-assistant` or `editor` the Open-in button launches in one click, remembered in the `localAgentsDefaultTool` setting and rewritten by the last pick. Owned by [Open in… (Local Agent Tools)](open_in_tools.md); this page and the New-agent flow are its two writers
- **File editor** — One in-place editor over one file. A pure state machine in `src/renderer/src/utils/localAgents.ts` plus a thin React shell in `src/renderer/src/hooks/useLocalAgents.ts`
- **Stamp** — `{mtimeMs, size, hash}` for an editable file, round-tripped through a save so a write over a file that changed underneath is refused. Defined in `src/shared/localAgents.ts`
- **Save outcome** — Three, not two: *saved*, *conflict* (terminal), *blocked* (retryable)
- **Identity state** — Where an agent's row id comes from: `manifest`, `legacy` or `unresolved`, plus the pseudo-state of a **duplicate** folder that lost an id collision
- **Stamp identity** — The offered, never automatic, write of a fresh UUID `id` into a legacy manifest — which also **re-keys** the agent's row rather than re-creating it
- **AI draft** — The one-shot LLM call that follows a scaffold *when a description was given*, filling the workflow prompt, three example prompts and the router trigger. A name alone drafts nothing — there is no sentence to draft from
- **Readiness strip** — The lines at the top of the agent page that need attention, and nothing when nothing does: the readiness message for a folder that is not `ok` (with a "N findings" link to the Folder tab), the legacy-identity notice, the drafting spinner and the draft outcome
- **Counterparty exclusion** — the temporary reason a folder agent did not appear in the composer `@`-list or the Job agent picker while the page's own chat controls were disabled. A named predicate, deliberately not the `enabled` column; gone with the runner that made it unnecessary — see [Folder Agents as Counterparties](counterparty.md)

## User Stories / Flows

### Browsing agents
1. The user clicks **Agents** in the sidebar tab strip. Like Jobs, the tab lands on the empty page rather than auto-selecting — the first agent is ambiguous once the list is grouped by root, and opening one starts reading a folder nobody asked for
2. The list groups agents by root: the default home first, then added roots in registration order. A registered root with no agents still gets a group, so an empty adopted folder reads as empty rather than ignored
3. A root heading only appears once there is more than one root, or one is missing from disk — with a single home labelled "Agents" it would merely repeat the header above it
4. Each row carries a readiness dot and a sub-line. The sub-line order is the design's: what the agent last said about itself (`app-data/storage/STATUS.md` summary) → the *reason* an invalid folder is invalid, in the validator's own words with its backticks stripped (a sidebar line is not rendered as markdown, so "`id` is required." showed them literally) → the short readiness label → the description

### Creating an agent
1. **+** opens the New agent form. It asks for one thing: a **name**. Enter creates
2. The folder name (slug) is derived from the name and shown as a real path preview (`<root>/Local/<slug>`) under the field. It is a directory an assistant will `cd` into and a Cinna instance will import by, so it is shown before anything is written
3. **More options** holds the choices almost nobody makes at creation time: a description (**optional** — "What should it do?"), the folder name (editable), and which agents folder to scaffold into (only when there is more than one root). The agent is about to be built in Claude Code or Codex or OpenCode, and *that* is where its description usually gets written
4. **Create** scaffolds the folder and returns immediately. The user lands on the agent page. With no description, main writes the **name** as the manifest description — the kit schema requires a non-empty one — and the page shows "No description yet" rather than echoing the name twice
5. The form then shows a second step, **Build it with…**: every installed assistant and editor (the current default marked and focused), plus Terminal, Reveal folder and Not now. Picking a tool launches it at the new folder and **makes it the default**. A checkbox, "Open new agents this way without asking", mirrors the live `localAgentsAutoOpen` setting — ticked when auto-open is already on, as it is when this step appears after a failed automatic open — and the next pick writes whatever it says, so unticking it turns auto-open off. With it on, the step is skipped from then on and the Create button reads "Create and open in <tool>". **The modal closes only when the launch succeeds.** A refused open-in (tool uninstalled since detection, `automation_denied`, a path guard refusal) keeps the modal on this step with the error shown, so the user can pick something else — and the auto-open path lands on the same step the same way. Before this, a refusal closed the modal: a folder created and nothing opened, with no message anywhere, and with auto-open on that would have been the default path
6. Only when a description was given does the page — not the form — ask for the AI draft, so closing the form neither cancels nor hides it. The readiness strip shows "Drafting…", then the outcome. With no AI credential configured the folder is still created; the draft comes back `skipped` and the strip says what to add

### Opening the folder in a tool
1. The header's **Open in <tool>** launches the default tool at the folder in one click. Its chevron opens a menu of every installed assistant and editor, then Terminal and Reveal folder
2. Picking a different tool from the menu launches it **and makes it the new default** — the last pick wins. Terminal and Reveal never become the default
3. With no usable default — never picked, or the tool has since been uninstalled — the button is the menu itself, labelled "Open in…". A machine with no assistant or editor at all still gets Terminal and Reveal, and a sentence pointing at Settings → Local Agents → Refresh
4. Main re-validates the folder against the registered roots on every request; a refusal is shown under the button, not swallowed. See [Open in… (Local Agent Tools)](open_in_tools.md)

### Deleting an agent
1. **⋯ → Delete agent…** opens a confirm dialog. It leads with what is recoverable and what is not: the folder goes to the OS **Trash** and can be put back; existing chats stay but can no longer reach the agent, and any job that uses it will refuse to run. The copy deliberately does not say "until it is back": `job_agents` cascades away with the row, so restoring the folder from the Trash does not re-attach the job — only the stored dependency descriptor survives, and it keeps the run refused
2. **Move to Trash** takes the agent's turn lock, trashes the folder, releases the lock, and rescans the root. The row disappears because the folder is no longer on disk — the same prune every other removal goes through, never a direct row delete
3. The selection is cleared, so the page does not sit asking for a row that no longer exists. While "Deleting…" is showing the dialog cannot be dismissed — not by Escape, an outside click or Cancel — because dismissing it would cancel nothing; it would only leave the user looking at a page whose folder is being trashed with no sign that it is
4. If the agent is mid-turn the dialog stays open and says so — "This agent is in the middle of a turn. Wait for it to finish, then try again — nothing was removed." — because that is a *busy* answer, not a failure

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
4. **Developer tools** — the detected CLI assistants and editors, with a Refresh, plus the bundled kit contract version; then **Open agents with** (a select over the installed assistants and editors, or "Ask each time") and a checkbox, "Open a new agent there right after creating it, without asking", which is disabled until a default tool resolves. This is the explicit way to set or clear the default; the Open-in menu and the New-agent flow set it implicitly

## Business Rules

### The page is a control surface first, and a viewer second

The page used to be eleven stacked cards, each a viewer over one file. That was faithful to the folder and useless as a control surface: the runtime picker was the seventh card down, and Rescan and Reveal sat in the header beside Start chat as if they were what the page was for. The rules now:

- **Above the fold is what the user *does*.** Open in, Start chat and the ⋯ menu in the header; the **Runs with** panel (credential, model, engine status, declared secrets) directly below. Everything that is information rather than a control lives under the four tabs
- **The header carries the description, or an honest blank.** A folder created from a name alone carries that name as its description, because the schema demands one; rendering it under the name says nothing. `describedAs` (in `src/shared/localAgents.ts`) returns `''` when the description is only the name repeated, and the header shows "No description yet — add one under Overview" instead. The sidebar sub-line goes through the same function — and so does the **index row**: the scanner writes `agents.description` as `null` for such a folder, so the composer `@` popup, the `[+]` picker and the Jobs agent picker, which read that column and never see the manifest, show no "Alpha — Alpha" sub-line either. One function, applied where the row is built and where it is rendered, so the surfaces cannot disagree
- **The readiness strip renders nothing for an `ok` folder.** The green dot beside the name already says so, and a green banner on every page taught users to skip the banner. Consequence, deliberate: a folder that is `ok` *with validator warnings* shows no strip either — the warnings are on the Folder tab's Validation card, in full, and the **Folder tab carries a count badge** (errors + warnings) so they stay discoverable without opening it. The strip for a folder that is not `ok` is one line plus a "N findings" link to that tab, rather than the first six findings inline
- **The selected tab is kept across agents.** Someone working through the prompts of three agents does not want to click "Prompts" three times. The Commands tab carries a count badge when the catalog is non-empty; the Folder tab's badge is the findings count above
- **Stamp identity is offered in two places** — the strip's legacy notice and the ⋯ menu — and both hand back the manifest stamp the render read, never one taken at click time. Same Invariant 3 as every other write
- **The header has one error slot, owned by the page.** Open in and the ⋯ menu report through an `onError` prop into a single `role="alert"` line under the header row; neither renders its own text. It is cleared at the start of every header action and whenever the selected agent changes. Two absolutely positioned messages, one per menu, used to overlap when a second action failed while the first's message was still showing. The slot is **always rendered, at a fixed minimum height** — a conditional one moved the Runs-with panel down by the line's height the moment a refusal appeared, which is the same jump rule 1 forbids in the dialogs
- **Nothing moves while the user reads or types** ([UX Rules](../../development/ui_guidelines/ux_rules.md), rule 1). The New-agent dialog's error line — on both steps — and the Delete dialog's are always-rendered, fixed-height slots, so a refusal appears without pushing the buttons down; the Delete dialog's confirm button has a fixed minimum width, so "Deleting…" does not pull Cancel sideways. A runtime save in flight is a spinner in the Runs-with panel's corner, not a row under the selects, so saving never moves the tabs. The page's scroll container reserves its scrollbar gutter, so switching to a tab that overflows does not shift the header by a scrollbar's width. And a legacy folder whose only validation errors are the missing `id` gets **one** banner — the legacy notice, with Stamp identity and the "N findings" link — rather than that plus a readiness line saying "`id` is required."; the readiness line returns as soon as a second, unrelated error exists

### A description is optional, and the name stands in

`CreateLocalAgentInput.description` is optional. Main writes the **name** in its place when it is absent or blank, because the kit schema requires a non-empty `description` and a folder that fails validation from its first second is a worse start than a redundant sentence. The contract is "optional", not "may be blank": the form omits the field entirely rather than sending `''`.

Two consequences:

- **The AI draft runs only when a description was given.** Its whole input is that sentence; a name alone would draft fiction. The form queues the draft intent only in that case
- **`suggestAgentName` is gone.** It built a name from the sentence the user typed; there is no sentence to build from any more, so the mechanical suggester and its tests were deleted rather than left as dead code

### Delete goes to the Trash, and through the prune

- **Trash, never `rm -rf`.** The folder *is* the agent, it may hold work the user has not committed anywhere, and a mis-click has to be recoverable. `shell.trashItem` is the only removal
- **The row is not deleted directly.** Main rescans the root and the scan prunes what is no longer on disk — the same `replaceFolderIndex` path every other removal takes, so the cascade to `a2a_sessions`, `chat_on_demand_agents` and `job_agents` is the one already reasoned about in [Agents Home, Scanner & Folder Index](folder_index.md#pruning-three-conditions-one-rule). A second delete path with its own idea of what to drop is how the two would drift
- **What survives.** `chats.agent_id`, `jobs.agent_id`, `agent_overrides.agent_id` and the three `messages.*_agent_id` columns declare no foreign key — the same six the re-key transaction has to repoint by hand. The chat rows stay in the sidebar; their agent binding stops resolving. That is what the dialog says — "Existing chats stay, but they can no longer reach this agent, and any job that uses it will refuse to run." — and the code comment beside it names the three cascading tables, so the copy, the comment and this paragraph describe the same schema
- **A job bound to the agent is blocked, not silently agentless.** Its `job_agents` row cascades away, but the run gate reads the job's stored dependency manifest, which still carries the `source: 'folder'` descriptor keyed on the manifest id — and a later manifest rebuild carries that descriptor forward rather than dropping it. With no row for that id the run refuses with `incomplete_setup`. This is the same-machine route into the state [Local Agents Are Not Synced](local_only.md) describes. **Putting the folder back does not undo it**: the `job_agents` row is gone, so the restored agent is re-indexed but the job is no longer attached to it — the descriptor in `syncDeps` resolves again, the block lifts, and the job runs *without* the agent it once had unless the user re-attaches it. The cascade is a one-way door; the Trash is not
- **Under the turn lock, as owner `'delete'`.** A turn in flight refuses the delete with `turn_in_progress` rather than having its folder vanish mid-stream. The lock covers the trash call and is released before the rescan: the watcher's own rescan defers on that lock, and the explicit one is what makes the row disappear now rather than on the next debounce. A trash failure (`write_failed`) releases the lock and leaves the row and its readiness untouched
- **The channel returns a `LocalAgentOutcome`**, the third one to do so, because `turn_in_progress` is the one refusal the dialog has to *explain* rather than report. Afterwards main calls `engineManager.applyConfigChange` — the engine's config lists every folder agent, and one fewer is a change; fire-and-forget and a no-op unless the engine is running, the digest moved and no turn holds a lock, like the `update-field` call before it (see [The Local Engine](engine.md))
- **The ⋯ menu owns the delete mutation, not the confirm dialog, and clears the selection from the hook-level `onSuccess`.** TanStack drops a *mutate-level* callback once the component that called `mutate` has unmounted. A dialog that owned the mutation and was dismissed while "Deleting…" would have had its folder trashed and its row pruned and never cleared the selection: the page would sit on the deleted agent until a refetch declared it "not indexed" — wrong in every particular for a folder the user just removed. The menu lives exactly as long as the page does, which is as long as the selection
- **The pickers are refreshed too.** The composer `@` popup, the `[+]` picker and the Jobs agent picker read a different query (`['agents']`) that was previously refreshed only when a remote sync completed, so a deleted folder agent stayed pickable and its runner answered `not_found`. Create, stamp identity, delete and every watcher push now invalidate it as well

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

**The form renders the suggestion, never the sentence.** Under the Name field is the live path preview, `<root>/Local/<slug>`, and nothing else. The diagnosis sentence ("…needs at least two letters, so this one becomes `1-agent`") used to render there as muted text; it appeared on the first keystroke and vanished on the second, resizing the dialog twice — the user called it jumping. The slug is never blocking, it always resolves to *something*, so the sentence taught nothing the preview did not already show. The shared function and its tests keep the `message`; the renderer no longer reads it. This is rule 1 of [UX Rules](../../development/ui_guidelines/ux_rules.md).

**A non-Latin name is not blocked.** "日本語エージェント" has plenty of letters; saying "no letters or digits" to that user is both wrong and a dead end. Instead:

- The folder field (under More options) is editable and **prefilled** with a usable suggestion (`agent`, or `<reduced>-agent` for a one-character name), and the path preview shows it
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

The findings are the validator's own — same codes, same messages as the kit's `validate` — so the page agrees with whatever the user's assistant sees in the terminal. They are listed in full on the Folder tab's Validation card; the strip carries only the readiness sentence and a "N findings" link to it. The strip also hosts the legacy-identity notice, the drafting spinner and the draft outcome, so an agent page has exactly one place where "something about this folder needs your attention" appears — and that place is empty when nothing does. The validator requires `id` unconditionally, so every legacy folder is `invalid` with "`id` is required." as its reason; since the legacy notice already says that and carries the button that fixes it, the readiness line is suppressed while `manifest.id.*` are the only errors.

### Project rules this phase honours

- Every colour is a `var(--color-*)` token, severity tokens included. No hardcoded colour anywhere in the slice
- `src/renderer/src/assets/main.css` is **untouched**, so there is no `@layer base` ordering risk from this phase
- **No `window.api.*` in any component.** Every call goes through `src/renderer/src/hooks/useLocalAgents.ts` or `src/renderer/src/hooks/useLocalTools.ts`
- Server state lives in **React Query**; Zustand holds UI-only state (which agent is selected, one pending-draft intent)
- Agent-authored markdown (`STATUS.md`, and any prompt document rendered as markdown) goes through `react-markdown` with `remark-gfm` and **no `rehype-raw`** — the content is written by a model and by third-party tooling, and raw HTML must not be a rendering path
- The prompt documents render as **plain text**, not markdown: they are written for a model, the scaffold template leads with an HTML comment, and rendering would either show that comment as prose or hide part of a file the page claims to be a viewer over

## Known gaps

Documented rather than papered over:

- **Five local-agents sites still render `err.message` raw** — the list's load error (`LocalAgentsList.tsx:94`) and **four** in Settings (the engine-path save at `LocalAgentsSettingsSection.tsx:85`, reveal `:226`, forget root `:243`, add root `:265`). Those channels throw, so a failure shows as *"Error invoking remote method '<channel>': …"*. The page redesign's surfaces are clean: the Open-in menu (`OpenInMenu.tsx:66`) and the ⋯ menu (`AgentActionsMenu.tsx:175`, fed by Rescan, Reveal and Terminal) both report through `unwrapIpcError` into the page's one alert slot, and the New agent form's line (create, the "Build it with…" launch and its Terminal/Reveal — `NewLocalAgentModal.tsx:127,157,178`) goes through it too; the outcome-returning channels never carried the prefix — the page's stamp error, `RuntimePanel.tsx` and the delete dialog (`AgentActionsMenu.tsx:74`) route through `local-agent:update-field` or `local-agent:delete` and `unwrapLocalAgentOutcome`, so their Errors are built renderer-side. **This line previously said six and named six, which read as exhaustive**, then seven, then eight. Recounted at `b566d83` on 4 Sep 2026 by tracing every renderer `.message` read to its IPC channel and checking whether that handler throws (message arrives prefixed) or catches internally and returns `{success:false}` / a `LocalAgentOutcome` (Error built renderer-side, already clean); recounted again with the page redesign, which retired the Open-in row's and the create form's sites by wrapping them rather than by moving them — a count that only ever went up is the reason this recount was done from a grep and not from the previous sentence
- **App-wide the same defect had 33 sites at `b566d83`, or 36 on a stricter reading** — the ambiguity is four handlers whose `requireActivated()` sits *outside* their internal try, so they reject with a prefixed message only for an unactivated session. Deliberately left as a range rather than resolved into one confident number, which is how the count above got to six. Six have since been repaired (the five jobs sites and `useAuth.ts:102`, the startup-failure screen), leaving **27, or 30 on the stricter reading** at `12686f0`; the page redesign then wrapped two of that set (the Open-in row's and the create form's), so **25, or 28**, if nothing else has moved — the app-wide set was not re-walked for this change. `unwrapIpcError` in `src/renderer/src/utils/ipcError.ts` is the fix, now used from twelve renderer files, and has its own unit test. **Note what is being counted: sites that put the string in front of a user, which is not the same set as sites that touch `.message`.** `JobEditForm.tsx:152` catches and returns `{ok: false, error}` and the rendering happens one level up in `JobEditPage.tsx:49`; counting by grep alone both over-counts (log-only and outcome-built sites) and under-counts (this indirection), which is the mechanism by which any figure here drifts
- **A raw `err.message` is not automatically a defect**, and a grep-and-fix sweep would break the clean ones. Thirteen of the candidates were excluded precisely because their handler catches internally and returns an outcome object, so the Error the renderer shows was never near the wire. Check the channel before touching the call site
- **CLOSED, not a gap — rechecked at HEAD on 4 Sep 2026.** This bullet used to read *"The autosave-race fix has no automated test. There is no jsdom or testing-library in the repo (`vitest.config.ts` runs `environment: 'node'`)… only the React glue is not [tested]. Adding renderer test infrastructure is a tracked follow-up"*. **Both halves were false.** `vitest.config.ts` declares *two* projects — `environment: 'node'` **and** `environment: 'jsdom'` (the `renderer` project) — and `@testing-library/react` and `jsdom` are both dependencies in `package.json`. The React glue is tested too: `src/renderer/src/hooks/useLocalAgents.autosave.test.tsx` is a regression suite over `useAgentFileEditor` covering the double-save-with-one-stamp bug itself (*"sends one save when a keystroke and a blur land on a save already in flight"*), the stamp the following save uses, a rejected flush leaving no timer armed, and the turn-lock refusal path. Retained here as **closed** rather than deleted: a gaps list that silently loses entries cannot be audited, and this one had already been wrong for long enough to be quoted as current. **The conclusion did not merely rest on a disproved premise — it was itself disproved**, so nothing of it survives
- **`draftService`'s `wantsWorkflow && !workflowStamp` branch is untested**, and marked as such in a comment. Reaching it needs the workflow document deleted between two reads in the same scan; covering it would mean a seam whose only purpose is that branch
- **CLOSED by the page redesign.** This bullet used to read *"The readiness strip's headline for a valid-but-warned folder reads slightly oddly — warnings are listed under 'This folder is valid and every credential it needs is set.'"* The strip no longer renders for an `ok` folder at all, so the sentence and the warnings under it are both gone from it; the warnings live on the Folder tab's Validation card. What replaces the oddity is a quieter trade-off, recorded under [The page is a control surface first](#the-page-is-a-control-surface-first-and-a-viewer-second): an `ok` folder's warnings are now one tab away rather than on the first screen
## Architecture Overview

```
Sidebar tab strip ── Agents ──► LocalAgentsList ──► LocalAgentPage
                                     │                    │
                                     │                    ├─ header: OpenInMenu (local-tools:*, default tool)
                                     │                    │          Start chat · AgentActionsMenu (rescan, reveal,
                                     │                    │          terminal, stamp, Delete… → local-agent:delete*)
                                     │                    ├─ ReadinessStrip (only when not ok / legacy / drafting)
                                     │                    ├─ RuntimePanel   (credential, model, engine, secrets)
                                     │                    └─ tabs: Overview ─ StatusCard, ManifestCards ┐
                                     │                            Prompts  ─ PromptDocCard ×3          ├─ InlineFileEditor
                                     │                            Commands ─ CommandsCard              ┘   (pure state machine)
                                     │                            Folder   ─ FolderTab (validation, identity,
                                     │                                       credentials, files, published, runs)
                                     │
NewLocalAgentModal ── name ─► local-agent:create ─► "Build it with…" ─► local-tools:open-in (+ default tool)
                                     │
Settings ── Local Agents ──► LocalAgentsSettingsSection (roots, readiness, tools, default tool, auto-open)

  useLocalAgents / useAgentFileEditor / useLocalTools / useDefaultTool   (the only window.api callers)
       │
       ├─ React Query   list, get, read-doc, roots, tools, app settings   (server state)
       └─ Zustand       activeLocalAgentId, pendingDraftAgentId            (UI only)
       │
       ▼
  local-agent:list | :get* | :create | :draft | :update-field* | :delete* | :read-doc
                   | :rescan | :validate | :open-path
                   | :roots-list | :root-add | :root-remove
       (* returns LocalAgentOutcome<T> — the code must survive two boundaries)
       │
       ▼
  localAgentService ──► scannerService / scaffoldService / turnLock / pathRules
                    ──► shell.trashItem, then scanRoot   (delete: the prune drops the row)
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
- [Open in… (Local Agent Tools)](open_in_tools.md) — the Open-in split button on the agent page, the "Build it with…" step of the New-agent flow, the default tool they both write, and the Developer tools card in Settings
- [Local Agents Are Not Synced](local_only.md) and [Jobs](../../jobs/jobs/jobs.md) — what a job bound to a deleted agent becomes: blocked on this machine, by the same gate
- [AI Functions](../../llm/ai_functions/ai_functions.md) — the single-shot primitive the draft runs on; the draft resolves the adapter from the user's **default chat mode**
- [Chat Modes](../../chat/chat_modes/chat_modes.md) — the default mode supplies the Runtime card's fallback model and the Settings readiness line's credential check
- [Notes](../../notes/notes/notes.md) — the inline-editor pattern (no edit mode, autosave on pause and blur) this page reuses over files instead of rows
- [Orchestrated Agents](../../chat/orchestrated_agents/orchestrated_agents.md) and [Jobs](../../jobs/jobs/jobs.md) — the two counterparty pickers this page's agents are offered in, and what an attached folder agent does once picked
- [UX Rules](../../development/ui_guidelines/ux_rules.md) — the interaction rules the page redesign and the New-agent form follow (nothing jumps while typing, controls before information, banners only when something needs attention, a confirm that tells busy from failed); the `cinna-desktop-ux-reviewer` agent checks a change against them
- [App Shell](../../ui/app_shell/app_shell.md) and [Settings](../../ui/settings/settings.md) — the tab strip, the view routing and the settings menu this phase extends
- [Settings Scope](../../core/settings_scope/settings_scope.md) — Local Agents is machine-local, so its settings section sits in the **default** menu, not the profile one
- [Resource Activation](../../core/resource_activation/resource_activation.md) — every channel here requires an activated user session
- [Main-Process Layering](../../development/main_layering/main_layering_llm.md) — thin IPC controllers, services own the logic, repos own SQL; the outcome-returning channels are the documented exception to "throw a `DomainError`"

Sub-doc: [Technical Details](agents_tab_tech.md)
