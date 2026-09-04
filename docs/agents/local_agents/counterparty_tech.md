# Folder Agents as Counterparties — Technical Details

Sub-doc of [Folder Agents as Counterparties](counterparty.md).

## File Locations

### Shared

- `src/shared/localAgents.ts` — the counterparty predicate that used to live here is **gone**, along with its docstring naming its own removal condition. `FOLDER_AGENT_SOURCE`, `FOLDER_AGENT_ID_PREFIX`, `FOLDER_AGENT_PROTOCOL`, `folderAgentId(manifestId)` (`:52`) and `isFolderAgentId(agentId)` (`:47`) remain and do all the discriminating that replaced it. `isFolderAgentId` is imported by four renderer modules now, `JobDetail.tsx` being the newest.
- `src/shared/localAgents.test.ts` — the id-prefix round trip, and nothing else. The suite that pinned the exclusion was replaced rather than deleted: the claim it pinned now lives, inverted, in the two picker tests.
- `src/shared/sync.ts:153` — the `{ kind: 'agent', source: 'folder', manifestId, name? }` member of `JobDepDescriptor`. Its docstring carries the reason an *unstamped* folder agent's positional id is emitted rather than suppressed, and the reason a miss must not auto-create.
- `src/shared/kit/manifest.ts:158-159` — `MAX_EXAMPLE_PROMPTS` (20) and `MAX_EXAMPLE_PROMPT_CHARS` (500). They live beside the field they bound rather than inside either enforcer, because the bound is part of the manifest contract, not of the validator that happens to check it. This file is types and constants with no runtime imports, which is what lets both enforcers read it without either pulling in the other's dependencies.
- `src/shared/agentMetadata.ts` — `RemoteAgentMetadata`, whose five fields are non-optional and whose `cinna_mcp` is the single optional one. Its own docstring states the intended design: when `cinna_mcp` is absent the desktop synthesizes a minimal descriptor from name/description/example_prompts, which "also covers non-cinna A2A agents" — a folder agent is exactly that case.

### Main process — synthesis

- `src/main/services/localAgents/folderAgentMetadata.ts:103` — `synthesizeFolderAgentMetadata(manifest)`. Pure: no filesystem, no database, no Electron. Fills `example_prompts` and leaves the other four required fields `null`/`[]`, with the argument for each in the docstring.
- `src/main/services/localAgents/folderAgentMetadata.ts:69` — `readExamplePrompts(manifest)` (module-private). Runtime-guards the field against junk **and** applies both size caps. Its docstring records why the validator is not a substitute: the validator *reports*, and the scanner indexes the row regardless.
- `src/main/kit/validator.ts` — `checkExamplePrompts` reads the same two constants, so the reported limits and the enforced limits cannot drift.

### Main process — where the synthesized value is written

Three writers, and the reason the field is **required** on the entry type rather than optional:

- `src/main/db/agents.ts:104` — `FolderIndexEntry.remoteMetadata`. Required. An omitted field would write `undefined` over a good value at exactly the moment a rescan should be refreshing it.
- `src/main/db/agents.ts:381` — `replaceFolderIndex(...)`, whose **update** branch is the one a rescan of an existing folder takes. A field written only in the insert branch would never reach a pre-existing row.
- `src/main/db/agents.ts:467` — `updateFolderIndex(userId, entry, localRootId)`. The **watcher** path: the one that fires when `cinna-agent.json` is edited, which is exactly when these values change. It now takes the whole `FolderIndexEntry` instead of a hand-listed patch, so a field added to the type reaches this path as a compile error rather than as a row that quietly stops being refreshed.
- `src/main/db/agents.ts:503` — `rekeyFolderRow` needs no change: it is `{ ...row, id: newId }`, a whole-row spread, so it carries any new column by construction. It is nonetheless pinned by a test, on the grounds that a spread is a property of code someone could change.
- `src/main/services/localAgents/scannerService.ts:584` — the call site inside `scanRoot`'s entry build. Free here: `dto.manifest` is already parsed at that line, so the row's copy is taken at the one moment the files have just been read.
- `src/main/services/localAgents/localAgentService.ts:359` — the same call inside `reindexAgent`, the single-folder rescan.

### Main process — the picker/tool consumer

- `src/main/services/a2aAsMcpProvider.ts:84` and `:229` — the only two read sites of `cinna_mcp` in the tree, both fallback-designed. `:229` slugs the tool from `desc?.tool_name || desc?.display_name || row.name`; `:84` takes `desc?.description?.trim() || this.fallbackDescription()` and `desc?.input_schema` or the default schema.
- `src/main/services/a2aAsMcpProvider.ts:105` — `fallbackDescription()`, the model-facing framing a synthesized descriptor would have replaced. `:113` is `examples.slice(0, 3).join('; ')`: it bounds the example *count* at three and their *length* not at all, which is what makes the per-entry character cap load-bearing rather than tidy.

