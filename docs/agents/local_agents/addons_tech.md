# Agent Addons — Technical Details

Implementation reference for [Agent Addons](addons.md).

## File Locations

### Main process
- `src/main/db/migrations/agent-mcp-providers.ts`: `migrateAgentMcpProviders`. Creates the table only, with no DML. It is registered in `runAllMigrations` after `migrateAgentShortcuts`, because it references `agents` and `mcp_providers`
- `src/main/db/schema.ts`: `agentMcpProviders`
- `src/main/db/agentMcp.ts`: `agentMcpRepo`
- `src/main/db/agents.ts`: `agentRepo.rekeyFolderRow` repoints `agent_mcp_providers.agent_id` with the other FK children
- `src/main/services/agentMcpService.ts`: `agentMcpService`, plus the exported constants `ADDON_CONNECT_WAIT_MS` (5 000), `ADDON_RETRY_BASE_MS` (60 000) and `ADDON_RETRY_MAX_MS` (15 min)
- `src/main/services/conductorBridge.ts`: `addonIds`, `connectedMcp`, `providers()`, `prepare()`, `refreshAgent()`, the `nestedDigests` / `nestedSessions` maps, and the `onMcpToolsChanged` fan-out
- `src/main/agents/drivers/acp/acpDriver.ts`: `TurnContext.sessionSlot`. It is taken from `ConductorLease.session`, and both `remembered` and `rememberSession` use it in place of the runtime's slot
- `src/main/agents/drivers/driver.ts`: `RunInput.runScope`. On a nested turn it is carried only to serve addons
- `src/main/services/a2aAsMcpProvider.ts`: a fifth constructor argument, `runScope`, forwarded to the nested `RunInput`. `buildAgentToolProviders` passes `{ profileUserId, settingsUserId: defaultUserId }`
- `src/main/services/taskRunnerService.ts`: the `delegate` call passes the task's `scope`
- `src/main/mcp/manager.ts`, `src/main/mcp/oauth-provider.ts`: the non-interactive connect. See [MCP Connections — Technical Details](../../mcp/connections/connections_tech.md)
- `src/main/ipc/local_agent.ipc.ts`, `src/main/ipc/mcp.ipc.ts`: the four connector channels below. `mcp:upsert` also takes `registryRef` (accepted only when `isAddonRef`; written on insert, ignored on update)
- `src/main/ipc/addons.ipc.ts`: the four `addons:*` channels (below)
- `src/main/services/addonDirectory/`: the directory. `directory.ts` (`createAddonDirectory`, pure over `AddonDirectoryDeps`: merge, `stateOf`, search memory, Add/Remove dispatch, `ADDON_STATE_TEXT`), `index.ts` (wires the real services), `types.ts` (`DirectoryProvider`, `ProviderEntry`, `ProviderListing`), and the three providers `cinnaCore.ts`, `thisComputer.ts`, `mcpRegistries.ts`
- `src/shared/addons/directory.ts`: `DirectoryEntry`, `AgentDirectoryEntry`, `AgentAddonState`, `AddonPolicy` / `DEFAULT_ADDON_POLICY`, `AddonNextStep`, the result types, `addonRefKey`, `mcpRegistryRef`, `isAddonRef`
- `src/main/db/migrations/mcp-registry-ref.ts`: `migrateMcpRegistryRef`, an idempotent `ALTER TABLE mcp_providers ADD COLUMN registry_ref TEXT`, registered right after `migrateMcp`. `mcpProviderRepo.findByRegistryRef(userId, ref)` returns the oldest provider created from a ref
- `src/main/services/mcpService.ts`: `createFromDirectory` (below); `UpsertMcpInput.registryRef`
- `src/main/services/catalogSkillService.ts`: `changeabilitySentence`, so the directory can say why a team agent's pins are read-only without trying an add

### Preload
- `src/preload/index.ts`: `localAgents.listMcpProviders`, `.attachMcpProvider`, `.detachMcpProvider`; `mcp.agentsUsing`; `mcp.upsert` takes `registryRef`; `addons.directory(agentId, {refresh?})`, `.search`, `.add(agentId, ref)`, `.remove(agentId, ref)`

