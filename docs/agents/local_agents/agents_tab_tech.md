# Agents Tab & Agent Page — Technical Details

Implementation reference for [Agents Tab & Agent Page](agents_tab.md). Path convention as in that doc: `src/...` and `docs/...` are this repository; `Local/<slug>/...`, `cinna-agent.json`, `credentials/.env` and `app-data/...` are inside an agent folder.

## File Locations

### Shared
- `src/shared/localAgents.ts` — the Phase 3 additions to the wire contract:
  - `LocalAgentIdentity` (`'manifest' | 'legacy' | 'unresolved'`), `legacyFolderAgentId(rootId, folderName)`, `duplicateFolderAgentId(rootId, folderName)`
  - `LocalAgentOutcome<T>`, `localAgentFailure(err)`, `unwrapLocalAgentOutcome(outcome)`
  - `BLOCKED_WRITE_ERROR_CODE` (`turn_in_progress`) and `isBlockedWriteError(error)`, beside the existing `STALE_WRITE_ERROR_CODES` / `isStaleWriteError`
  - `LocalAgentDocDto`, `ReadLocalAgentDocInput`, `LOCAL_AGENT_PROMPT_PATHS`, `fieldFilePath(update)`
  - `DraftLocalAgentResult`, `LocalAgentDraftParts`
  - `OpenLocalAgentCredentialsResult` (`{created, revealed}`) — what `local-agent:open-credentials` answers with: whether the file had to be seeded, and whether nothing on this machine would open it so it was revealed in the file manager instead
  - The `{ field: 'stamp_identity' }` variant of `LocalAgentFieldUpdate` — value-less by design: the UUID is minted in main, and a `value` here would be an id-setter any other card could reach
  - `describeAgentSlug(name)` / `AgentSlugCheck` / `AgentSlugProblem`, sharing `reduceToSlugCharacters` with `slugifyAgentName`
  - `CreateLocalAgentInput.description` is **optional** (absent, not blank — the form omits the key); `DeleteLocalAgentResult` (`{agentId, trashed: true}`) is what `local-agent:delete` returns on success
  - `describedAs({name, description})` — `''` when the description is only the name repeated. Shared because it is applied on **both** sides: at index time (`scannerService.scanRoot` and `localAgentService.reindexAgent` write `description: describedAs(dto) || null` into the `agents` row) and at render time (the page header, the sidebar sub-line via `src/renderer/src/utils/localAgents.ts`, which re-exports it)
- `src/shared/localTools.ts` — `LOCAL_TOOL_IDS` / `isLocalToolId`, `LAUNCHABLE_TOOL_KINDS`, `actionForTool`: the default-tool setting's allowlist and the action a tool is launched with. Owned by [Open in Tools — Technical Details](open_in_tools_tech.md)
- `src/shared/appSettings.ts` — `localAgentsDefaultTool`, `localAgentsAutoOpen`
- `src/shared/localAgents.test.ts` — the id prefix round-trip. The counterparty predicate this file also exported, and the suite pinning it, were removed in **Phase 7c** (not Phase 6, which shipped the runner without opening the pickers); the claim they pinned is now pinned in reverse, in the two pickers themselves

### Main process
- `src/main/ipc/local_agent.ipc.ts` — all handlers; the module-private `withCode()` wrapper that converts a thrown `DomainError` into a `LocalAgentOutcome` failure, and its `withCodeAsync()` twin for the one handler that awaits (`local-agent:delete`, because `shell.trashItem` is async); the one-time `localAgentService.configure()` composition-root call
- `src/main/services/appSettingsService.ts` — the `localAgentsDefaultTool` value check (`isLocalToolId` or empty); `src/main/db/appSettings.ts` — the two new defaults (`''`, `false`)
- `src/main/services/appSettingsService.test.ts` — a known id and empty accepted, an unknown string (`vim`) refused, the auto-open flag round-trips
- `src/main/ipc/localAgentOutcome.test.ts` — drives `localAgentFailure` and `unwrapLocalAgentOutcome` (the **real** functions each side calls) against each other: the code survives, blocked is told apart from stale, main's own sentence arrives without the `invoking remote method` wrapper, success passes through
- `src/main/services/localAgents/draftService.ts` — `localAgentDraftService.draft()` / `.draftOnce()` / `.runDraftCall()` / `.saveField()`, plus the exported pure helpers `parseDraftMeta()` and `isUntouchedWorkflowPrompt()`
- `src/main/services/localAgents/draftService.test.ts` — the metadata parse (including a model that ignored the format), the happy path, one draft per agent however many callers ask at once, the no-credential skip, the fill-a-blank-only rule for each of the three fields, a document that changed while the model was thinking, an unreachable model, and an already-complete agent
- `src/main/services/localAgents/localAgentService.ts` — the `stamp_identity` case of `updateField()`; `readDoc()`, which returns text and stamp from one read; `create()`'s name-as-description fallback; `delete()`, trash-then-rescan under the turn lock; `openCredentials()` with its module-private `credentialsSeed()` and `openInTextEditor()`
- `src/main/services/localAgents/localAgentService.test.ts` — `create` from a name alone (and from a blank description), and the `delete` suite: trashed and pruned, refused mid-turn with nothing touched, lock released and row kept when the trash call fails, a non-folder id refused with `not_found`. `shell.trashItem` is a fake whose default really removes the directory, so the prune has something to notice. The `openCredentials` suite fakes `shell.openPath` / `showItemInFolder` too: seeded from the declared names and opened (not its folder), the seed leaving the slot **unsatisfied**, an existing file opened without a byte changing, and the reveal fallback — taken with `process.platform` pinned to `linux`, since a real `open -t` would launch the developer's editor out of the test run
- `src/main/services/localAgents/scannerService.ts` — the identity union (`unreadableAgent()` → `unresolved`; no manifest `id` → `legacy`), and the duplicate-id branch of `scanRoot()`
- `src/main/services/localAgents/editorRoundTrip.test.ts` — the main half of the save guard
- `src/main/db/agents.ts` — `agentRepo.rekeyFolderRow(userId, oldId, newId)` and `RekeyFolderRowResult`
- `src/main/db/agents.test.ts` — the re-key transaction: rows moved, every dependent table repointed, no-op on a clash

