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
  - The `{ field: 'stamp_identity' }` variant of `LocalAgentFieldUpdate` — value-less by design: the UUID is minted in main, and a `value` here would be an id-setter any other card could reach
  - `describeAgentSlug(name)` / `AgentSlugCheck` / `AgentSlugProblem`, sharing `reduceToSlugCharacters` with `slugifyAgentName`
  - `canBeCounterparty(agent)` — temporary, removed in Phase 6
- `src/shared/localAgents.test.ts` — `canBeCounterparty` is independent of `enabled`; id prefix round-trip

### Main process
- `src/main/ipc/local_agent.ipc.ts` — all handlers; the module-private `withCode()` wrapper that converts a thrown `DomainError` into a `LocalAgentOutcome` failure; the one-time `localAgentService.configure()` composition-root call
- `src/main/ipc/localAgentOutcome.test.ts` — drives `localAgentFailure` and `unwrapLocalAgentOutcome` (the **real** functions each side calls) against each other: the code survives, blocked is told apart from stale, main's own sentence arrives without the `invoking remote method` wrapper, success passes through
- `src/main/services/localAgents/draftService.ts` — `localAgentDraftService.draft()` / `.draftOnce()` / `.runDraftCall()` / `.saveField()`, plus the exported pure helpers `parseDraftMeta()` and `isUntouchedWorkflowPrompt()`
- `src/main/services/localAgents/draftService.test.ts` — the metadata parse (including a model that ignored the format), the happy path, one draft per agent however many callers ask at once, the no-credential skip, the fill-a-blank-only rule for each of the three fields, a document that changed while the model was thinking, an unreachable model, and an already-complete agent
- `src/main/services/localAgents/localAgentService.ts` — the `stamp_identity` case of `updateField()`; `readDoc()`, which returns text and stamp from one read
- `src/main/services/localAgents/scannerService.ts` — the identity union (`unreadableAgent()` → `unresolved`; no manifest `id` → `legacy`), and the duplicate-id branch of `scanRoot()`
- `src/main/services/localAgents/editorRoundTrip.test.ts` — the main half of the save guard
- `src/main/db/agents.ts` — `agentRepo.rekeyFolderRow(userId, oldId, newId)` and `RekeyFolderRowResult`
- `src/main/db/agents.test.ts` — the re-key transaction: rows moved, every dependent table repointed, no-op on a clash