### Main process — job dependencies across devices

- `src/main/sync/identity.ts:64` — `agentIdentityKey(desc)`, rewritten as an **exhaustive switch on `source`**. This is not stylistic. In its previous `if (remote) … else <local>` form a new union member typechecked and was silently keyed `local|…`, which is a key that can never exist; a missing case is now a compile error at every present and future caller. The docstring records the defect and the reason for the form so nobody tidies it back.
- `src/main/sync/identity.ts:126` — the folder branch of `agentRowToDescriptor`, which must sit **above** the `cardUrl ?? endpointUrl` fallback: a folder row has both columns null, so a branch below it is dead code. The id's `folder:` prefix is this desktop's own row-keying scheme and is stripped rather than transmitted; the manifest id is what crosses devices.
- `src/main/sync/resolvers.ts:143` — `resolveFolderAgent(desc)`. Reconstructs `folder:<manifestId>` and does a **point** `agentRepo.getOwned(getSettingsScopeUserId(), …)`, re-deriving the settings scope itself rather than inheriting the caller's — which matters because the callers hold a *profile* id for the job. It also checks the found row's `source`, so an unrelated row sitting at that id cannot be bound. **It never creates.**
- `src/main/sync/resolvers.ts:297` — `findFolderAgent(desc)`, the read-only twin returning the row so the caller can label it and report the user's own toggle.
- `src/main/sync/resolvers.ts:203` — `buildResolveIndex`, which gained a `folderAgent: Map<key, enabled>`. Folder agents come from the same `agentRepo.list(settingsScope)` walk the local-agent loop already does; a `source !== 'local'` continue is what had been skipping them.
- `src/main/sync/resolvers.ts:249` — `manifestNeedsSetup`'s folder branch. This is the one branch here the compiler could **not** have demanded: `agentIdentityKey` accepts the whole agent union, so a folder descriptor falling through to the local arm typechecks and then looks itself up under a `local|` key, reporting "needs setup" on the very device the agent lives on.
- `src/main/sync/collections.ts:235` — `parseDeps`'s folder branch. A whitelist: an unknown variant is dropped silently until this is edited.
- `src/main/sync/collections.ts:327` — the apply arm. No auto-create, and a `logger.warn` on the miss — the single point at which a folder dependency stops being part of the job on this device, and the only one of the three arms that cannot recover on its own.
- `src/main/sync/manifest.ts:92` — the carry-forward, widened from `source === 'remote'` to remote-**or**-folder. Without it, a peer that could not resolve the dependency re-encodes the job one dependency lighter and hands the next device the same silent wrong run.
- `src/main/sync/manifest.ts:56` — the `logger.warn` for a folder row whose id carries no manifest id. Unreachable today (every producer builds the id from the prefix), logged at the site of the **consequence** rather than at the `return null` in `identity.ts`, which is the one module in that directory with no runtime imports and would drag Electron into two pure test files if it took the logger.

### Main process — jobs

- `src/main/services/jobService.ts:261` — the folder arm of `getDependencyStatus`. Emits `unavailable` when no row is found, `needs-setup` when a row is found and switched off, `resolved` otherwise. The comment stating why the two misses are different states sits **here**, at the site that produces the value, because the site that renders it sees one amber row and has no reason to ask.
- `src/main/services/jobService.ts:378` — `executeLocal`'s agent read: `jobAgentRepo.listAgentIds(jobId)`, then a length comparison against `filterExistingAgents`. It never consults `job.syncDeps`, `needsSetup` or any dependency state, which is why an unresolved folder dependency does not stop a run — the join row is *absent* rather than dangling, both lists are empty, and no `missing_dependency` fires.
- `src/main/db/jobs.ts:623` — `jobAgentRepo.listJobRefsForAgent(agentId)` returns `{ jobId, userId }` **read from `jobs.user_id`**. The owner comes back with the job rather than being supplied by the caller, so no caller can pass the wrong scope: a folder agent is settings-scoped while jobs are profile-scoped, and passing the caller's id would make the lookup find nothing and return silently — a fix that looks applied and does nothing. It also repairs a second profile's jobs, which a `getProfileScopeUserId()` version would have missed.
- `src/main/services/localAgents/localAgentService.ts:217` — `rebuildManifestsForRekeyedAgent(oldAgentId, newAgentId)`, called at `:567` only when `rekeyFolderRow` actually moved a row. It **drops the single descriptor naming the agent's previous manifest id first**, then rebuilds. Rebuilding alone does not work: the carry-forward re-adds any folder descriptor the prior manifest holds with no join row, which after a rekey is precisely the stale one — so the prescribed "just rebuild" fix reproduces the ghost it was written to prevent. This is a targeted data repair on one known-stale row, not a change to the carry-forward's policy.

