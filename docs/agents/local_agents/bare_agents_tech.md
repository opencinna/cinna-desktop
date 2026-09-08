# Bare Agents & External Roots — Technical Details

Business logic and the reasoning behind every rule: [Bare Agents & External Roots](bare_agents.md).

## File Locations

### Shared

- `src/shared/localAgents.ts` — `BARE_AGENT_PROMPT_FILE` (`AGENT.md`, with the note on why `AGENTS.md` is not accepted and what widening it would require), `BARE_AGENT_README_FILE` (`README.md`), `BARE_AGENT_MAX_DEPTH` (2), `LocalAgentKind`, `AgentRootKind`, `externalFolderAgentId()`, `LocalAgentDocKind`, `LOCAL_AGENT_DOC_PATHS`, `DiscoveredBareAgent` (with `addedElsewhere`, and a `name` that is the user's own where they gave one), `PickAgentFolderResult` (with `truncated` and `reselecting`), `AddAgentFolderInput` (whose `relPaths` is the **whole desired set** on a re-selection), `AddAgentFolderResult` (`agentIds`: the ticked agents, newly added first; empty only for a re-selection that emptied the list, and falling back to every indexed agent where the ticked ones produced none), `DeleteLocalAgentInput`, the `kind` / `hiddenAgentCount` / `truncated` / `isGitRepo` fields of `AgentRootDto`, and the `bare_prompt` member of `LocalAgentFieldUpdate`

### Main process — services (`src/main/services/localAgents/`)

- `externalScan.ts` — the walk. `isBareAgentDir()`, `readBareAgentName()`, `discoverBareAgents()` (with the clamped, test-only `limit`), `MAX_DISCOVERED_AGENTS` (200), and the `SKIP_DIRS` set
- `scannerService.ts` — `scanBareAgentFolder()` (which fills the DTO's `runtime` from the desktop state), `scanExternalRoot()`, `cachedScan()`, the `hiddenCount` / `truncated` fields of `ScanRootResult`, and the private `bareValidation()`, whose `bare.no_manifest` message says where the credential choice is kept
- `localAgentService.ts` — `pickedAgentFolder()`, `addAgentFolder()`, `renameAgent()`, `setBareRuntime()`, `restoreHiddenAgents()`, `scanFolder()`, `kindOf()`, the module-private `reseedEngineSessions()` and `bareName()`, the module-level `pendingPick`, and the `bare` / `trashFolder` branches of `delete()`
- `agentsHomeService.ts` — `addExternalRoot()`, `requireNamedRoot()`, `countBareAgents()` (the cold-path fallback only), and the `kind` / `hiddenAgentCount` / `truncated` / `isGitRepo` fields of `toDto()`
- `desktopStateService.ts` — `desktopStatePath(agentDir, kind)`, `forgetAt(path)`, the `displayName`, `hidden` and `runtime` fields of `DesktopState`, the private `coerceRuntime()`, and `externalStateRoot()`
- `permissionGrantService.ts` — every method takes a `LocalAgentKind` second argument, for the same reason
- `promptAssembly.ts` — `assembleBareAgentPrompt()` and the private `bareDesktopContextSection()`
- `runtimeService.ts` — `validate()` (shared by both writers) and `toRuntimeRef()`, the bare half of what `applyToManifest()` does for a kit agent
- `watcherService.ts` — `classifyExternalEvent()` (which stats the path), `externalFallbackDirs()`, `classifierFor()`, `refreshRoot()` (called after an adopt, because `watchRoot` returns early for a root already watched at this path), and the external branches of `armWatchers()` / `armFallbackWatchers()`

### Main process — elsewhere

- `src/main/db/schema.ts`, `src/main/db/agentRoots.ts` — the `kind` column and `CreateAgentRootInput.kind`
- `src/main/db/migrations/agent-roots.ts` — `ALTER TABLE agent_roots ADD COLUMN kind`
- `src/main/engine/engineConfigSource.ts` — the one branch in `collectEngineAgents()`
- `src/main/engine/configGenerator.ts` — `AGENT.md` in `IDENTITY_FILES`, and the docstring recording why `README.md` is not there and what would change it
- `src/main/ipc/local_agent.ipc.ts` — `:folder-pick`, `:folder-add`, `:rename`, `:set-runtime`, `:root-restore-hidden`
- `src/main/services/agentTurn/index.ts`, `src/main/services/agentTurn/localAgentTurnRunner.ts` — `agentKind` threaded through `saveSession` and `isGranted`

### Preload

`src/preload/index.ts` — `window.api.localAgents.folderPick()`, `.folderAdd()`, `.rename()`, `.setRuntime()`, `.rootRestoreHidden()`; `.delete()` now takes `DeleteLocalAgentInput`

### Renderer

- `src/renderer/src/components/agents/local/NewLocalAgentModal.tsx` — the `choose` / `folder` steps, the `FolderStep` component, and its in-step removal confirmation
- `src/renderer/src/components/agents/local/BareAgentCards.tsx` — `BareNameCard` and `BareReadmeCard`, the two cards of a bare agent's Overview
- `src/renderer/src/components/agents/local/RuntimePanel.tsx` — **one panel for both kinds**. `bare` picks the mutation and the not-editable rule; everything else — the pickers, the tier resolution, the Advanced conversion, every message — reads `agent.runtime`. There is no `BareRuntimePanel`; the read-only one it replaced could only report that the agent ran on the Default runtime
- `src/renderer/src/components/agents/local/LocalAgentPage.tsx` — the tab filter and the per-kind card sets
- `src/renderer/src/components/agents/local/PromptDocCard.tsx`, `InlineFileEditor.tsx` — the `markdown` prop (on for a bare agent's `AGENT.md`, off for the kit's three prompts), the per-card `missingNote`, the rendered view's height carried into the textarea, and the `bare_readme` throw. The `readOnly` prop both files carried is gone with the read-only card that was its only caller
- `src/renderer/src/utils/markdownComponents.tsx` — `documentMarkdownComponents` and `remarkStripHtml`, the map a **file** is rendered with rather than a chat message. See [Agents Tab — Technical Details](agents_tab_tech.md#renderer--hooks-store-utils)
- `src/renderer/src/components/agents/local/AgentActionsMenu.tsx` — the two-option remove dialog, its `aria-label` branching with its heading, and the copy that owns the `job_agents` cascade
- `src/renderer/src/components/agents/local/FolderTab.tsx` — `BARE_FILES`, the infos list, and the cards and rows that do not render for a bare agent
- `src/renderer/src/components/agents/local/ReadOnlyCards.tsx` — `RunsCard`'s file-less branch; `PermissionsCard.tsx` — the file-less card and the branched examples
- `src/renderer/src/components/agents/local/AgentCard.tsx` — `file` is optional, for the one card that names none
- `src/renderer/src/components/settings/LocalAgentsSettingsSection.tsx` — the `Added folder` badge, the read-only count line and the hidden-agents row
- `src/renderer/src/hooks/useLocalAgents.ts` — `usePickAgentFolder`, `useAddAgentFolder` (which also invalidates the `['local-agent']` key **prefix**: a re-selection edits agents that already exist, one of which may be the page behind the dialog, and the list keys do not reach `localAgentKey(id)`), `useRenameLocalAgent`, `useSetBareAgentRuntime`, `useRestoreHiddenAgents`; and `useLocalAgentWatch`'s whole-root branch, which invalidates the `['local-agent']` and `['local-agent-doc']` prefixes when the push names no agent — see [The watcher's push names no agent for a bare edit](#the-watchers-push-names-no-agent-for-a-bare-edit)

## Database Schema

`agent_roots.kind` — `TEXT NOT NULL DEFAULT 'workshop'`, added by `hasColumn`-guarded `ALTER TABLE` in `src/main/db/migrations/agent-roots.ts`. Values `'workshop'` | `'external'`. **The default is what makes it safe to add**: every root registered before external roots existed is a workshop, so there is no backfill and none is written.

No other schema change. A bare agent is an ordinary `agents` row (`source = 'folder'`, `protocol = 'local-folder'`) whose id happens to be positional, and `displayName` / `hidden` / `runtime` live in the state file, not in SQLite.

## IPC Channels

| Channel | Type | Signature |
|---|---|---|
| `local-agent:folder-pick` | invoke | `() → PickAgentFolderResult` — native `showOpenDialog` in main, then a read-only preview. **Takes no path**, and registers nothing |
| `local-agent:folder-add` | invoke | `(AddAgentFolderInput) → LocalAgentOutcome<AddAgentFolderResult>` — refuses a `path` that is not the one `:folder-pick` last returned, and refuses (`not_found`) when the scan indexes nothing, dropping the root again **only if this call created it**. `relPaths` is the whole desired set on a re-selection; an empty one is `invalid_input` on a first adopt and "take them all out of the list" on a re-selection. Answers with the root **and** the agent ids the user ticked, newly added first |
| `local-agent:rename` | invoke | `({agentId, name: string \| null}) → LocalAgentOutcome<LocalAgentDto>` — bare agents only. `null` **clears** the stored name, which is the only way back to a name that follows `AGENT.md` |
| `local-agent:set-runtime` | invoke | `({agentId, runtime: LocalAgentRuntimeInput}) → LocalAgentOutcome<LocalAgentDto>` — bare agents only; a kit agent is `invalid_input` and told to save it in its manifest. **No stamp**, because the write touches no file in the folder. Codes: `not_found`, `invalid_input`, `turn_in_progress` |
| `local-agent:root-restore-hidden` | invoke | `(rootId) → { restored: number }` — through `requireNamedRoot`, so a missing id refuses instead of defaulting to the home and creating it |
| `local-agent:delete` | invoke | `(DeleteLocalAgentInput) → LocalAgentOutcome<DeleteLocalAgentResult>` — **signature changed**: was `(agentId)` |

`:folder-add`, `:rename` and `:set-runtime` return outcomes because their failure codes drive renderer behaviour: `invalid_path` (a stale pick), `invalid_input` (nothing ticked on a first adopt, or a kit agent) and `turn_in_progress` (an agent this save would remove is mid-turn) are all explained in place and recovered from, not reasons to close the dialog. See [the outcome convention](agents_tab_tech.md#why-the-outcome-is-unwrapped-in-the-renderer).

`:folder-add`, `:rename`, `:set-runtime` and `:root-restore-hidden` all call `engineManager.applyConfigChange` on success — the engine's config lists every folder agent, its keys carry the agent's name, and the credential and model each one runs on are in it, so one more, one fewer or one changed is a change.

The git channels are in [Agents Folder Updates](folder_updates.md).

## Services & Key Methods

### `src/main/services/localAgents/externalScan.ts`

- `discoverBareAgents(rootPath, maxDepth?, {withNames?})` → `{found: DiscoveredFolder[]; truncated: boolean}`. `withNames: false` is for the callers that only **count** — `countBareAgents` runs on every `local-agent:list`, and reading each folder's `AGENT.md` head plus a `README.md` probe there would put one file read per agent on the main thread on every watcher push
- `readBareAgentName(dir)` — the first markdown H1 in the head of `AGENT.md` (first 4 096 bytes), rejected if longer than 80 characters (that is a sentence, not a title), else the folder's basename. Never throws

### `src/main/services/localAgents/scannerService.ts`

- `scanBareAgentFolder(agentDir, root, relPath)` → `LocalAgentDto`. Reads `AGENT.md` and its stamp, `README.md`'s stamp, and the bare state; `manifest`, `credentials`, `commands` and `publications` come back empty, and `runtime` is the state's — the one DTO field a bare folder fills from outside itself, in the same shape a manifest's block has so nothing downstream branches. Name precedence: `desktop.displayName` → the `AGENT.md` heading → the folder name
- `scanExternalRoot(userId, root)` — walks, drops hidden folders **before** the index is built (counting them into `hiddenCount` as it goes), and calls the same `replaceFolderIndex` a workshop scan does with an empty protected-paths list. An unreadable root returns `rootMissing` and is **not** cached, so it is retried rather than remembered
- `cachedScan(rootId, rootPath)` — the cached result, or null when there is none for the root's *current* path. Read-only and never triggers a scan, so `toDto` can ask on any render path without turning it into a walk
- `scanRoot` dispatches on `root.kind` in its first line

### `src/main/services/localAgents/localAgentService.ts`

- `scanFolder(root, agentDir)` — the single-folder read every caller goes through (`get`, `reindexAgent`, `renameAgent`, `validate`). A bare folder handed to `scanAgentFolder` comes back as `unreadableAgent` — a plausible-looking wrong answer, not a crash — and it would reach the page, the watcher's re-index and the engine's prompt assembly alike
- `pickedAgentFolder(userId, path)` — the preview. Overlap against `listRootRows` first — where the folder being exactly an **external** root sets `reselecting` and breaks instead of refusing — then "nothing found", then "all already added" (skipped while re-selecting, where it is the normal state). `alreadyAdded` is `agentRepo.listFolder(userId)` matched on `localPath`; `addedElsewhere` compares that row's `localRootId` against the root being re-selected, so it is `true` for every already-added row on a first adopt
- `addAgentFolder(userId, input)` — `addExternalRoot` (which returns the existing row for a path it already knows, so adopt and re-select are one call) → walk → **collect the removals and check every one's turn lock before writing anything** → `patch(hidden)` for each folder whose state would change → `markRootDirty` → `scanRoot` → `watchRoot` + `refreshRoot` → `reseedEngineSessions` for each agent put back. `preexisting` is what decides whether an empty selection is refused, whether the root may be dropped again, and whether an empty result is a success
- `bareName(agentDir, fallback)` (module-private) — the stored display name, else the walk's. The scanner's own precedence in the one other place that has to answer it: the picker lists agents the user may already have renamed
- `setBareRuntime(userId, agentId, runtime)` — refuses a non-external root, runs `runtimeService.toRuntimeRef` (and therefore `validate`), patches the state under the **turn lock** (the runner reads that file to find the agent's session), then `markRootDirty` + `scanFolder`, because nothing in the folder changed and the watcher will see nothing
- `renameAgent(userId, agentId, name: string | null)` — **not** routed through `updateField`: that channel's contract is a stamped write to a file in the folder, and a stamp for a file the write does not touch guards nothing. Takes the turn lock, patches `displayName` (`null` clears it), rescans the folder and calls `agentRepo.updateFolderIndex` in the same call so the sidebar does not wait for a rescan
- `reseedEngineSessions(userId, root, agentDir)` (module-private) — after a restore, re-upserts `a2a_sessions` from the agent's state file. Silent about a chat that has since gone
- `kindOf(root)` — `root.kind === 'external' ? 'bare' : 'kit'`. The one place a root becomes the value `desktopStateService` and `permissionGrantService` need

### `src/main/services/localAgents/desktopStateService.ts`

`desktopStatePath(agentDir, kind)`, `read/write/patch(agentDir, kind, …)`, and `forgetAt(path)`. `externalStateRoot()` resolves `app.getPath('userData')` inside a `try` with a `tmpdir()` fallback, because the module is imported by unit tests that never boot Electron.

`DesktopState.runtime` is an `AgentRuntimeRef` or `null`, and `coerceRuntime` keeps **only** `credential`, `model` and `complexity`. Narrower than the manifest's block on purpose: a manifest is round-tripped whole because another tool may have written keys we do not know about, while this file has exactly one writer — so keeping anything else would be how a stale `permissions` map reaches the engine long after the surface that wrote it is gone. An object with none of the three reads as `null`, so `{}` on disk and a missing key mean the same thing.

`forgetAt` takes a **path** because the caller must resolve it before `shell.trashItem` runs: the key is `realpathSync(agentDir)`, which throws once the folder is in the Trash and falls back to the raw path — a different digest under any symlinked component, which on macOS is every temp directory. `delete()` therefore computes `desktopStatePath(agentDir, 'bare')` as its first act.

## Renderer Components

| Component | Renders |
|---|---|
| `NewLocalAgentModal` (`choose` step) | Two cards — New agent / Add a folder — and a reserved error line |
| `NewLocalAgentModal` → `FolderStep` | One Name field for a single find on a **first** adopt, a scrolling checkbox list (max height, so the dialog cannot grow past the window) otherwise, the truncation notice, `Back` + `Add …`. On a re-selection: always the list whatever the count, no Name field, rows already in the app ticked and **editable**, rows added under another root ticked and locked, a line naming the registered root and a reserved single-line summary of what the button will do, and — when anything is leaving — an in-step confirmation naming them, with the checkboxes frozen while it is up. On success it selects the newly added agent and routes to `local-agent` before closing, and navigates nowhere when the save only removed agents |
| `BareNameCard` | The Name card. Saves on blur and Enter, adopts an outside change unless the field is dirty, Escape reverts |
| `BareReadmeCard` | The folder's `README.md` on **Overview**, read through `useLocalAgentDoc(id, 'bare_readme')` and rendered with `documentMarkdownComponents` + `remarkStripHtml`. Returns `null` for a doc whose `stamp` is `null` (main's "not there") or whose text is blank, so no card renders. No clamp and no expand control: the whole file, on a page that already scrolls. Its reveal calls `useOpenAgentPath` with `README.md` |
| `RuntimePanel` | The same panel a kit agent gets — see [Agents Tab — Technical Details](agents_tab_tech.md#renderer-components). For a bare agent it saves through `useSetBareAgentRuntime`, is editable with no stamp (`canEdit` is `true` on `kind === 'bare'`), never shows the stale-manifest refusal, drops the "models can still be typed into `cinna-agent.json`" half of the registry-failure message, and adds one static note saying the choice is kept in Cinna and a folder that moves starts over on the default |
| `AgentActionsMenu` → delete dialog | Two radios for a bare agent (recoverable one first and selected), the kit paragraph otherwise; the confirm button's label follows the choice |
| `FolderTab` | For a bare agent: the folder's own two files, no `Kit` row, a positional-identity warning, no Credentials or Published card, and a Runs card that names no file. Infos render for **every** kind of agent |
| `AgentsRootGit` | See [Agents Folder Updates](folder_updates.md) |

`LocalAgentPage` filters `TABS` for a bare agent and falls back to Overview **for the render only** when the remembered tab is Commands — `setTab` is untouched, so returning to a kit agent returns to Commands.

### The watcher's push names no agent for a bare edit

`classifyExternalEvent` returns `root` for an `AGENT.md` or a `README.md` basename, and a root rescan broadcasts `agentId: null` — so the two files a bare agent's page is a viewer over are precisely the ones whose edits arrive unattributed. Keyed invalidation therefore missed the case the watcher exists for: the user rewrites one of them in their editor, comes back to the page, and the card still shows what it read on mount, with `refetchOnWindowFocus` off (`src/renderer/src/App.tsx`) and nothing else to correct it.

`useLocalAgentWatch` now invalidates the `['local-agent']` and `['local-agent-doc']` **prefixes** on a push that names no agent, alongside the list keys every push already invalidated. Prefixes rather than the whole cache: what an open page holds is one agent and the one document on screen, so this refetches those and not a list it has just refetched by other means. A push that *does* name an agent keeps the narrower keyed invalidation it always had. The branch is not bare-only — any whole-root rescan takes it — but a bare agent is the only shape whose own document edits classify that way.

## Configuration

No settings. `BARE_AGENT_MAX_DEPTH` (2) and `MAX_DISCOVERED_AGENTS` (200) are constants, not preferences: both are guards against a folder that is not what the user thought, and a user-tunable depth would only make the picker's output harder to predict.

## Security

- `:folder-pick` opens the dialog **in main** and `:folder-add` accepts only the path that dialog returned. The `pendingPick` record compares the user id as well as the path — folder agents resolve the same settings scope today, and this is the cheap half of not having to remember that when they do not
- Every adopted path goes through `assertUsableRoot` and the same overlap refusal as `addRoot`. Overlap matters *more* for an external root, not less: it is by definition somewhere outside the agents home, so it is the one a user is most likely to point at a parent of
- The bare state file lives under `<userData>` with the agent token in it, exactly as a kit folder's does; `summarize()` still reports presence only
- `:set-runtime` runs `runtimeService.validate`, the **same** check the manifest writer runs, so a key-shaped `credential` is refused here too. A bare agent's runtime never leaves the machine, but a pasted API key does not become safe by landing in `userData` rather than in a file the user commits
- `bare_prompt` writes are refused for a non-external root, rather than silently creating a second prompt file beside `docs/WORKFLOW_PROMPT.md` — two files claiming to be the system prompt, only one of which the engine reads, is the worst outcome available <!-- nocheck -->
- `PromptDocCard`'s `toUpdate` **throws** for `bare_readme` instead of falling through to `bare_prompt`. It is unreachable — the README is not one of this card's documents at all any more; it is read-only on Overview, in `BareReadmeCard`, with no textarea behind it — and the fall-through would have written the README's text over the agent's whole system prompt. (Main would refuse the write on the stamp, the two files' stamps differing, but "your save was refused" is not the message that deserves.)

## Testing

- `src/main/services/localAgents/externalScan.test.ts` — the walk: depth 0 and depth 2, an agent folder not descended into, dot-directories and `node_modules` skipped, symlinked directories followed, an unreadable subdirectory ignored, the heading-vs-folder-name rule, and the cap
- `src/main/services/localAgents/desktopStateService.test.ts` — the two locations, that the location is the **caller's** and never a probe of the folder, two folders getting two files, a folder that gains a manifest keeping the state it had, `forgetAt` removing the state of an agent whose folder is already gone (the case a folder-derived key got wrong) while staying silent about a file that is not there, and `coerceRuntime` keeping only the three keys a picker can set while reading a runtime that names none as no choice at all
- `src/main/services/localAgents/scannerService.test.ts` (`external roots`) — every `AGENT.md` folder indexed two levels down, a bare folder never routed through the kit scan, the name precedence, hidden dropped and restored, a folder that loses its `AGENT.md` ceasing to be an agent, an empty one warning rather than erroring, an unavailable root leaving the index untouched, and a rebuild from an empty index
- `src/main/services/localAgents/localAgentService.test.ts` (`adopting an existing folder`, `removing a bare agent`) — the preview registering nothing, each refusal, a stale pick refused, a folder that has gone between preview and confirm, unticked folders hidden without a write into the folder, a root counted the same cached or cold, rename, **clearing** a name back to the heading, restore, a restored agent's engine sessions coming back with it, trashing taking the state file with it, and `trashFolder: false` refused for a kit agent. Re-selection has its own set: re-picking offering the agents again ticked as they stand, adding the one left out the first time while keeping the one already there, unticking taking an agent out and leaving the folder alone, a registered root **kept** when the folders ticked in a re-pick have gone, the user's own name surviving an agent being put back, engine sessions coming back with it, **nothing at all changed when one of the agents it would remove is busy**, emptying the list on purpose without dropping the root, an empty selection still refused on a first adopt, and a folder that merely overlaps a root still refused. Runtime: a bare agent's kept out of its folder and surviving a rescan, a model-and-tier pair refused wherever it is stored, and a kit agent refused this path
- `src/main/services/localAgents/promptAssembly.test.ts` (`assembleBareAgentPrompt`) — `AGENT.md` and nothing else in the folder, `README.md` absent, comments stripped, the empty-file stand-in, the Builder line, and **no rule stated about a file a bare folder does not have**
- `src/main/services/localAgents/watcherService.test.ts` (`classifyExternalEvent`, `externalFallbackDirs`) — the two files acted on, an ordinary file ignored at any depth in reach, a directory acted on, a removed path rescanning, dot-entries and out-of-reach paths ignored; and the fallback watching each agent folder and its holder while **never** going above the root
- `src/main/services/localAgents/agentsHomeService.test.ts` (`requireNamedRoot`) — a missing, empty or non-string id refused rather than resolved to the home, and the home not created as a side effect of asking
- `src/main/engine/configGenerator.test.ts` — `AGENT.md` resolving to `ask` under both `edit` and `write`
- `src/renderer/src/components/agents/local/FolderTab.test.tsx` — the folder's own two files, a manifest-less folder never reported as having an old one, the kit-only cards dropped, where the run state lives, and infos rendering at all
- `src/renderer/src/components/agents/local/BareReadmeCard.test.tsx` — the README rendered rather than shown as its source, its headings starting below the page's, raw HTML and comments hidden while a fenced block keeps its markup, an image as its alt text, the reveal naming the file, **nothing rendered at all** for a folder with no README, and the whole file with no expand control
- `src/renderer/src/components/agents/local/LocalAgentPage.test.tsx` (bare layout) — the README card on Overview and Prompts left to `AGENT.md`; the mutation it exists to catch is moving the card back under the Prompts branch
- `src/renderer/src/components/settings/AgentsRootGit.test.tsx` — the repository named when it is above the folder and not when it is the folder, nothing rendered for a non-repository, the block reserved while the answer is in flight, refusals blaming the repository, and Update and Check each hidden where they could only refuse
- `src/renderer/src/components/agents/local/NewLocalAgentModal.test.tsx`, `AgentActionsMenu.test.tsx` — the choice step, the folder step's two shapes, and the remove dialog's two options. Re-selection: opening on what is in the app and being able to change it, adding with no confirmation when nothing is being removed, an empty selection allowed rather than the button disabled in silence, no navigation when a save only removed agents, and a row added under another agents folder staying locked
- `src/renderer/src/components/agents/local/RuntimePanel.test.tsx` (`a bare agent`) — editing its runtime with no stamp to guard the write, opening on the runtime it was given exactly as a manifest one does, saying where the choice is kept and claiming no more than that, and never claiming the manifest went stale
- `e2e/specs/bare-agent.spec.ts` — the whole flow in the real app, with the folder tree snapshotted before and after: the only assertion that can witness "nothing was written into the user's folder". Also re-picking an adopted folder — the agents re-selected, the confirmation naming what leaves the list — and a bare agent's credential choice being saved in Cinna, surviving a restart and never landing in the folder. See [E2E Testing](../../development/e2e/e2e.md)

`discoverBareAgents`'s cap is asserted through the clamped `limit` seam — both that the report is made and that the seam can only narrow it, never raise it.
