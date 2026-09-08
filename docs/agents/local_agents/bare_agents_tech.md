# Bare Agents & External Roots — Technical Details

Business logic and the reasoning behind every rule: [Bare Agents & External Roots](bare_agents.md).

## File Locations

### Shared

- `src/shared/localAgents.ts` — `BARE_AGENT_PROMPT_FILE` (`AGENT.md`, with the note on why `AGENTS.md` is not accepted and what widening it would require), `BARE_AGENT_README_FILE` (`README.md`), `BARE_AGENT_MAX_DEPTH` (2), `LocalAgentKind`, `AgentRootKind`, `externalFolderAgentId()`, `LocalAgentDocKind`, `LOCAL_AGENT_DOC_PATHS`, `DiscoveredBareAgent`, `PickAgentFolderResult` (with `truncated`), `AddAgentFolderInput`, `AddAgentFolderResult`, `DeleteLocalAgentInput`, the `kind` / `hiddenAgentCount` / `truncated` / `isGitRepo` fields of `AgentRootDto`, and the `bare_prompt` member of `LocalAgentFieldUpdate`

### Main process — services (`src/main/services/localAgents/`)

- `externalScan.ts` — the walk. `isBareAgentDir()`, `readBareAgentName()`, `discoverBareAgents()` (with the clamped, test-only `limit`), `MAX_DISCOVERED_AGENTS` (200), and the `SKIP_DIRS` set
- `scannerService.ts` — `scanBareAgentFolder()`, `scanExternalRoot()`, `cachedScan()`, the `hiddenCount` / `truncated` fields of `ScanRootResult`, and the private `bareValidation()`
- `localAgentService.ts` — `pickedAgentFolder()`, `addAgentFolder()`, `renameAgent()`, `restoreHiddenAgents()`, `scanFolder()`, `kindOf()`, the module-private `reseedEngineSessions()`, the module-level `pendingPick`, and the `bare` / `trashFolder` branches of `delete()`
- `agentsHomeService.ts` — `addExternalRoot()`, `requireNamedRoot()`, `countBareAgents()` (the cold-path fallback only), and the `kind` / `hiddenAgentCount` / `truncated` / `isGitRepo` fields of `toDto()`
- `desktopStateService.ts` — `desktopStatePath(agentDir, kind)`, `forgetAt(path)`, the `displayName` and `hidden` fields of `DesktopState`, and `externalStateRoot()`
- `permissionGrantService.ts` — every method takes a `LocalAgentKind` second argument, for the same reason
- `promptAssembly.ts` — `assembleBareAgentPrompt()` and the private `bareDesktopContextSection()`
- `watcherService.ts` — `classifyExternalEvent()` (which stats the path), `externalFallbackDirs()`, `classifierFor()`, and the external branches of `armWatchers()` / `armFallbackWatchers()`

### Main process — elsewhere

- `src/main/db/schema.ts`, `src/main/db/agentRoots.ts` — the `kind` column and `CreateAgentRootInput.kind`
- `src/main/db/migrations/agent-roots.ts` — `ALTER TABLE agent_roots ADD COLUMN kind`
- `src/main/engine/engineConfigSource.ts` — the one branch in `collectEngineAgents()`
- `src/main/engine/configGenerator.ts` — `AGENT.md` in `IDENTITY_FILES`, and the docstring recording why `README.md` is not there and what would change it
- `src/main/ipc/local_agent.ipc.ts` — the five new channels
- `src/main/services/agentTurn/index.ts`, `src/main/services/agentTurn/localAgentTurnRunner.ts` — `agentKind` threaded through `saveSession` and `isGranted`

### Preload

`src/preload/index.ts` — `window.api.localAgents.folderPick()`, `.folderAdd()`, `.rename()`, `.rootRestoreHidden()`; `.delete()` now takes `DeleteLocalAgentInput`

### Renderer