### Preload
- `src/preload/index.ts` — `window.api.localAgents.*`. Phase 3 adds `draft`, `readDoc`, `openCredentials`, and changes `get` / `updateField` to resolve a `LocalAgentOutcome<T>` rather than reject; `delete` resolves one too. **The bridge does not unwrap** — see [Why the outcome is unwrapped in the renderer](#why-the-outcome-is-unwrapped-in-the-renderer). Typed by inference; there is no hand-written interface

### Renderer — hooks, store, utils
- `src/renderer/src/hooks/useLocalAgents.ts` — every query and mutation, plus `useAgentFileEditor`; `useDeleteLocalAgent(options?)` unwraps the outcome, invalidates the list (never the page's own entry) and runs an optional **hook-level** `onSuccess`; the module-private `AGENTS_KEY` (`['agents']`, `useAgents`' key behind the `@` / `[+]` / Jobs pickers) is invalidated on create, stamp identity, delete and every `local-agent:changed` push
- `src/renderer/src/hooks/useLocalTools.ts` — `useLocalTools`, `useAvailableTools(kind)`, `useRefreshLocalTools`, `useOpenIn`, and the default-tool pair `useDefaultTool()` / `useSetDefaultTool()` (see [Open in Tools — Technical Details](open_in_tools_tech.md))
- `src/renderer/src/utils/localAgents.ts` — the pure layer: `readinessLabel`, `agentSubline`, `describedAs`, `groupAgentsByRoot`, `launchableTools`, `resolveDefaultTool`, `canDraftWithDefaultMode`, `parseExamplePrompts` / `formatExamplePrompts`, and the `FileEditorState` machine. `suggestAgentName` was removed with the sentence it suggested from
- `src/renderer/src/utils/localAgents.test.ts` — 40+ cases over all of the above, including every editor transition, the name-repeated-as-description blank, and the default tool (assistants before editors, never a runtime; resolved only against what is installed)
- `src/renderer/src/stores/ui.store.ts` — `ActiveView` gains `'local-agent'`, `SidebarTab` gains `'agents'`, `SettingsMenu` gains `'local-agents'`; fields `activeLocalAgentId` and `pendingDraftAgentId` with their setters

### Renderer — components
- `src/renderer/src/components/agents/local/LocalAgentsList.tsx` — the sidebar list; `AgentRow` and `readinessColor` are module-private
- `src/renderer/src/components/agents/local/LocalAgentPage.tsx` — the page shell: not-found / not-indexed states, the draft-on-arrival effect, the header (readiness dot, name, `describedAs` description or the "No description yet" nudge, path-as-reveal), the three header controls, `RuntimePanel`, `ReadinessStrip`, the `AgentPageTab` tab strip and which cards each tab mounts
- `src/renderer/src/components/agents/local/LocalAgentPage.test.tsx` — Start chat, the above-the-fold order, the tab switch, the description-or-nudge header
- `src/renderer/src/components/agents/local/OpenInMenu.tsx` — the split button: primary launches the default tool, chevron opens the menu (assistants, editors, Terminal, Reveal); a menu pick rewrites the default. Exports `MENU_ITEM` / `MENU_SURFACE`, which `AgentActionsMenu` shares
- `src/renderer/src/components/agents/local/OpenInMenu.test.tsx` — one-click default without rewriting it, a menu pick becomes the default with the editor action for an editor, the "Open in…" fallback, Terminal/Reveal never become the default
- `src/renderer/src/components/agents/local/AgentActionsMenu.tsx` — the ⋯ menu (Rescan folder, Reveal folder, Open terminal here, Stamp identity for a legacy folder with a readable manifest, Delete agent…) and the module-private `DeleteAgentDialog`. **The menu owns `useDeleteLocalAgent`** and hands the mutation to the dialog as a prop; the selection is cleared in the hook-level `onSuccess`, which survives the dialog's unmount where a mutate-level callback would not
- `src/renderer/src/components/agents/local/AgentActionsMenu.test.tsx` — confirm-then-delete clears the selection, a mid-turn refusal reads as busy and keeps the dialog open, cancel deletes nothing; Stamp identity offered only to a legacy folder
- `src/renderer/src/components/agents/local/RuntimePanel.tsx` — "Runs with": the credential picker, the work-complexity / model picker with its **Advanced** checkbox, the one reserved status line, `EngineStatus`, `SecretsLine` (declared slots, names only, and the link that opens `credentials/.env` itself through `local-agent:open-credentials`); the replacement for `RuntimeCard.tsx`. The credential/model pairing rule it shares with the main process is `src/shared/runtimeDefaults.ts`; the tier↔model classification is `src/shared/modelFamilies.ts`. See [The Local Engine — Technical Details](engine_tech.md)
- `src/renderer/src/components/agents/local/FolderTab.tsx` — `ValidationCard` (findings in full), `IdentityCard` (manifest id, folder, kit/contract version), `FilesCard` (every file the page reads, each a reveal), then `CredentialsCard`, `PublishedCard`, `RunsCard`
- `src/renderer/src/components/agents/local/AgentCard.tsx` — the shell every card shares; takes the agent-relative `file` it renders, an optional reveal, and an optional `revealTitle` for the card whose reveal lands somewhere other than the file it names
- `src/renderer/src/components/agents/local/ReadinessStrip.test.tsx` — nothing for a ready folder; one banner for a legacy folder whose only error is the missing id; the readiness line kept when a second problem exists
- `src/renderer/src/hooks/useLocalTools.test.tsx` — `useSetDefaultTool`: a tool id leaves auto-open alone, `null` also writes `localAgentsAutoOpen: false`
- `src/renderer/src/components/agents/local/ReadinessStrip.tsx` — returns `null` for an `ok`, non-legacy, non-drafting agent; otherwise the readiness sentence with a "N findings" link (`onShowDetails` → Folder tab), the legacy/stamp-identity notice, the drafting and draft-outcome notes
- `src/renderer/src/components/agents/local/ManifestCards.tsx` — `DescriptionCard`, `ExamplePromptsCard` (which owns two editors: prompts and router trigger) and the shared `useManifestSnapshot`
- `src/renderer/src/components/agents/local/PromptDocCard.tsx` — one of the three prompt documents, read through its own query
- `src/renderer/src/components/agents/local/ReadOnlyCards.tsx` — `CredentialsCard`, `CommandsCard`, `StatusCard`, `PublishedCard`, `RunsCard` (now mounted from three different tabs)
- `src/renderer/src/components/agents/local/InlineFileEditor.tsx` — the Notes inline-editor pattern plus the conflict banner, the blocked note and the error line
- `src/renderer/src/components/agents/local/NewLocalAgentModal.tsx` — the two-step create form: `{kind:'name'}` (name, path preview, More options) then `{kind:'tool'; agent}` ("Build it with…"), skipped when `autoOpen` and a default resolve. `launchTool` closes the modal in the open-in mutation's `onSuccess` only; its `onError` sets the step back to `tool` (which is how the auto-open path lands there) and shows the refusal
- `src/main/services/localAgents/scannerService.ts`, `localAgentService.ts:reindexAgent` — the index-time `describedAs(dto) || null` on the row's `description`
- `src/renderer/src/components/agents/local/NewLocalAgentModal.test.tsx` — name alone sends no description and queues no draft, Enter submits, a description under More options is sent and queues the draft, a picked tool launches and is remembered, auto-open skips the step, no name no create
- `src/renderer/src/components/settings/LocalAgentsSettingsSection.tsx` — roots, add/forget/reveal, the readiness list, detected tools, contract version, the **Open agents with** select and the auto-open checkbox

Deleted by the page redesign: `OpenInRow.tsx` (→ `OpenInMenu.tsx`) and `RuntimeCard.tsx` (→ `RuntimePanel.tsx`).

### Renderer — shell wiring
Adding the tab is four edits (renderer seam 10 of `plans/local-agents.md`), the settings section three:

- `src/renderer/src/stores/ui.store.ts` — the three unions plus two fields
- `src/renderer/src/components/layout/SidebarTabs.tsx` — a `TAB_ITEMS` entry and a `handleSwitchTab` branch (clears the selection, sets `'local-agent'`)
- `src/renderer/src/components/layout/Sidebar.tsx` — the `LocalAgentsList` branch in the tab body, and the `local-agents` entry in `defaultMenuItems` (**not** `PROFILE_SCOPE_TABS`)
- `src/renderer/src/components/layout/MainArea.tsx` — an early return for `activeView === 'local-agent'`
- `src/renderer/src/components/settings/SettingsPage.tsx` — a `sectionTitles` key and a render line
- `src/renderer/src/App.tsx` — `useLocalAgentWatch()` mounted once in `Shell`
- `src/renderer/src/components/chat/ChatInput.tsx`, `src/renderer/src/components/jobs/JobEditForm.tsx` — the two counterparty filters, `a.enabled` and nothing else

## IPC Channels

Phase 3 additions and changes. Every handler is activation-gated and scoped with `getSettingsScopeUserId()`.

| Channel | Signature | Notes |
|---|---|---|
| `local-agent:get` | `(agentId) → LocalAgentOutcome<LocalAgentDto>` | **Changed shape.** `not_found` is a routine destination |
| `local-agent:update-field` | `(UpdateLocalAgentFieldInput) → LocalAgentOutcome<LocalAgentDto>` | **Changed shape.** Three refusals, three behaviours |
| `local-agent:read-doc` | `(ReadLocalAgentDocInput) → LocalAgentDocDto` | Text and stamp from one read of one file |
| `local-agent:draft` | `(agentId) → DraftLocalAgentResult` | Async, up to ~90 s per call. Resolves `skipped` with no credential |
| `local-agent:delete` | `(agentId) → LocalAgentOutcome<DeleteLocalAgentResult>` | Trash the folder, rescan the root. Codes: `not_found`, `turn_in_progress`, `write_failed`. On success main also fires `engineManager.applyConfigChange` |
| `local-agent:open-credentials` | `(agentId) → OpenLocalAgentCredentialsResult` | **An id, never a path** — unlike `:open-path`, this handler *writes*, so the one file it can touch is fixed in main. Seeds `credentials/.env` when it is absent, then opens it |

Unchanged from Phase 2 and used here: `local-agent:list`, `:create` (whose input's `description` is now optional), `:rescan`, `:validate`, `:open-path`, `:roots-list`, `:root-add`, `:root-remove`, and the main → renderer push `local-agent:changed`. The Open-in menu, the ⋯ menu, the "Build it with…" step and the Settings tools card use `local-tools:list` / `:refresh` / `:open-in`; the default tool and auto-open flag go through the generic app-settings channel via `useAppSettings` / `useSetAppSetting`.

### Why the outcome is unwrapped in the renderer

Two boundaries drop non-standard error properties:

1. `ipcMain.handle` serialises a rejection as `{message, stack}` — `err.code`, attached by `src/main/ipc/_wrap.ts`, is gone
2. `contextBridge` clones whatever preload throws into the main world as a fresh `Error` — so rebuilding the error *in preload* puts it on the wrong side of the second boundary

So the failure travels as **data** all the way in, and `useLocalAgent` / `useUpdateLocalAgentField` / `useStampAgentIdentity` / `useDeleteLocalAgent` call `unwrapLocalAgentOutcome` inside their `queryFn`/`mutationFn`, where the thrown error stays put. Delete joined the set for one code: `turn_in_progress` is the refusal the dialog has to explain as *busy* rather than report as failure, and `isBlockedWriteError` can only tell it apart if the code arrives. `src/main/ipc/localAgentOutcome.test.ts` pins the contract: the property being restored is invisible at every call site (`isStaleWriteError` simply starts telling the truth), so nothing else would notice it breaking again.

The rest of the app uses the older convention — a **returned** `{success:false, code}` object that the renderer inspects and re-throws. Both are live; pick the outcome shape only when a code drives renderer behaviour.

## Services & Key Methods

### `src/main/services/localAgents/draftService.ts`
- `localAgentDraftService.draft(userId, agentId)` — the in-flight `Set` guard, then `draftOnce`
- `.draftOnce(userId, agentId)` — decides what is blank (`wantsWorkflow` / `wantsExamples` / `wantsTrigger`), resolves the adapter, **takes both stamps before any call**, runs at most two single-shots, writes each result through `saveField`, and reports partial success
- `.runDraftCall({resolved, systemPrompt, userText, label, maxOutputChars})` — one `aiFunctions.runSingleShot` with `AbortSignal.timeout(90_000)`; returns `null` instead of throwing
- `.saveField(userId, agentId, update, expectedStamp)` — one `localAgentService.updateField`; returns `null` on a stale-write refusal, which is logged and never retried
- `parseDraftMeta(raw)` — the line-based `TRIGGER:` / `PROMPT:` parser
- `isUntouchedWorkflowPrompt(contents)` — matches the scaffold template markers (`This file IS the agent.`, `<!-- first step -->`)
- Manifest stamp threading: each manifest write invalidates the stamp the next one needs, so `manifestStamp` is re-read from the agent returned by the previous write

### `src/main/services/localAgents/localAgentService.ts`
- `updateField()` case `stamp_identity` — refuses if `manifest.id` is already set; mints `randomUUID()`; also writes `contract_version` when absent (the validator reads "`schema_version`, no `contract_version`, no `id`" as the legacy shape, so writing `id` alone turns a warning into a missing-required-field **error**, and the contract's own migration note asks for both); writes through `writeIfUnchanged`; then calls `agentRepo.rekeyFolderRow` **before** anything rescans
- `readDoc()` — one prompt document, text and stamp from the same read
- `create()` — `optionalString(input.description) ?? name`: the kit schema requires a non-empty `description`, so an absent or blank one is replaced by the name rather than refused
- `delete(userId, agentId)` — `locate()` (a non-folder id is `not_found`), then `turnLock.acquire(agentId, 'delete')`; `await shell.trashItem(agentDir)` inside the lock, wrapped as `write_failed` on rejection; the lock is released in `finally`, **before** `scannerService.markRootDirty` + `scanRoot` + `watcherService.refreshRoot`. The row leaves through `replaceFolderIndex`'s prune — nothing here touches `agents` directly
- `openCredentials(userId, agentId)` — what the secrets line's "Add them in `credentials/.env`" runs. `mkdirSync` on `credentials/`, `resolveWithinRoot` on that folder, `writeFileSync(mode: 0o600, flag: 'wx')` when the file is absent, `resolveWithinRoot` again on the file, then `shell.openPath` with two fallbacks. Returns `{created, revealed}`. Four things in it are decisions rather than plumbing:
  - **The seed comments every declared name out.** `scannerService.readEnvKeys` matches the *name* at the head of a line, so a bare `VENDOR_PORTAL_TOKEN=` is a defined key to it; an uncommented placeholder would flip every slot to satisfied the moment the file was created. `credentialsSeed()` builds the names from `agent.credentials[].expectedKeys` and prefixes each with `# `, so a freshly seeded file leaves readiness exactly where it was
  - **Containment is checked twice, on two different things.** `resolveWithinRoot` compares `realpath`s, and a path that does not exist yet resolves to itself — so on an agent folder reached through a symlink, checking the not-yet-created file would refuse the agent's own folder. The folder is created and checked first; the file is checked again once it exists, and that second check is the one that refuses a `.env` symlinked out of the folder
  - **`flag: 'wx'` is what makes a click safe to repeat.** A file that appeared between the `existsSync` and the write — the user's own editor, a script the agent just ran — is never overwritten, and `wx` will not follow a dangling symlink either. The failure is only re-raised as `write_failed` when the file is still absent afterwards
  - **`shell.openPath` resolves with an error string; it does not throw.** `.env` has no registered application on most machines, so the empty-string check is the real branch: macOS then gets `execFile('open', ['-t', …])`, its default *text* editor, and anything still unhandled gets `shell.showItemInFolder` and `revealed: true`, so the click never dead-ends

### `src/main/db/agents.ts`
`agentRepo.rekeyFolderRow(userId, oldId, newId)` → `{moved, repointed}`. One transaction, insert-copy → repoint → delete:

| Repointed | FK? |
|---|---|
| `a2a_sessions.agent_id` | yes (cascade) |
| `chat_on_demand_agents.agent_id` | yes (cascade) |
| `job_agents.agent_id` | yes (cascade) |
| `chats.agent_id` | no |
| `jobs.agent_id` | no |
| `agent_overrides.agent_id` | no |
| `messages.addressed_agent_id` | no |
| `messages.source_agent_id` | no |
| `messages.tool_agent_id` | no |

The six FK-less columns are the ones a cascade would have missed entirely — they do not disappear when the row does, they stop resolving. The three `messages.*` columns drive per-agent colouring and orchestrated sub-thread grouping, so a stale id there is a visibly broken transcript.

`moved: false` is returned (not thrown) when the row is absent or the target id is taken; the caller logs it and falls back to the ordinary rescan, which is lossy but never wrong.

### `src/main/services/localAgents/scannerService.ts`
- `unreadableAgent(agentDir, root, finding)` — the `unresolved` DTO. Never indexed; `scanRoot` adopts the id of the row already at that path so the list, the page and any open chat stay pointed at the same agent while it is repaired
- Legacy detection in `scanAgentFolder` — `manifestId === ''` → `identity: 'legacy'`, id `legacyFolderAgentId(root.id, folderName)`. **Indexed like any other agent**, and deliberately *not* added to the protected-paths set: its id is a pure function of where it sits, so the row survives on the ordinary ground, and protecting it would leave a stale positional row behind forever after a re-key
- Duplicate branch in `scanRoot` — the first folder alphabetically claims `folder:<id>`; a later claimant gets `duplicateFolderAgentId(root.id, basename(dir))`, `readiness: 'invalid'`, and a `manifest.id.duplicate` finding naming the winner. `manifestId` keeps the colliding value, because that is what the two folders actually claim

## Renderer Components

| Component | Renders / manages |
|---|---|
| `LocalAgentsList` | Root groups (`groupAgentsByRoot`), readiness dot, sub-line (`agentSubline`), the `+` that opens the create modal |
| `LocalAgentPage` | Loading / not-found / not-indexed states; header (readiness dot, name, description or nudge, path-as-reveal-button, `OpenInMenu`, Start chat, `AgentActionsMenu`) and the one `actionError` slot (`role="alert"`, always rendered as exactly one `h-4` line, truncated with the full text in `title` — a two-line wrap at the minimum window width moved the panel below it) both menus report into, reset on selection change; the scroll container has `[scrollbar-gutter:stable]`; `ReadinessStrip`; `RuntimePanel`; the four-tab strip (`useState<AgentPageTab>`, kept across agents; Commands carries the catalog count, Folder carries the validation-findings count in the warning token) and the cards each tab mounts; the draft-on-arrival effect |
| `OpenInMenu` | Split button when a default tool resolves (primary launches it; chevron opens the menu), a plain "Open in…" menu button otherwise. Menu: `launchable` tools with a check on the default, Terminal, Reveal folder, and a no-tools sentence. A tool pick calls `useSetDefaultTool` when it differs from the current default, then `useOpenIn` with `actionForTool`. Takes `onError(message \| null)`; calls it with `null` at the start of every launch and with the unwrapped message on failure — renders no error text of its own |
| `AgentActionsMenu` | The ⋯ popover: Rescan folder, Reveal folder, Open terminal here, Stamp identity (only `identity === 'legacy'` with a manifest stamp; `onSuccess` follows the selection to the re-keyed id), a separator, Delete agent…. Reports through `onError(message \| null)` (cleared at the start of every action) rather than rendering a line. Owns `useDeleteLocalAgent({onSuccess})` — hook-level: `setActiveLocalAgentId(null)`, close the dialog. `DeleteAgentDialog` (private, takes the mutation as `remove`): Escape / outside-click / Cancel dismiss it **unless `remove.isPending`** (a `pendingRef` so the listeners see the current value); `isBlockedWriteError` → the busy sentence, in an always-rendered `min-h-8` `role="alert"` slot so the buttons never move |
| `RuntimePanel` | "Runs with", `aria-label` of the same. The panel is a `@container` and the grid is `grid-cols-2 @2xl:grid-cols-3` — a **container** query on the panel's own width (three columns from 42rem), not a viewport breakpoint: at the app's 800px minimum window the viewport is already past `md`, so `md:` never stopped applying and gave each select 129px. Credential `<select>` (usable providers by **name**; the default option names the Default runtime's credential, looked up across *all* providers so a keyless one still reads the same here as it does to the engine), then one slot holding **one of three** controls: the work-complexity `<select>` (`Simple` / `Medium` / `Complex`, each with `(none listed)` appended when this credential serves nothing in that tier, and the whole scale in the control's `title` — an `<option title>` is not rendered on macOS, so a per-option hint nobody sees is not a hint), the model `<select>` (registry models for the effective provider, plus the manifest's own model when the registry lacks it; the default option names `resolveRuntimeModel`'s answer **for the selected credential** — by registry **name**, falling back to the id — and reads bare `Default` until the registry has loaded), or a disabled `Loading…` placeholder while neither the manifest nor the remembered preference can say which of the two this agent gets. The **Advanced** checkbox shares the label's row and is rendered in *both* views, so switching pickers cannot change the panel's height; it is **disabled and forced on** for a manifest whose pinned model matches no work complexity, which overrides both the sticky per-agent view and the remembered preference, with the reason standing in the status line. The tier option carries the tier alone: `Medium (Claude Sonnet 4.5)` is 170px in a 163px control at the 800px minimum, so naming the model there made the panel's permanent visible state a truncated one (ux_rules rule 7) — the model is named in the status line instead, with the cost hint beside it. Then `EngineStatus` (dot, word, Start) — `col-span-2 @2xl:col-span-1`, i.e. full-width on a second row in a narrow panel. Below the grid, **one reserved `h-4` line** (`truncate`, full text in `title`) carries whichever message wins the priority order — the refused save, `SecretsLine`'s outcome (a reveal note or an unwrapped refusal, ranked here because what the user just clicked outranks a note about the write before it, and cleared by the next `commit`), the model the last credential change dropped, the not-configured credential, no credential at all, a credential with no usable key, the loading or failed registry, a substituted model (the manifest's id is no longer listed; a note, not a warning — the agent runs), a tier this credential lists no model for, a model belonging to another catalogue, no model at all, the engine's skip reason, the standing "Advanced stays on" note for a pinned model no tier describes, the resolution line naming the tier and what it runs on, the no-models note — rather than a stack of conditional rows whose height changed with the credential. A footer below it appears only for `SecretsLine` — whose link calls `useOpenAgentCredentials` (`local-agent:open-credentials`) and opens `credentials/.env` itself, seeded on the spot when it is missing, rather than revealing the folder around it. It takes an `onOutcome` prop and owns no line of its own: `revealed: true` reports "nothing here opens .env", a rejection reports `unwrapIpcError(err, 'credentials/.env could not be opened.')` — the channel **throws** (`not_found`, `invalid_path`, `write_failed`, `turn_in_progress`), so the raw message carries the `invoking remote method` prefix — and `created` reports nothing, since the seeded file opens in front of the user. The link is `disabled` while the mutation is pending, because the macOS `open -t` fallback waits up to 15 s and a second click would launch a second editor. The callbacks are passed to `mutate()` rather than to the hook, which is safe *here* and not in general: the state they set (`secrets`) lives in `RuntimePanel`, the caller's own parent, so nothing can outlive the component that would render it. Then the not-editable note. A save in flight is an absolutely positioned `Loader2` (`aria-label="Saving"`) in the panel's top-right corner, never a row. Both selects are disabled until `useModels` settles — succeeds or fails — and each carries what it resolves to in `title` (the chosen credential, or `Default: <name>`) |
| `FolderTab` | `ValidationCard` (every finding, or "validates against kit contract X"), `IdentityCard` (id or "(none — identified by folder name)", folder, contract/kit version, the legacy pointer to the ⋯ menu), `CredentialsCard`, `FilesCard` (the seven files the page reads, each a reveal), `PublishedCard`, `RunsCard` |
| `AgentCard` | Title, the agent-relative file name (reveal button when the card supplies one), right-aligned actions slot. The button's tooltip is `Reveal <file>` unless the card overrides it with `revealTitle` |
| `ReadinessStrip` | `null` unless something needs attention. Otherwise: `readinessMessage(agent)` with a "N findings" link to the Folder tab — suppressed when the folder is legacy and every validation error's code starts with `manifest.id.` (`onlyIdMissing`), since the legacy notice says the same and carries the fix; the legacy notice with **Stamp identity**; the drafting spinner; the draft outcome. The `ok` sentence is now "This folder is valid." — and never rendered, since `ok` is what hides the strip |
| `DescriptionCard`, `ExamplePromptsCard` | Manifest-backed editors. `ExamplePromptsCard` owns two — prompts (validated per line) and router trigger |
| `PromptDocCard` | One prompt document via `useLocalAgentDoc`; plain-text editing, not markdown |
| `InlineFileEditor` | Click-to-type, autosave on pause and blur; conflict banner with disk preview + Reload; the muted blocked note; the error line; the "file is not in the folder" read-only state |
| `CredentialsCard` | Slot names and which declared variable names `credentials/.env` defines. **Names only**. Folder tab. Its reveal opens the `credentials/` **folder** and its tooltip says so (`revealTitle="Reveal the credentials folder"`): the file may not exist, `showItemInFolder` on a missing path is a silent no-op, and a Folder-tab card has nowhere to report that. Creating and opening the file belongs to the Runs-with panel's secrets line, which is the surface with a line to report on it |
| `CommandsCard` | `Local/<slug>/docs/CLI_COMMANDS.yaml` entries with their localised command. Commands tab |
| `StatusCard` | `app-data/storage/STATUS.md` — state, updated-at, summary, markdown body. First card of the Overview tab |
| `PublishedCard`, `RunsCard` | `publications[]`; the `app-data/desktop.json` session count. Folder tab |
| `NewLocalAgentModal` | Step one: a `<form>` (Enter submits) with the name and the live path preview under it — only `describeAgentSlug(...).slug` is read; its `message` is deliberately not rendered (it appeared and vanished between keystrokes and resized the dialog) — More options (description, folder name, root selector when there is more than one root), Cancel / Create — or "Create and open in <tool>" when auto-open applies. Step two, "Build <name> with…": `launchable` as choice rows (default marked and auto-focused), Terminal and Reveal folder, the "Open new agents this way without asking" checkbox (hidden when nothing is launchable; `rememberAuto ?? autoOpen`, so it mirrors the live setting until touched, and a pick writes `localAgentsAutoOpen` only when the two differ), Not now. Both steps render their error in an always-present `min-h-8` `role="alert"` slot. The page is navigated to *before* step two shows, so closing the modal at any point leaves the user on the new agent |
| `LocalAgentsSettingsSection` | Roots card, add-root button, readiness list, developer-tools card — which now ends with the **Open agents with** select (`useDefaultTool().launchable`, "Ask each time" = `''`) and the auto-open checkbox (disabled until a default resolves) |

## State Management

**React Query — server state.** Keys: `['local-agents']` (roots + agents), `['local-agent', agentId]`, `['local-agent-doc', agentId, prompt]`, `['local-agent-roots']`, `['local-tools']`.

- Nothing polls. `useLocalAgentWatch` subscribes once, high in the tree, and invalidates on `local-agent:changed`. A per-agent push also invalidates the `['local-agent-doc', agentId]` prefix — the DTO carries the prompt documents' *stamps* but not their text, so without that an assistant's rewrite would never appear
- Every mutation writes the freshly-scanned agent straight into `['local-agent', id]` and invalidates the list, so the page never shows an echo of what was sent
- A prompt-document save additionally cancels the in-flight read for that key and seeds it with what was written, so the next mount does not flash pre-save bytes
- `useLocalTools` is `staleTime: Infinity` — detection is cached in main for the app's lifetime; Refresh is the only invalidation
- `useDeleteLocalAgent` invalidates the list and `['agents']`, never `['local-agent', id]`. Removing the page's own entry while the page still observes it would make React Query refetch a row that no longer exists and land on `not_found` ("not indexed"); the ⋯ menu clears the selection in the hook's `onSuccess`, which unmounts that observer, and the stale entry is garbage-collected with nothing watching. **Hook-level, not mutate-level**: TanStack drops the callbacks passed to `mutate()` when the calling component unmounts, and the menu — not the dialog, which can be gone by then — is the component that outlives the request
- `['agents']` (the `useAgents` query behind the composer `@` popup, the `[+]` picker and the Jobs agent picker) is invalidated on create, stamp identity, delete and every `local-agent:changed` push. It used to be refreshed only when a remote sync completed, so a deleted folder agent stayed pickable
- `useDefaultTool` derives `{tool, launchable, autoOpen}` from two queries — `['local-tools']` and the app-settings query — with `resolveDefaultTool` and `launchableTools` from the pure layer. `tool` is `null` both when nothing is set and when the set tool is not installed; `autoOpen` is true only when `tool` resolved **and** the flag is on

**Zustand — UI only.** `activeLocalAgentId` (selection) and `pendingDraftAgentId` (a one-shot intent handed from the create form to the page, the same shape as the existing `pendingAgentId`).

### `useAgentFileEditor`

Inputs: `{agentId, relPath, snapshot, toUpdate, readBack?, docPrompt?, validate?}`. Output: `AgentFileEditor` (`text`, `setText`, `flushNow`, `canSave`, `isSaving`, `conflict`, `blocked`, `diskText`, `reload`, `error`).

- `toUpdate` / `readBack` / `validate` are held in refs so `persist` keeps a stable identity — a `persist` that changed on an unrelated parent render would restart the autosave timer, and a user typing steadily in a busy window would never reach the end of one
- Identity is `(agentId, relPath)`. A change to either is a new document, so it reseeds rather than raising a conflict
- Two refs guard the race: `timerRef` (cleared at the top of every `persist`, so a blur cannot leave the debounce armed) and `inFlightRef` (one save at a time)
- Debounce: `AUTOSAVE_DEBOUNCE_MS = 700`; `BLOCKED_RETRY_MS = 3000` when `state.blocked`. The effect keys off `[state, persist]` — which is why `saveBlocked` must return a new object
- `snapshot` memoisation matters: `useManifestSnapshot` rebuilds only when the value or the manifest's stamp hash moves, and `PromptDocCard` memoises on the doc object. An unmemoised snapshot restarts the timer every render
- The blocked retry is the interim shape. The right one is a `local-agent:unlocked` push from `turnLock.whenFree`, letting the editor sleep until the run actually ends

## Configuration

- `localAgentsHome` (`app_settings`, default scope) — where the home root points. Owned by Phase 2; surfaced here only as the Home row in Settings
- The bundled kit contract version is read off the default root's `contractVersion` and shown in the Developer tools card
- `localAgentsDefaultTool` (`app_settings`, machine-local like `localAgentsHome`; default `''`) — a `LocalToolId` or empty for "ask". Written by the Open-in menu, the "Build it with…" step and the Settings select; read through `useDefaultTool`, which resolves it against the detected list so an uninstalled tool degrades to "ask". The value check accepts any **known** id, runtimes included — the kind restriction is applied on resolve, not on write. See [Open in Tools — Technical Details](open_in_tools_tech.md)
- `localAgentsAutoOpen` (`app_settings`; default `false`) — skip the "Build it with…" step and launch the default tool at once. Meaningless without a resolved default; the Settings checkbox is disabled in that case and the modal falls back to asking

## Security

- **No secret reaches this surface.** `CredentialsCard` renders variable *names* and a present/absent tick; no value in `credentials/.env` is ever read by the desktop. The one write the desktop makes into that file — `openCredentials`' seed — carries declared names and no value, and is never parsed back. `app-data/desktop.json`'s agent token crosses only as `hasAgentToken`
- **Paths never arrive from the renderer as trusted input.** `local-agent:root-add` opens a native directory dialog in main; `local-agent:open-path` takes an *agent-relative* path re-resolved inside the folder; `local-agent:open-credentials` takes **no path at all**, because it writes — `credentials/.env` is fixed in main and re-checked for containment after the file exists; `local-tools:open-in` re-validates against the registered roots. See [Open in Tools](open_in_tools.md)
- **Every write is stamp-guarded and turn-locked**, including the AI draft's writes and `stamp_identity`. There is no code path where the desktop writes into an agent folder without both
- **Delete is the one removal, and it is the OS Trash.** `shell.trashItem` on the located folder, under the turn lock; no `rm -rf` anywhere in the slice. The id is resolved through `locate()`, so a non-folder id — a remote or hand-added agent — is `not_found` before anything is touched
- **The default tool is an allowlist, not a string.** `localAgentsDefaultTool` is checked against `LOCAL_TOOL_IDS` on write; the renderer never hands `local-tools:open-in` a tool id it did not get from the detected list. An arbitrary string in that setting is exactly what `open-in` would otherwise be asked to launch
- **No raw HTML in rendered agent content.** `react-markdown` + `remark-gfm`, no `rehype-raw`, for `STATUS.md` and for any editor rendering markdown
- All channels require an activated user session; folder agents live in the settings (default) scope

## Testing

Covered by unit tests:

- `src/renderer/src/utils/localAgents.test.ts` — every editor transition (stamp round-trip, clean adopt, dirty conflict, refusal never retried, reload pairs text and stamp, the same-slice branch, an equal-size change detected by hash, blocked keeps the text and returns a fresh object), the sub-line order (including the name-as-description blank and the validator's backticks stripped from an invalid folder's reason), root grouping, slug diagnosis, example-prompt round-trip, `canDraftWithDefaultMode`, the default tool
- `src/main/ipc/localAgentOutcome.test.ts` — the outcome contract, driven with the real production functions on both sides
- `src/main/db/agents.test.ts` — the re-key transaction
- `src/main/services/localAgents/draftService.test.ts`, `editorRoundTrip.test.ts` — the main-side halves
- `src/main/services/localAgents/localAgentService.test.ts` — `create` without a description; `delete` in four cases; `openCredentials` in four, including the one that pins the seed's purpose: after it runs, the slot is still **unsatisfied**
- `src/main/services/appSettingsService.test.ts` — the default-tool value check
- The five jsdom component suites — `LocalAgentPage.test.tsx`, `OpenInMenu.test.tsx`, `AgentActionsMenu.test.tsx`, `NewLocalAgentModal.test.tsx`, `RuntimePanel.test.tsx` (which also pins that the secrets line calls `openCredentials` with the agent id, not `openPath` with `'credentials'`) — each with its hooks mocked; the page test additionally mocks every child (`RuntimePanel`, `OpenInMenu`, `AgentActionsMenu`, `FolderTab`, the cards) as markers, so it pins order and tab routing, not the children's rendering, which is why `RuntimePanel` needs a suite of its own
- `e2e/specs/agent-page.spec.ts` — the real app: a name-only create → "Build it with…" → Not now → the page → Delete via ⋯, with `shell.trashItem` stubbed in main so the sandbox's folder does not land in the developer's Trash; and an IPC create with no description, checking the name stands in and the folder is `ok`. See [E2E](../../development/e2e/e2e.md)

Not covered, and why:

- **The React glue of `useAgentFileEditor`.** `vitest.config.ts` runs `environment: 'node'`; there is no jsdom or testing-library in the repo, so the double-save-with-one-stamp fix was verified by a manual probe in the running app and the probe reverted. Adding renderer test infrastructure is a tracked follow-up — the pure machine underneath is fully covered, only the debounce/mutation wiring is not
- **`draftService`'s `wantsWorkflow && !workflowStamp` branch**, marked untested in a comment: reaching it requires the workflow document to be deleted between two reads of the same scan
- **The five raw-`err.message` render sites** (the list's load error, and **four** in Settings — add root, forget root, reveal, and the engine-path save at `LocalAgentsSettingsSection.tsx:85`) — the failure text there is the wrapped *"Error invoking remote method '<channel>': …"* sentence. **This bullet said six and its sibling said six; the sibling was recounted at `b566d83` and this one was missed**, which is what a count in two places does. See the recount and its method in [Agents Tab & Agent Page](agents_tab.md) — it is the entry that carries the app-wide figure and the reason it is given as a range. The fix is `unwrapIpcError` (`src/renderer/src/utils/ipcError.ts`; the page redesign applied it to the Open-in menu, the ⋯ menu and the New agent form, which is how seven became five) or converting the channel to the outcome shape. Re-synced with the sibling at the page redesign