### Preload
- `src/preload/index.ts` — `window.api.localAgents.*`. Phase 3 adds `draft`, `readDoc`, and changes `get` / `updateField` to resolve a `LocalAgentOutcome<T>` rather than reject. **The bridge does not unwrap** — see [Why the outcome is unwrapped in the renderer](#why-the-outcome-is-unwrapped-in-the-renderer). Typed by inference; there is no hand-written interface

### Renderer — hooks, store, utils
- `src/renderer/src/hooks/useLocalAgents.ts` — every query and mutation, plus `useAgentFileEditor`
- `src/renderer/src/hooks/useLocalTools.ts` — `useLocalTools`, `useAvailableTools(kind)`, `useRefreshLocalTools`, `useOpenIn`
- `src/renderer/src/utils/localAgents.ts` — the pure layer: `readinessLabel`, `agentSubline`, `groupAgentsByRoot`, `suggestAgentName`, `canDraftWithDefaultMode`, `parseExamplePrompts` / `formatExamplePrompts`, and the `FileEditorState` machine
- `src/renderer/src/utils/localAgents.test.ts` — 40+ cases over all of the above, including every editor transition
- `src/renderer/src/stores/ui.store.ts` — `ActiveView` gains `'local-agent'`, `SidebarTab` gains `'agents'`, `SettingsMenu` gains `'local-agents'`; fields `activeLocalAgentId` and `pendingDraftAgentId` with their setters

### Renderer — components
- `src/renderer/src/components/agents/local/LocalAgentsList.tsx` — the sidebar list; `AgentRow` and `readinessColor` are module-private
- `src/renderer/src/components/agents/local/LocalAgentPage.tsx` — the page shell: not-found / not-indexed states, the draft-on-arrival effect, the header, the card order
- `src/renderer/src/components/agents/local/AgentCard.tsx` — the shell every card shares; takes the agent-relative `file` it renders and an optional reveal
- `src/renderer/src/components/agents/local/ReadinessStrip.tsx` — readiness message + validator findings, the legacy/stamp-identity notice, the drafting and draft-outcome notes
- `src/renderer/src/components/agents/local/OpenInRow.tsx` — the detected assistants/editors, Terminal, Reveal
- `src/renderer/src/components/agents/local/ManifestCards.tsx` — `DescriptionCard`, `ExamplePromptsCard` (which owns two editors: prompts and router trigger) and the shared `useManifestSnapshot`
- `src/renderer/src/components/agents/local/PromptDocCard.tsx` — one of the three prompt documents, read through its own query
- `src/renderer/src/components/agents/local/ReadOnlyCards.tsx` — `RuntimeCard`, `CredentialsCard`, `CommandsCard`, `StatusCard`, `PublishedCard`, `RunsCard`
- `src/renderer/src/components/agents/local/InlineFileEditor.tsx` — the Notes inline-editor pattern plus the conflict banner, the blocked note and the error line
- `src/renderer/src/components/agents/local/NewLocalAgentModal.tsx` — the one-sentence create form
- `src/renderer/src/components/settings/LocalAgentsSettingsSection.tsx` — roots, add/forget/reveal, the readiness list, detected tools, contract version

### Renderer — shell wiring
Adding the tab is four edits (renderer seam 10 of `plans/local-agents.md`), the settings section three:

- `src/renderer/src/stores/ui.store.ts` — the three unions plus two fields
- `src/renderer/src/components/layout/SidebarTabs.tsx` — a `TAB_ITEMS` entry and a `handleSwitchTab` branch (clears the selection, sets `'local-agent'`)
- `src/renderer/src/components/layout/Sidebar.tsx` — the `LocalAgentsList` branch in the tab body, and the `local-agents` entry in `defaultMenuItems` (**not** `PROFILE_SCOPE_TABS`)
- `src/renderer/src/components/layout/MainArea.tsx` — an early return for `activeView === 'local-agent'`
- `src/renderer/src/components/settings/SettingsPage.tsx` — a `sectionTitles` key and a render line
- `src/renderer/src/App.tsx` — `useLocalAgentWatch()` mounted once in `Shell`
- `src/renderer/src/components/chat/ChatInput.tsx`, `src/renderer/src/components/jobs/JobEditForm.tsx` — the two `canBeCounterparty()` filters

## IPC Channels

Phase 3 additions and changes. Every handler is activation-gated and scoped with `getSettingsScopeUserId()`.

| Channel | Signature | Notes |
|---|---|---|
| `local-agent:get` | `(agentId) → LocalAgentOutcome<LocalAgentDto>` | **Changed shape.** `not_found` is a routine destination |
| `local-agent:update-field` | `(UpdateLocalAgentFieldInput) → LocalAgentOutcome<LocalAgentDto>` | **Changed shape.** Three refusals, three behaviours |
| `local-agent:read-doc` | `(ReadLocalAgentDocInput) → LocalAgentDocDto` | Text and stamp from one read of one file |
| `local-agent:draft` | `(agentId) → DraftLocalAgentResult` | Async, up to ~90 s per call. Resolves `skipped` with no credential |

Unchanged from Phase 2 and used here: `local-agent:list`, `:create`, `:rescan`, `:validate`, `:open-path`, `:roots-list`, `:root-add`, `:root-remove`, and the main → renderer push `local-agent:changed`. The Open-in row and the Settings tools card use `local-tools:list` / `:refresh` / `:open-in`.

### Why the outcome is unwrapped in the renderer

Two boundaries drop non-standard error properties:

1. `ipcMain.handle` serialises a rejection as `{message, stack}` — `err.code`, attached by `src/main/ipc/_wrap.ts`, is gone
2. `contextBridge` clones whatever preload throws into the main world as a fresh `Error` — so rebuilding the error *in preload* puts it on the wrong side of the second boundary

So the failure travels as **data** all the way in, and `useLocalAgent` / `useUpdateLocalAgentField` / `useStampAgentIdentity` call `unwrapLocalAgentOutcome` inside their `queryFn`/`mutationFn`, where the thrown error stays put. `src/main/ipc/localAgentOutcome.test.ts` pins the contract: the property being restored is invisible at every call site (`isStaleWriteError` simply starts telling the truth), so nothing else would notice it breaking again.

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
| `LocalAgentPage` | Loading / not-found / not-indexed states, header (name, path-as-reveal-button, Rescan, disabled Start chat), `OpenInRow`, `ReadinessStrip`, the eleven cards, and the draft-on-arrival effect |
| `AgentCard` | Title, the agent-relative file name (reveal button when the card supplies one), right-aligned actions slot |
| `ReadinessStrip` | `readinessMessage(agent)` + up to six validator findings; the legacy notice with **Stamp identity**; the drafting spinner; the draft outcome |
| `DescriptionCard`, `ExamplePromptsCard` | Manifest-backed editors. `ExamplePromptsCard` owns two — prompts (validated per line) and router trigger |
| `PromptDocCard` | One prompt document via `useLocalAgentDoc`; plain-text editing, not markdown |
| `InlineFileEditor` | Click-to-type, autosave on pause and blur; conflict banner with disk preview + Reload; the muted blocked note; the error line; the "file is not in the folder" read-only state |
| `RuntimeCard` | Manifest `runtime` block, falling back to the default chat mode's model, with the engine line disabled |
| `CredentialsCard` | Slot names and which declared variable names `credentials/.env` defines. **Names only** |
| `CommandsCard` | `Local/<slug>/docs/CLI_COMMANDS.yaml` entries with their localised command; Run disabled |
| `StatusCard` | `app-data/storage/STATUS.md` — state, updated-at, summary, markdown body |
| `PublishedCard`, `RunsCard` | `publications[]`; the `app-data/desktop.json` session count |
| `NewLocalAgentModal` | Sentence → suggested name → confirmed folder, root selector when there is more than one root |
| `LocalAgentsSettingsSection` | Roots card, add-root button, readiness list, developer-tools card |

## State Management

**React Query — server state.** Keys: `['local-agents']` (roots + agents), `['local-agent', agentId]`, `['local-agent-doc', agentId, prompt]`, `['local-agent-roots']`, `['local-tools']`.

- Nothing polls. `useLocalAgentWatch` subscribes once, high in the tree, and invalidates on `local-agent:changed`. A per-agent push also invalidates the `['local-agent-doc', agentId]` prefix — the DTO carries the prompt documents' *stamps* but not their text, so without that an assistant's rewrite would never appear
- Every mutation writes the freshly-scanned agent straight into `['local-agent', id]` and invalidates the list, so the page never shows an echo of what was sent
- A prompt-document save additionally cancels the in-flight read for that key and seeds it with what was written, so the next mount does not flash pre-save bytes
- `useLocalTools` is `staleTime: Infinity` — detection is cached in main for the app's lifetime; Refresh is the only invalidation

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
- No new setting is introduced by this phase

## Security

- **No secret reaches this surface.** `CredentialsCard` renders variable *names* and a present/absent tick; no value in `credentials/.env` is ever read by the desktop. `app-data/desktop.json`'s agent token crosses only as `hasAgentToken`
- **Paths never arrive from the renderer as trusted input.** `local-agent:root-add` opens a native directory dialog in main; `local-agent:open-path` takes an *agent-relative* path re-resolved inside the folder; `local-tools:open-in` re-validates against the registered roots. See [Open in Tools](open_in_tools.md)
- **Every write is stamp-guarded and turn-locked**, including the AI draft's writes and `stamp_identity`. There is no code path where the desktop writes into an agent folder without both
- **No raw HTML in rendered agent content.** `react-markdown` + `remark-gfm`, no `rehype-raw`, for `STATUS.md` and for any editor rendering markdown
- All channels require an activated user session; folder agents live in the settings (default) scope

## Testing

Covered by unit tests:

- `src/renderer/src/utils/localAgents.test.ts` — every editor transition (stamp round-trip, clean adopt, dirty conflict, refusal never retried, reload pairs text and stamp, the same-slice branch, an equal-size change detected by hash, blocked keeps the text and returns a fresh object), the sub-line order, root grouping, name suggestion, slug diagnosis, example-prompt round-trip, `canDraftWithDefaultMode`
- `src/main/ipc/localAgentOutcome.test.ts` — the outcome contract, driven with the real production functions on both sides
- `src/main/db/agents.test.ts` — the re-key transaction
- `src/main/services/localAgents/draftService.test.ts`, `editorRoundTrip.test.ts` — the main-side halves

Not covered, and why:

- **The React glue of `useAgentFileEditor`.** `vitest.config.ts` runs `environment: 'node'`; there is no jsdom or testing-library in the repo, so the double-save-with-one-stamp fix was verified by a manual probe in the running app and the probe reverted. Adding renderer test infrastructure is a tracked follow-up — the pure machine underneath is fully covered, only the debounce/mutation wiring is not
- **`draftService`'s `wantsWorkflow && !workflowStamp` branch**, marked untested in a comment: reaching it requires the workflow document to be deleted between two reads of the same scan
- **The six raw-`err.message` render sites** (list load, create, Open-in row, and three in Settings) — the failure text there is the wrapped *"Error invoking remote method '<channel>': …"* sentence. Converting those channels to the outcome shape, or wrapping them renderer-side, is the fix