- `src/renderer/src/components/agents/local/NewLocalAgentModal.tsx` — the `choose` / `folder` steps and the `FolderStep` component
- `src/renderer/src/components/agents/local/BareAgentCards.tsx` — `BareNameCard`
- `src/renderer/src/components/agents/local/RuntimePanel.tsx` — `BareRuntimePanel`
- `src/renderer/src/components/agents/local/LocalAgentPage.tsx` — the tab filter and the per-kind card sets
- `src/renderer/src/components/agents/local/PromptDocCard.tsx`, `InlineFileEditor.tsx` — the `readOnly` path
- `src/renderer/src/components/agents/local/AgentActionsMenu.tsx` — the two-option remove dialog, its `aria-label` branching with its heading, and the copy that owns the `job_agents` cascade
- `src/renderer/src/components/agents/local/FolderTab.tsx` — `BARE_FILES`, the infos list, and the cards and rows that do not render for a bare agent
- `src/renderer/src/components/agents/local/ReadOnlyCards.tsx` — `RunsCard`'s file-less branch; `PermissionsCard.tsx` — the file-less card and the branched examples
- `src/renderer/src/components/agents/local/AgentCard.tsx` — `file` is optional, for the one card that names none
- `src/renderer/src/components/settings/LocalAgentsSettingsSection.tsx` — the `Added folder` badge, the read-only count line and the hidden-agents row
- `src/renderer/src/hooks/useLocalAgents.ts` — `usePickAgentFolder`, `useAddAgentFolder`, `useRenameLocalAgent`, `useRestoreHiddenAgents`

## Database Schema

`agent_roots.kind` — `TEXT NOT NULL DEFAULT 'workshop'`, added by `hasColumn`-guarded `ALTER TABLE` in `src/main/db/migrations/agent-roots.ts`. Values `'workshop'` | `'external'`. **The default is what makes it safe to add**: every root registered before external roots existed is a workshop, so there is no backfill and none is written.

No other schema change. A bare agent is an ordinary `agents` row (`source = 'folder'`, `protocol = 'local-folder'`) whose id happens to be positional, and `displayName` / `hidden` live in the state file, not in SQLite.

## IPC Channels

| Channel | Type | Signature |
|---|---|---|
| `local-agent:folder-pick` | invoke | `() → PickAgentFolderResult` — native `showOpenDialog` in main, then a read-only preview. **Takes no path**, and registers nothing |
| `local-agent:folder-add` | invoke | `(AddAgentFolderInput) → LocalAgentOutcome<AddAgentFolderResult>` — refuses a `path` that is not the one `:folder-pick` last returned, and refuses (`not_found`, dropping the root again) when the scan indexes nothing. Answers with the root **and** the adopted agent ids |
| `local-agent:rename` | invoke | `({agentId, name: string \| null}) → LocalAgentOutcome<LocalAgentDto>` — bare agents only. `null` **clears** the stored name, which is the only way back to a name that follows `AGENT.md` |
| `local-agent:root-restore-hidden` | invoke | `(rootId) → { restored: number }` — through `requireNamedRoot`, so a missing id refuses instead of defaulting to the home and creating it |
| `local-agent:delete` | invoke | `(DeleteLocalAgentInput) → LocalAgentOutcome<DeleteLocalAgentResult>` — **signature changed**: was `(agentId)` |