### Renderer
- `src/renderer/src/hooks/useMcp.ts`: `useAgentMcpProviders(agentId)` (`['agent-mcp', agentId]`), `useAttachAgentMcp`, `useDetachAgentMcp` (both invalidate `['agent-mcp', agentId]` and `['mcp-agents-using', mcpProviderId]`, and log failures under `agent-mcp`), `useMcpAgentsUsing`. `useDeleteMcpProvider` now also invalidates `['agent-mcp']` and `['mcp-agents-using']`, because a delete cascades
- `src/renderer/src/hooks/useAddonDirectory.ts`: `useAddonDirectory(agentId, {refreshOnMount})` (`['addons','directory',agentId,profileId]`, stale after 60 s; the picker reads past the sources' caches once per opening), `useRefreshAddonDirectory`, `useAddonSearch` (`staleTime` 5 min, `keepPreviousData`), `useAddAddon` / `useRemoveAddon`, `useAddonAdds` / `settledAddonAdds` (the adds, read back from the mutation cache by agent and entry), and `refreshAfterAddonChange`. The re-reads after an add or remove run at hook level, because a mutate-level callback is dropped when the picker has unmounted
- `src/renderer/src/components/agents/local/AgentAddonsTab.tsx`: `AgentAddonsTab`, the frozen-order list (`useFrozenOrder`: attention first, then by name, re-sorted only when the set of rows changes) and `useAddonsBadge`. It owns the connector attach/detach mutations and every skill verb ([Agent Skills — Technical Details](skills_tech.md)); **Add** opens `AddonPicker`. The kind chips appear past `ADDON_FILTER_THRESHOLD` (8) rows
- `src/renderer/src/components/agents/local/AddonRow.tsx`: `AddonRow`, the shell every row is drawn in, `ADDON_KIND`, `AddonKindLabel`. `SkillRow.tsx`: the skill row (moved out of the tab file)
- `src/renderer/src/components/agents/local/AddonPicker.tsx`: the dialog, `addonMatches`, `addFlowOf`, `REGISTRY_DEBOUNCE_MS` (300), `REGISTRY_MIN_QUERY` (2), `EARLIER_REFUSAL_MS`. `AddonPickerDetail.tsx`: the detail, `PICKER_TEXT`, `SetupStep` (oauth / bearer / env / connect / enable)
- `src/renderer/src/components/settings/mcpPresentation.ts`: `mcpProblem(provider)`
- `src/renderer/src/components/settings/MCPProviderCard.tsx`: the `detach` prop and the warning glyph
- `src/renderer/src/components/settings/DeleteMcpProviderDialog.tsx`: the delete confirm
- `src/renderer/src/components/settings/AddCustomMcpForm.tsx`, `AddLocalMcpForm.tsx`, `MCPRegistryPicker.tsx`: `onCreated(id)`. `MCPRegistryPicker` also takes `closeLabel`, and records the `registryRef` of the entry it connects (`mcpRegistryRef`)
- `src/renderer/src/components/agents/local/LocalAgentPage.tsx`: the `addons` tab entry and its badge
- `src/renderer/src/components/chat/ChatInput.tsx`, `ActiveMcpChips.tsx`: the locked addon chips and picker entries

## Database Schema

`agent_mcp_providers` (`src/main/db/migrations/agent-mcp-providers.ts`):

| Column | Notes |
|---|---|
| `agent_id` | FK `agents.id`, `ON DELETE CASCADE` |
| `mcp_provider_id` | FK `mcp_providers.id`, `ON DELETE CASCADE` |
| `created_at` | Attach time. Lists are ordered by it, then by `rowid` |

The primary key is (`agent_id`, `mcp_provider_id`), with an index on `mcp_provider_id` for the "used by" and fan-out lookups. Keyed by `agents.id` rather than the manifest id, so a stamp re-key has to move the rows (it does). A folder pruned by the scanner takes them with it, while a rescan of an unchanged folder keeps the row and so keeps them.

`mcp_providers.registry_ref` (JSON text, nullable, `{source, id}`): the directory entry a connector was created from. Null for a connector set up by hand and for every row that existed before the column. Written on insert only, so an edit never moves it.

## IPC Channels

Every handler is activation-gated and scoped with `getSettingsScopeUserId()`.

| Channel | Signature | Notes |
|---|---|---|
| `local-agent:mcp-list` | `(agentId) → string[]` | Attached connector ids, oldest first. `[]` for an id that is not a folder agent in this scope |
| `local-agent:mcp-attach` | `({agentId, mcpProviderId}) → {success: true}` | Throws `LocalAgentError('not_found')` for a non-folder agent and `McpError('not_found')` for a connector outside the scope. Attaching an already-attached connector is a no-op |
| `local-agent:mcp-detach` | `({agentId, mcpProviderId}) → {success: true}` | Agent checked as above; detaching what is not attached is a no-op |
| `mcp:agents-using` | `(mcpProviderId) → {id, name}[]` | The folder agents a connector is attached to, oldest attachment first. Read by the delete confirm |

The directory's own channels (`addons.ipc.ts`; activation-gated, scoped with `getSettingsScopeUserId()`; ids, refs and the query are validated, the query capped at 200 characters):

| Channel | Signature | Notes |
|---|---|---|
| `addons:directory` | `({agentId, refresh?}) → AddonDirectoryResult` | `{ok, entries, sources, policy}`. `refresh` re-reads the providers' caches |
| `addons:search` | `({agentId, query}) → AddonSearchResult` | Only the search-only providers (the public MCP registry), gated by policy. A hit that is already a local connector comes back as that connector |
| `addons:add` | `({agentId, ref}) → AddonActionResult` | `{ok: true, next, mcpProviderId?, message?}`; `next` is the step a connector still needs |
| `addons:remove` | `({agentId, ref}) → AddonActionResult` | Unpins or detaches; what the agent does not have is a no-op; a connector is detached, never deleted |

Their refusals are **data** (`{ok: false, code, message}`; codes such as `not_found`, `invalid_ref`, `blocked`, `preparing`, `unsupported`, plus the pin paths' own), including a `DomainError` thrown by the attach (caught in the directory and returned), because a thrown error's code does not survive IPC. The `marketplace-skills:discover` and `:add` channels were removed with the old skill modal; `local-agent:mcp-attach` remains the connector attach the directory calls.

The four connector channels above throw rather than return outcomes: their failures are only ever shown as a sentence (`unwrapIpcError`), so no code has to cross the boundary.

## Services & Key Methods

### `src/main/db/agentMcp.ts` — `agentMcpRepo`
- `listProviderIds(ownerId, agentId)`: an inner join on `mcp_providers` filtered by `mcp_providers.user_id = ownerId`, so a link to another scope's connector is never returned
- `attach(agentId, id)`: `onConflictDoNothing`, which keeps the first attach time. Returns whether a row was inserted
- `detach(agentId, id)`: returns whether a row was removed
- `agentsUsing(ownerId, id)`: joins `agents`, filtered by the agent's owner
- `agentIdsFor(id)`: every agent, any owner. It exists for tool-change fan-out, but the bridge currently re-reads per entry with `addonIds` and never calls it

### `src/main/services/agentMcpService.ts` — `agentMcpService`
- `list` / `attach` / `detach` / `agentsUsing`: the IPC surface. A folder agent is one that `agentRepo.listFolder(ownerId)` returns (`takesAddons`). `attach` and `detach` call `refreshAgent(agentId)` only when the row actually changed. That is a dynamic `import('./conductorBridge')`, because the bridge imports this service
- `providerIds(ownerId, agentId)`: the bridge's read. It does not check the agent's ownership, because the run already resolved the agent
- `ensureConnected(ownerId, agentId, {signal, waitMs})`: never throws. For each attached id:
  - already `connected`: forget its retry state, skip
  - a connect *this service* started is in flight (`connecting` map): wait for it only if it is a first try
  - a connect someone else started is in flight (`mcpManager.connecting(id)`, e.g. Settings): wait for it if this version has no history yet; never call `connect`, which would cancel it
  - `connectsUnattended(row)` false (disabled, `connected`, `awaiting-auth`, OAuth with no tokens, bearer with no token), or `needsUser` recorded, or `Date.now() < retryAt`: skip
  - otherwise call `mcpManager.connect(mcpRowToConfig(row), { interactive: false })`. On success, delete the record. A result of `disconnected` while `mcpManager.connecting(id)` holds another attempt means the user's own connect replaced this one. That is not a failure either: the record is deleted and the next turn treats it as a first try. Any other result records `{version, failures, retryAt, needsUser: mcpManager.needsUser(id)}`, where `retryAt = now + min(BASE · 2^(failures-1), MAX)`. `version` is re-read from the row *after* the attempt, so a refresh that saved new tokens and then failed does not count as a new version and earn a fresh first try
  - a first try is marked in `tried` *before* it settles, so a turn that starts meanwhile shares it rather than starting a retry
  - waits on `Promise.race(allSettled(first tries), timer(waitMs), abort(signal))`
- `versionOf(row)`: `configRevision` + the sha256 of the encrypted OAuth or bearer blob. Both maps (`connecting`, `tried`) are module state, so a restart starts over
- `resetForTests()`

### `src/main/services/addonDirectory/`
- `createAddonDirectory(deps)` is pure over its deps (providers, agent facts, the pin and attach calls, `mcpSetup`, `findMcpByRef`, `createMcpFromDirectory`, `deleteMcp`), so the merge, the states and the dispatch are tested with fakes; `index.ts` wires `localAgentService`, `catalogSkillService`, `marketplaceSkillService`, `agentMcpService` and `mcpService`
- `list`: every ungated provider is read first (core's policy comes with them), then those the policy allows; the answers are ordered by provider order (Cinna, this computer, MCP registries); a throwing provider becomes that source's `error` and the rest answer. Then `mergeLocalProviders`, then each entry gets its state. The skill-access check (`changeability`, one git read of the folder's remote) runs once per read and only for a kit agent, and **fails open**: a failed check never fails the read, and Add checks again
- `mergeLocalProviders`: a `this-computer` entry whose `registryRef` matches another source's entry takes that entry's place, carrying its metadata but keeping the local ref, `mcpProviderId` and local setup facts. This is the only de-duplication
- `stateOf` order: already added (`mcpProviderId` attached, or a skill pin with that package/entry uuid) → `added` (with "Added — *what it needs*" when the connector has a pending step); `pending` → `preparing`; `unsupported` → `blocked`; plugin → `blocked`; skill on a non-kit agent → `blocked`; skill with a read-only agent → `blocked` with `changeabilitySentence`; a `setupReason` → `addable_with_setup`; else `addable`
- `search`: asks the providers that have `search` and pass the policy, remembers the hits (`searched`, an LRU of 500, so a detail or an Add can name an entry no list holds), folds hits that are already local connectors into those, and states each for the agent
- `add`: catalog → `catalogSkillService.addToAgent`; marketplace → `marketplaceSkillService.addToAgent`; `this-computer` → attach, then the connector's `mcpSetup`. Any other ref: an unowned ref is `not_found`, a gated provider is `blocked`; an existing connector with that `registry_ref` is attached; else the entry is found (memory, the provider's `find`, or its list) and refused if it is a plugin, pending, or not an MCP entry with an install; otherwise `mcpService.createFromDirectory`, then attach, and **on an attach failure the connector just created is deleted** before the refusal is returned
- `remove`: finds the pin by package/entry uuid (catalog, marketplace) and calls the existing remove; a connector is detached by local id or by `registry_ref`
- Providers: `cinnaCore` reads the catalog listing's skill packages (`libraryService`) and the marketplace entries (`marketplaceSkillService.discover`), cached `CORE_DIRECTORY_TTL_MS` (60 s) unless `refresh`; signed out or local-only it returns nothing without an error, and an expired session is `errorCode: 'reauth'`. Its `fromCoreEntry` / `fromCorePolicy` already map core's snake_case `DirectoryEntry` and policy; no core directory endpoint is read yet, so `policy` is `DEFAULT_ADDON_POLICY` today. `thisComputer` lists `mcp_providers` as `mcp` entries and computes the step with `setupOf(row, status, needsUser)`: `enable` (switched off), `bearer` (no token), `oauth` (no tokens and the server asked for the user or is `awaiting-auth`), `connect` (status `error`), else none. `mcpRegistries` lists the `cinna-official` registry whole (limit 100) and searches the `official` one (limit 50, an empty query returns nothing); it is gated by `externalDirectories`, uses an entry's first remote, and marks an entry that `requiresAuth` as needing a sign-in or token after adding
- `mcpService.createFromDirectory(userId, {name, transportType, url, authType, registryRef, connect})`: inserts the provider enabled with its `registryRef`, and, unless `connect` is false (a bearer server with no token yet), connects with `{interactive: false}`. It returns `{id, status, needsUser, error?}`, from which `index.ts` derives the setup step: `bearer` for a bearer server, `oauth` when `needsUser`, `connect` (with the error) for any other failure, none when connected
- `mcpProviderRepo.upsert` writes `registryRef` on insert only

### `src/main/services/conductorBridge.ts`
- `prepare()` no longer returns early for `input.nested`. It still requires `runScope`, `canConduct(agent)` (ACP, not WebSocket) and a non-remote plan. Then:
  - `addons = addonIds(agent, runScope)`. A nested run with none returns `undefined`, so there is no lease, as before
  - with any addons, it `await`s `agentMcpService.ensureConnected(settingsUserId, agent.id, { signal: input.signal })`
  - nested: the entry key is `['nested', chatId, agentId]` (direct: `[chatId, agentId]`), `wake` is replaced with `() => false` (a nested session cannot open a turn of its own), the delegation/handover providers are not built, `applyConductorToolPolicy` and the conductor context are skipped, and `messageRepo.saveToolCall` is skipped (results still `publish`). `Entry.nested = true`
  - session digest: direct turns read and save `conductor_sessions` as before. Nested turns never touch it. `freshSession` is `plan.sessionToolsFixed && nestedDigests.get(key) !== hash`, and with `sessionToolsFixed` the lease carries `session: {read, save}` over `nestedSessions`. `sessionReady` / `sessionLost` write `nestedDigests` / `forgetNested(key)`
- `providers(entry)`: a deleted or invisible chat gives `[]`; a chat conductor with `toolPolicy === 'none'` gives `[]`; `entry.nested`, or a chat that is neither the agent's own nor `router === 'human'`, gives `connectedMcp(addons)`. Otherwise it gives controls, then handovers, then `connectedMcp(chat ∪ on-demand ∪ addons)`, then (with no controls, in a coordinator chat) agent tools. The middle-branch rule used to return `[]` for a chat bound to another agent
- `refreshAgent(agentId)`: `refreshTools()` on every live entry (retiring included) whose agent matches, in any chat
- `onMcpToolsChanged`: an entry re-lists when the changed provider is in its chat's baseline, its on-demand set **or its agent's addons**
- `installChatSessionForgetter`: also `forgetNested(key)`

### `src/main/agents/drivers/acp/acpDriver.ts`
- `runTurn`: `if (conductor?.session) ctx.sessionSlot = conductor.session`. `remembered` reads that slot when set, else `runtime.readSession(chatId)`
- `rememberSession`: saves to `ctx.sessionSlot` when set, else `runtime.saveSession`
- Test: `acpDriver.test.ts` › "keeps a nested session in the lease's own slot, leaving the agent's session in the chat alone"

## Renderer Components

| Component | Notes |
|---|---|
| `AgentAddonsTab` | A `SettingsSection` "Addons" with a (?) and the **Add** action. Lists connectors (`MCPProviderCard` with `detach`) and skills (`SkillRow`) in one frozen order. **Owns the attach and detach mutations**, not the picker, because an attach outlives the picker closing. TanStack drops mutate-level callbacks on unmount. A list error goes in one `role="alert"` line under the section; a Detach failure goes in that connector's card. The skill block reason (`skillBlock`) is computed here from the share status and passed down |
| `useAddonsBadge(agentId, agentSkills?)` | `{count, problems, skills}` from the same two queries the tab uses plus the skills on the agent the page already holds, so no extra IPC. A skill with any issue other than `not_downloaded`, or a deliverable one with a credential whose `filled` is `false`, counts as a problem (`needsAttention`), so a catalog pin's `download_failed` does and a slot the scan did not judge does not. `LocalAgentPage` draws `problems` warning-toned when there are any, else the muted `count`, titled by `addonsBadgeTitle` |
| `AddonPicker` | Portal `role="dialog"` named "Addons for *agent name*" (not "Add to …", which is the detail's button). A fixed `h-[36rem]` card. The list is filtered locally (`addonMatches`: title, name, summary, source, publisher, tags); the registry search runs on the debounced query. The list stays mounted but `invisible` under a detail or a form, so Back finds its state. Adds live in the mutation cache; `addFlowOf` decides what an entry shows from its add: running always, a finished one only if it began after this opening, an older **refusal** for 5 minutes (nothing else says it failed), an older success is the directory's state. `onAttachCreated` (owned by the tab) attaches a connector made from Custom connector…. Escape, outside click and the header button do nothing while a form or a setup step holds input (`holdsInput`) |
| `AddonPickerDetail` | The entry's detail and its one action: **Add to *agent***, `Adding…`, **Ready in the next chat** + **Done**, a `SetupStep`, **Added** / **Finish setup**, **Remove** (confirmed inside the card). `SetupStep` re-reads the connector's row fresh (Save, Turn on and Connect act on the row, not a list cached before it changed), finishes when the connector reports `connected`, and shows main's raw connect error only behind a (?), after `connectFailureSentence` |
| `MCPProviderCard` | `detach?: {onDetach, disabled}` replaces the trash button with an `Unlink` button named "Detach *name* from this agent", which opens a confirm inside the card (a `group` of the same name, with **Detach** / **Cancel**), as a skill's Remove does; `pending` and `error` come from the tab, and a failure shows in the card. Without `detach`, the trash button (named "Delete MCP *name*") opens `DeleteMcpProviderDialog` instead of deleting at once. That dialog renders outside the clickable header, because a portal's clicks still bubble through the React tree. The status glyph (`mcpHealth`: a check, a red cross for a failed connect, a warning triangle otherwise; `role="img"`, named by `mcpProblem`) follows the name |
| `mcpProblem` | `null` when fine; otherwise "Turned off — nothing gets its tools", "Waiting for authorization in your browser", the connection error, or "Not connected". One wording for the Settings card and the Addons card |
| `DeleteMcpProviderDialog` | Mounts only once `useMcpAgentsUsing` has settled, so the agent line does not appear under the cursor after the buttons, and initial focus lands on **Cancel**. The mutation is the card's, and the dialog closes when the list refetches without the connector. Undismissable while deleting (`useDialogChrome` `pending`) |
| `ActiveMcpChips` | `agentAddonIds` and `agentName` props. The order is baseline, then addons, then on-demand, de-duplicated. `locked` is now `'mode' \| 'agent' \| null`, and each kind has its own tooltip |
| `ChatInput` | `addonAgent` is `boundAgent` in a chat and `selectedAgent` on the new-chat screen. `lockedMcpIds = baseline ∪ addons` is what `useCapabilityPicker` receives as `baselineMcpIds`, so the picker shows those entries selected and no-op on toggle |

## Configuration

None user-facing. The wait and backoff are the constants above.

## Security

- Tokens never leave main. The agent's runtime reaches a connector only through the Cinna MCP endpoint (loopback, per-session bearer), and the bridge proxies calls through `mcpManager`. See [Orchestrated Agents — Technical Details](../../chat/orchestrated_agents/orchestrated_agents_tech.md)
- An unattended connect is `interactive: false` all the way down to `ElectronOAuthProvider.redirectToAuthorization`, which throws `McpReauthorizationRequiredError` instead of opening a browser. Nothing a turn does can put an authorization page in front of the user
- Attach checks both the agent (folder agent in the settings scope) and the connector (owned by the settings scope). Reads join on the connector's owner

## Tests

- `src/main/db/agentMcp.test.ts`: idempotent attach and ordering, owner filter, the cascade from connector delete and from the agent prune, survival across a rescan, and the move on stamp re-key
- `src/main/services/agentMcpService.test.ts`: scope refusals, unattended-only and never-interactive connects, the bounded shared wait, waiting on a Settings connect in flight, the doubling backoff, no retry while it needs the user until the version changes, abort, and never throwing
- `src/main/services/conductorBridge.addons.test.ts`: addons beside chat MCPs (once each), addons only in another agent's chat, a not-connected addon left out, no connect for an agent with none, nothing under tool policy none, the nested addons-only endpoint, nested calls kept out of the transcript, the nested fixed-tools session slot, no lease for a nested run without addons, and `refreshAgent` / tool-change fan-out
- `src/main/mcp/manager.peer.test.ts`, `oauth-provider.test.ts`: the non-interactive connect reports `needsUser`, exposes the attempt only while it runs, and never opens a browser even with a callback pending
- `src/main/services/addonDirectory/{directory,providers,index}.test.ts` (merge, states, dispatch, the delete after a failed attach, each provider's mapping), `src/main/ipc/addons.ipc.test.ts`, `mcpService.test.ts` (`createFromDirectory`), `db/mcpProviders.test.ts` (`registryRef` written on insert only)
- `AddonPicker.test.tsx`, `AgentAddonsTab.test.tsx`, `MCPProviderCard.test.tsx`, `DeleteMcpProviderDialog.test.tsx`, `ActiveMcpChips.test.tsx`, `LocalAgentPage.test.tsx` (the badge, and the bare tab set)
- `e2e/specs/agent-addons.spec.ts`: add through the picker (an existing connector, a custom one), detach, a Settings delete naming the agent, and a real ACP session witnessing the addon's tool through the Cinna MCP server, with a second agent as the control. Locators are in [Writing E2E Tests](../../development/e2e/e2e_llm.md)