### Renderer

- `src/renderer/src/components/chat/ChatInput.tsx:313` — `enabledAgents`, now `filter((a) => a.enabled)` and nothing else. **It feeds three things**, which is why the deletion changed three surfaces: the `@`-mention list, `useCapabilityPicker` at `:360` (the `[+]` "Add agents / MCP" modal), and the visibility flags `newChatHasContent` (`:565`) and `activeChatHasContent` (`:569`) that decide whether the `@` popup and the `[+]` menu appear **at all**.
- `src/renderer/src/components/chat/ChatInput.tsx:504` — `extractExamplePrompts(promptSourceAgent)`; `:572` `promptPopupOpen` and `:1007` `promptGate` are the pair that gate the `#` popup. Both survive their own deletion and only fail together — one decides whether the trigger char is set, the other whether the popup renders. All four trigger characters carry the identical pair, so this is a structural property of the composer's trigger system rather than a local redundancy, and it predates this slice.
- `src/renderer/src/utils/examplePrompts.ts:24` — `extractExamplePrompts(agent)` reads `agent.remoteMetadata?.example_prompts` and tests no `source`, which is why a folder agent reaches it unchanged. Three consumers: `ChatInput.tsx:504`, `MainArea.tsx:97` (the new-chat tag cloud) and `hooks/useHintContext.ts:40`.
- `src/renderer/src/components/jobs/JobEditForm.tsx:173` — the same `a.enabled` filter. `:188` groups a folder agent under `'local'` (the group key is `a.source === 'remote' ? (a.remoteTargetType ?? 'agent') : 'local'`), and `:195` is the meta tag `a.protocol.toUpperCase()`, which renders `LOCAL-FOLDER`.
- `src/renderer/src/components/jobs/JobDetail.tsx:334` — `openSetup(dep)` routes on the dependency's resolved **local id**, not its `kind`: `isFolderAgentId(dep.localId ?? '')` selects `'local-agents'`, everything else keeps `'agents'`. `kind` is `'agent'` for three sources living on two settings pages, and the auto-created shells the other arms produce are `source: 'local'`, `protocol: 'a2a'` — exactly what Settings → Agents renders — so that route stays correct for them.
- `src/renderer/src/components/jobs/JobDetail.tsx:386` — the button is additionally gated on `d.localId !== null`. Every page it could open shows a *row*; with nothing resolved there is nothing to land on. Not folder-specific: the MCP and local-agent arms resolve without auto-creating, so a shell the sync created and the user later deleted reaches the same state.
- `src/renderer/src/components/jobs/JobItem.tsx:132` — `job.needsSetup && !isRunning && !hovering`. The amber glyph shares its slot with the run-now button and is therefore hidden at the moment the user reaches for Run.

### Scope and lookup, stated precisely

`resolveFolderAgent` and `findFolderAgent` deliberately do **not** go through `agentService.findAgent`.

- `src/main/services/agentService.ts:238` — `findAgent(defaultUserId, profileUserId, agentId)` is **shape-based dispatch to exactly one scope**, not a union lookup: `agentId.startsWith(REMOTE_ID_PREFIX) ? profileUserId : defaultUserId`, then a single strict `getOwned`, with **no fallback**. It would in fact answer a `folder:` id correctly — the point is that the resolvers never have to ask, because they name the scope themselves.
- `src/main/auth/scope.ts:31` — `getAgentLookupScope()` is the different thing: it returns an **array** the caller tries in turn, and *is* a union lookup. Do not conflate the two.
- `folderAgentId(manifestId)` is `` `folder:${manifestId}` ``, so the strip-and-rebuild round trip survives even a legacy positional id (`folder:legacy:r1:x` → `legacy:r1:x` → `folder:legacy:r1:x`).

## Database Schema

No migration. The `agents.remote_metadata` column already exists (`src/main/db/schema.ts`), typed `$type<RemoteAgentMetadata>()`, nullable.

What changed is **who writes it**: previously `agentRepo.syncRemote` only, for `source = 'remote'` rows. Now also the three folder-index writers, for `source = 'folder'` rows, from `FolderIndexEntry.remoteMetadata`. A hand-added `source = 'local'` A2A agent still stores `null`.

