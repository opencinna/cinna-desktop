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
- `src/main/ipc/local_agent.ipc.ts`, `src/main/ipc/mcp.ipc.ts`: the four channels below

### Preload
- `src/preload/index.ts`: `localAgents.listMcpProviders`, `.attachMcpProvider`, `.detachMcpProvider`; `mcp.agentsUsing`

### Renderer
- `src/renderer/src/hooks/useMcp.ts`: `useAgentMcpProviders(agentId)` (`['agent-mcp', agentId]`), `useAttachAgentMcp`, `useDetachAgentMcp` (both invalidate `['agent-mcp', agentId]` and `['mcp-agents-using', mcpProviderId]`, and log failures under `agent-mcp`), `useMcpAgentsUsing`. `useDeleteMcpProvider` now also invalidates `['agent-mcp']` and `['mcp-agents-using']`, because a delete cascades
- `src/renderer/src/components/agents/local/AgentAddonsTab.tsx`: `AgentAddonsTab` and `useAddonsBadge`
- `src/renderer/src/components/agents/local/McpAttachModal.tsx`: the attach dialog
- `src/renderer/src/components/settings/mcpPresentation.ts`: `mcpProblem(provider)`
- `src/renderer/src/components/settings/MCPProviderCard.tsx`: the `detach` prop and the warning glyph
- `src/renderer/src/components/settings/DeleteMcpProviderDialog.tsx`: the delete confirm
- `src/renderer/src/components/settings/AddCustomMcpForm.tsx`, `AddLocalMcpForm.tsx`, `MCPRegistryPicker.tsx`: `onCreated(id)`. `MCPRegistryPicker` also takes `closeLabel`
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

## IPC Channels

Every handler is activation-gated and scoped with `getSettingsScopeUserId()`.

| Channel | Signature | Notes |
|---|---|---|
| `local-agent:mcp-list` | `(agentId) → string[]` | Attached connector ids, oldest first. `[]` for an id that is not a folder agent in this scope |
| `local-agent:mcp-attach` | `({agentId, mcpProviderId}) → {success: true}` | Throws `LocalAgentError('not_found')` for a non-folder agent and `McpError('not_found')` for a connector outside the scope. Attaching an already-attached connector is a no-op |
| `local-agent:mcp-detach` | `({agentId, mcpProviderId}) → {success: true}` | Agent checked as above; detaching what is not attached is a no-op |
| `mcp:agents-using` | `(mcpProviderId) → {id, name}[]` | The folder agents a connector is attached to, oldest attachment first. Read by the delete confirm |

These throw rather than return outcomes: their failures are only ever shown as a sentence (`unwrapIpcError`), so no code has to cross the boundary.

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
| `AgentAddonsTab` | One `SettingsSection` "MCP Connectors" with a (?) and an **Attach** action. Draws attached ids in attach order, dropping any id the provider list does not (yet) hold. **Owns the attach and detach mutations**, not the modal, because an attach outlives the modal closing. TanStack drops mutate-level callbacks on unmount. A detach failure or a list error goes in one `role="alert"` line under the section |
| `useAddonsBadge(agentId)` | `{count, problems}` from the same two queries the tab uses, so no extra IPC. `LocalAgentPage` draws it beside **Addons**, warning-toned when `problems > 0` |
| `McpAttachModal` | Portal `role="dialog"` named "Attach MCP connector". A fixed `h-[32rem]` card, so the search and the panel switch do not resize it. Per-card pending and error state. `created(id)` closes the panel, then `onAttach(id).then(onClose, setCreateError)`. While `panel` is set, the window Escape and outside-mousedown listeners do nothing (read through `panelRef`), and the header X becomes a Back arrow |
| `MCPProviderCard` | `detach?: {onDetach, disabled}` swaps the trash button for an `Unlink` button named "Detach *name* from this agent". Its click stops propagation, so the card does not expand. Without `detach`, the trash button (named "Delete MCP *name*") opens `DeleteMcpProviderDialog` instead of deleting at once. That dialog renders outside the clickable header, because a portal's clicks still bubble through the React tree. A warning glyph (`role="img"`, named by `mcpProblem`) follows the name |
| `mcpProblem` | `null` when fine; otherwise "Turned off — nothing gets its tools", "Waiting for authorization in your browser", the connection error, or "Not connected". One wording for the Settings card, the Addons card and the attach dialog |
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
- `AgentAddonsTab.test.tsx`, `DeleteMcpProviderDialog.test.tsx`, `ActiveMcpChips.test.tsx`, `LocalAgentPage.test.tsx` (the badge, and the bare tab set)
- `e2e/specs/agent-addons.spec.ts`: attach (existing and new), detach, a Settings delete naming the agent, and a real ACP session witnessing the addon's tool through the Cinna MCP server, with a second agent as the control. Locators are in [Writing E2E Tests](../../development/e2e/e2e_llm.md)