`:folder-add` and `:rename` return outcomes because their failure codes drive renderer behaviour: `invalid_path` (a stale pick) and `invalid_input` (nothing ticked, or a kit agent) are both explained in place and recovered from, not reasons to close the dialog. See [the outcome convention](agents_tab_tech.md#why-the-outcome-is-unwrapped-in-the-renderer).

`:folder-add`, `:rename` and `:root-restore-hidden` all call `engineManager.applyConfigChange` on success — the engine's config lists every folder agent, its keys carry the agent's name, and one more or one fewer is a change.

The git channels are in [Agents Folder Updates](folder_updates.md).

## Services & Key Methods

### `src/main/services/localAgents/externalScan.ts`

- `discoverBareAgents(rootPath, maxDepth?, {withNames?})` → `{found: DiscoveredFolder[]; truncated: boolean}`. `withNames: false` is for the callers that only **count** — `countBareAgents` runs on every `local-agent:list`, and reading each folder's `AGENT.md` head plus a `README.md` probe there would put one file read per agent on the main thread on every watcher push
- `readBareAgentName(dir)` — the first markdown H1 in the head of `AGENT.md` (first 4 096 bytes), rejected if longer than 80 characters (that is a sentence, not a title), else the folder's basename. Never throws

### `src/main/services/localAgents/scannerService.ts`

- `scanBareAgentFolder(agentDir, root, relPath)` → `LocalAgentDto`. Reads `AGENT.md` and its stamp, `README.md`'s stamp, and the bare state; `manifest`, `credentials`, `commands` and `publications` come back empty and `runtime` is `null`. Name precedence: `desktop.displayName` → the `AGENT.md` heading → the folder name
- `scanExternalRoot(userId, root)` — walks, drops hidden folders **before** the index is built (counting them into `hiddenCount` as it goes), and calls the same `replaceFolderIndex` a workshop scan does with an empty protected-paths list. An unreadable root returns `rootMissing` and is **not** cached, so it is retried rather than remembered
- `cachedScan(rootId, rootPath)` — the cached result, or null when there is none for the root's *current* path. Read-only and never triggers a scan, so `toDto` can ask on any render path without turning it into a walk
- `scanRoot` dispatches on `root.kind` in its first line

### `src/main/services/localAgents/localAgentService.ts`

- `scanFolder(root, agentDir)` — the single-folder read every caller goes through (`get`, `reindexAgent`, `renameAgent`, `validate`). A bare folder handed to `scanAgentFolder` comes back as `unreadableAgent` — a plausible-looking wrong answer, not a crash — and it would reach the page, the watcher's re-index and the engine's prompt assembly alike
- `pickedAgentFolder(userId, path)` — the preview. Overlap against `listRootRows` first, then "nothing found", then "all already added"; `alreadyAdded` is `agentRepo.listFolder(userId)` matched on `localPath`
- `addAgentFolder(userId, input)` — `addExternalRoot` → walk → `patch(hidden)` per folder → `markRootDirty` → `scanRoot` → `watchRoot`
- `renameAgent(userId, agentId, name: string | null)` — **not** routed through `updateField`: that channel's contract is a stamped write to a file in the folder, and a stamp for a file the write does not touch guards nothing. Takes the turn lock, patches `displayName` (`null` clears it), rescans the folder and calls `agentRepo.updateFolderIndex` in the same call so the sidebar does not wait for a rescan
- `reseedEngineSessions(userId, root, agentDir)` (module-private) — after a restore, re-upserts `a2a_sessions` from the agent's state file. Silent about a chat that has since gone
- `kindOf(root)` — `root.kind === 'external' ? 'bare' : 'kit'`. The one place a root becomes the value `desktopStateService` and `permissionGrantService` need

### `src/main/services/localAgents/desktopStateService.ts`

`desktopStatePath(agentDir, kind)`, `read/write/patch(agentDir, kind, …)`, and `forgetAt(path)`. `externalStateRoot()` resolves `app.getPath('userData')` inside a `try` with a `tmpdir()` fallback, because the module is imported by unit tests that never boot Electron.

`forgetAt` takes a **path** because the caller must resolve it before `shell.trashItem` runs: the key is `realpathSync(agentDir)`, which throws once the folder is in the Trash and falls back to the raw path — a different digest under any symlinked component, which on macOS is every temp directory. `delete()` therefore computes `desktopStatePath(agentDir, 'bare')` as its first act.

## Renderer Components

| Component | Renders |
|---|---|
| `NewLocalAgentModal` (`choose` step) | Two cards — New agent / Add a folder — and a reserved error line |
| `NewLocalAgentModal` → `FolderStep` | One Name field for a single find, a scrolling checkbox list (max height, so the dialog cannot grow past the window) for several, the truncation notice, `Back` + `Add …`. On success it selects the first adopted agent and routes to `local-agent` before closing |
| `BareNameCard` | The Name card. Saves on blur and Enter, adopts an outside change unless the field is dirty, Escape reverts |
| `BareRuntimePanel` | Read-only "Runs with": the resolved default credential and model, the engine status, one reserved status line, and one sentence saying why there is nothing to pick |
| `AgentActionsMenu` → delete dialog | Two radios for a bare agent (recoverable one first and selected), the kit paragraph otherwise; the confirm button's label follows the choice |
| `FolderTab` | For a bare agent: the folder's own two files, no `Kit` row, a positional-identity warning, no Credentials or Published card, and a Runs card that names no file. Infos render for **every** kind of agent |
| `AgentsRootGit` | See [Agents Folder Updates](folder_updates.md) |

`LocalAgentPage` filters `TABS` for a bare agent and falls back to Overview **for the render only** when the remembered tab is Commands — `setTab` is untouched, so returning to a kit agent returns to Commands.

## Configuration

No settings. `BARE_AGENT_MAX_DEPTH` (2) and `MAX_DISCOVERED_AGENTS` (200) are constants, not preferences: both are guards against a folder that is not what the user thought, and a user-tunable depth would only make the picker's output harder to predict.

## Security

- `:folder-pick` opens the dialog **in main** and `:folder-add` accepts only the path that dialog returned. The `pendingPick` record compares the user id as well as the path — folder agents resolve the same settings scope today, and this is the cheap half of not having to remember that when they do not
- Every adopted path goes through `assertUsableRoot` and the same overlap refusal as `addRoot`. Overlap matters *more* for an external root, not less: it is by definition somewhere outside the agents home, so it is the one a user is most likely to point at a parent of
- The bare state file lives under `<userData>` with the agent token in it, exactly as a kit folder's does; `summarize()` still reports presence only
- `bare_prompt` writes are refused for a non-external root, rather than silently creating a second prompt file beside `docs/WORKFLOW_PROMPT.md` — two files claiming to be the system prompt, only one of which the engine reads, is the worst outcome available <!-- nocheck -->
- `PromptDocCard`'s `toUpdate` **throws** for `bare_readme` instead of falling through to `bare_prompt`. It is unreachable (the card is only ever rendered read-only), and the fall-through would have written the README's text over the agent's whole system prompt

## Testing

- `src/main/services/localAgents/externalScan.test.ts` — the walk: depth 0 and depth 2, an agent folder not descended into, dot-directories and `node_modules` skipped, symlinked directories followed, an unreadable subdirectory ignored, the heading-vs-folder-name rule, and the cap
- `src/main/services/localAgents/desktopStateService.test.ts` — the two locations, that the location is the **caller's** and never a probe of the folder, two folders getting two files, a folder that gains a manifest keeping the state it had, and `forgetAt` removing the state of an agent whose folder is already gone (the case a folder-derived key got wrong) while staying silent about a file that is not there
- `src/main/services/localAgents/scannerService.test.ts` (`external roots`) — every `AGENT.md` folder indexed two levels down, a bare folder never routed through the kit scan, the name precedence, hidden dropped and restored, a folder that loses its `AGENT.md` ceasing to be an agent, an empty one warning rather than erroring, an unavailable root leaving the index untouched, and a rebuild from an empty index
- `src/main/services/localAgents/localAgentService.test.ts` (`adopting an existing folder`, `removing a bare agent`) — the preview registering nothing, each refusal, a stale pick refused, a folder that has gone between preview and confirm, unticked folders hidden without a write into the folder, a root counted the same cached or cold, rename, **clearing** a name back to the heading, restore, a restored agent's engine sessions coming back with it, trashing taking the state file with it, and `trashFolder: false` refused for a kit agent
- `src/main/services/localAgents/promptAssembly.test.ts` (`assembleBareAgentPrompt`) — `AGENT.md` and nothing else in the folder, `README.md` absent, comments stripped, the empty-file stand-in, the Builder line, and **no rule stated about a file a bare folder does not have**
- `src/main/services/localAgents/watcherService.test.ts` (`classifyExternalEvent`, `externalFallbackDirs`) — the two files acted on, an ordinary file ignored at any depth in reach, a directory acted on, a removed path rescanning, dot-entries and out-of-reach paths ignored; and the fallback watching each agent folder and its holder while **never** going above the root
- `src/main/services/localAgents/agentsHomeService.test.ts` (`requireNamedRoot`) — a missing, empty or non-string id refused rather than resolved to the home, and the home not created as a side effect of asking
- `src/main/engine/configGenerator.test.ts` — `AGENT.md` resolving to `ask` under both `edit` and `write`
- `src/renderer/src/components/agents/local/FolderTab.test.tsx` — the folder's own two files, a manifest-less folder never reported as having an old one, the kit-only cards dropped, where the run state lives, and infos rendering at all
- `src/renderer/src/components/settings/AgentsRootGit.test.tsx` — the repository named when it is above the folder and not when it is the folder, nothing rendered for a non-repository, the block reserved while the answer is in flight, refusals blaming the repository, and Update and Check each hidden where they could only refuse
- `src/renderer/src/components/agents/local/NewLocalAgentModal.test.tsx`, `AgentActionsMenu.test.tsx` — the choice step, the folder step's two shapes, and the remove dialog's two options
- `e2e/specs/bare-agent.spec.ts` — the whole flow in the real app, with the folder tree snapshotted before and after: the only assertion that can witness "nothing was written into the user's folder". See [E2E Testing](../../development/e2e/e2e.md)

`discoverBareAgents`'s cap is asserted through the clamped `limit` seam — both that the report is made and that the seam can only narrow it, never raise it.