`jobs.sync_deps` gains no column — the folder descriptor is a new member of the JSON union already stored there. `src/main/sync/manifest-stability.test.ts` pins byte-stable round-tripping of that JSON, so a new field shape has a test that speaks up rather than a silence.

## IPC Channels

None added or changed. `src/preload/index.ts`, `src/main/ipc/**`, `src/main/services/agentTurn/**` and `src/main/engine/**` are untouched by this slice.

The existing channels carry the new data unchanged: `agent:list` already returns `remoteMetadata` on every row, and `job:dep-status` already returns `JobDependencyStatus[]` — whose `localId` field, which already existed, is what makes the renderer's routing decision possible without a new discriminator.

## What is pinned, and by what

Stating an invariant is worth less than knowing whether a test defends it.

- **The pickers offer a folder agent and still respect `enabled`** — `ChatInput.agentMention.test.tsx` (3) and `JobEditForm.agentPicker.test.tsx` (4), including the group key and the disabled cases for every source. Both suites were run against the true pre-deletion bytes (`git checkout HEAD -- <path>`) and failed there before passing here, which is stronger evidence than a mutation that the behaviour genuinely changed.
- **`#` prompts reach a folder agent** — `ChatInput.folderAgentPrompts.test.tsx` (4). It supplies the metadata directly rather than through the synthesis, so a failure means the composer broke, not that the synthesis did.
- **The synthesis itself** — `folderAgentMetadata.test.ts` (15), covering the junk shapes, the absence of `cinna_mcp`, the four deliberately-empty fields, both caps, the untrimmed length measure at the 500-character boundary, and that the count cap counts *survivors* so twenty blank entries cannot crowd out a real prompt.
- **The value reaches the row by all three writers, and through a rekey** — `agents.test.ts` (5) and `scannerService.test.ts` (4). The scanner tests run the real scaffolder, the real manifest writer and the real scanner against real bytes on disk, including an edit-then-rescan (the update-branch trap, end to end) and real junk written into a real manifest.
- **The descriptor, the index and `manifestNeedsSetup`** — `folderAgentDeps.test.ts` (9), including that a folder key cannot collide with a local agent indexed under the same raw string.
- **Apply, carry-forward, the dependency states and the warnings** — `folderAgentApply.test.ts` (14), including that a missing workshop is `unavailable`, that `needs-setup` is kept for the switched-off row, that nothing is created on a miss, that the dependency is emitted once and not twice on a device that has it, and that the miss is logged while a hit is not.
- **No auto-create, and the unstamped id's asymmetry** — `resolveFolderAgent.test.ts` (11): resolves on its origin device, keeps its prefix, finds nothing on a peer.
- **The "Set up" routing and its gate** — `JobDetail.setupRouting.test.tsx` (6). The no-button test is built from an **MCP** rather than an agent, so the guard cannot later be read as folder-specific and deleted as folder cleanup.
- **The stamp repair** — `localAgentService.test.ts` (6), including that the manifest survives a *second* rebuild (where the carry-forward would otherwise resurrect the ghost) and that a job owned by a different profile is repaired.

Thirty-seven mutations were run across the four pieces and the fix-ups, every one failing a named test.

## Not verified

Carried explicitly, because the useful part of this record is what it does not cover.

- **Nothing here has been run in a live app.** No folder agent has appeared in a real picker, answered a real `#` prompt, reached a real orchestrating model, or crossed a real device pair. Every claim is unit- or component-level against fakes and fixtures. The `LOCAL-FOLDER` tag is in this bucket — nobody has seen it rendered.
- **The synthesis has never been rendered beside a real backend agent's metadata.** A mixed remote+folder list has not been shown anywhere.
- **`useCapabilityPicker` has no test file at all**, and the deletion opened a folder-agent path through it. The `[+]` picker and the two visibility flags are unpinned. Read and found defect-free; not probed.
- **An attached folder agent actually answering is unproven end to end** — which is the validation line this phase is measured against.
- `resolveMcp`'s and `resolveLocalAgent`'s auto-create paths — the two neighbours the folder arm is defined against — still have no tests of their own.
- The three sync test files **stub the logger and `db/client`** to get the modules to load, because `src/main/logger/logger.ts` imports from `src/main/index.ts` and so drags Electron into anything that logs. A stub is a mock that can mask a defect. This applies to every future test under `src/main/sync/**` until that import inversion is fixed.
- `useHintContext.ts:40` is one of the three surfaces the synthesized field lights up and is the one with **no test**.
- The claim that the synthesis "costs no extra read" is true by construction — the manifest is already parsed at the call site — but was **never measured**. Not a benchmark.
