# Marketplace Plugins — Technical Details

Implementation reference for [Marketplace Plugins on a Local Agent](plugins.md).

## File Locations

### Main process
- `src/main/services/marketplacePluginService.ts`: `marketplacePluginService` (the verbs, below), `componentsOf` (core's `components` → `AddonComponents`), `PLUGIN_TYPES` (`claude`, `codex`), `pluginDiscoverPath`, `pluginArchivePath`, `MARKETPLACE_PLUGIN_SENTENCES` (one sentence per refusal code), `PLUGIN_STATUS_TEXT`
- `src/main/services/marketplacePluginCache.ts`: `marketplacePluginCache` (built on `pinnedSkillCache.ts`, like `marketplaceSkillCache.ts`), `verifyPluginTree`, `archiveDigests`, `pluginSnapshotKeyOf`, `PLUGIN_TREE_MODIFIED_SENTENCE`, the marker file `.cinna-marketplace-plugin.json`
- `src/main/services/pluginTree.ts`: `readPluginTree(dir)` — what a cached folder holds (`skills/`, `commands/`, `agents/`, `hooks/hooks.json`, MCP servers from `.mcp.json` or the manifest's `mcpServers`), `readPluginCommand`, `pluginTitleOf`. Read-only, never follows a link, never throws; a file that is missing or malformed reads as absent
- `src/main/services/pluginSkills.ts`: `pluginPinsOf`, `disabledOf`, `cachedPlugins(manifest)` (each pin with its cached folder and tree), `pluginSkillRows`, `deliveredSkillRows(agentDir, manifest)` (own + catalog + marketplace + plugin skill rows: **the one input of every skill delivery**), `PLUGIN_SKILL_TEXT`
- `src/main/services/agentPluginWrappers.ts`: `ensureAgentPluginWrappers(agentId, plugins, {hooksAllowed, reserved})`, `agentPluginWrappersRoot`; state file `.cinna-plugin-wrapper.json`
- `src/main/services/pluginMcpProviders.ts`: `createPluginMcpProviders(deps).sync(...)` — reconciles an agent's managed connectors, pure over `PluginMcpDeps`
- `src/main/services/stdioRuntimes.ts`: `stdioRuntimes` (`available`, `recheck`, `ensureUv`, `blockOf`), `runtimeOfCommand`, `throughManagedUv`, `STDIO_RUNTIME_TEXT`
- `src/main/mcp/managed.ts`: `pluginManagedBy`, `pluginOfManagedBy`, `snapshotKeyOfManagedBy`, the secret-slot helpers, `resolveManagedLaunch`, `managedLaunchBlock`, `discardPluginWork`, `collectPluginWork`, `pluginProjectEnvDir`, `pluginWorkDir(managedBy, serverName)` (`<userData>/plugin-work/<entry>/<sha>/<server>`)
- `src/main/mcp/workCopy.ts`: `prepareWorkCopy(providerId, spec)` (called by `mcp/manager.ts` in the connect, after the old process stopped; answers a refusal sentence or null and marks the copy in use), `releaseWorkCopies(providerId)` (on disconnect and after a failed connect), `isWorkInUse`, `workCopyCurrent`, `ensurePluginWorkCopy`, `WorkCopySpec` (carried on `McpProviderConfig.workCopy`). A copy of a whole snapshot from before copies were per server is removed on the first prepare
- `src/main/localdev/toolchain.ts`: `managedUvLayout()` — the pinned uv's binaries and `UV_*` environment
- `src/main/db/migrations/mcp-managed-by.ts`, `mcp-managed-env.ts`: the three columns (below); registered in `src/main/db/migrations/index.ts`
- `src/main/kit/skillArchive.ts`: `readPluginArchive` — the skill archive reader's rules with one root `<name>/` and no `SKILL.md` required
- `src/main/services/pinnedSkillAutoFetch.ts`: `fetchMissingPlugins(agentId, manifest)`, called from `ensureKitAgentSkillsPlugin`
- `src/main/services/agentSkillsPlugin.ts`: now builds from `deliveredSkillRows`, so plugin skills share the agent's skills plugin and links folder; `marketplacePluginCache.root()` is a read path when a plugin skill is linked
- `src/main/services/localAgents/promptAssembly.ts`: `skillsSection` names "the skills of the plugins it pins"
- `src/main/agents/drivers/index.ts`: `kitAgentAddonPlugins(userId, agentId)` → `ClaudeLauncherDeps.agentAddonPlugins`
- `src/main/agents/drivers/acp/acpLaunchers.ts`: Claude appends the wrapper paths after the agent's skills plugin, on the isolated branch only
- `src/main/engine/engineConfigSource.ts`: `pluginCommands(plugins)` → `EngineAgentInput.commands`, through `kitAgentPluginCommands(agent)` (shared with the driver); `src/main/engine/configGenerator.ts`: the `command` key
- `src/main/services/pluginCommandExpansion.ts`: `expandPluginCommand(text, commands, {agentKey?})` → the prompt or null; `shellMarker`, `SHELL_LEAD_IN`. Pure
- `src/main/agents/drivers/acp/acpDriver.ts`: `expandPluginCommandInput(launcherId, input, commands)` (engines in `EXPANDS_PLUGIN_COMMANDS`: opencode, codex, antigravity), called in the turn before `placeTurnContext`; `AcpDriverDeps.pluginCommands`. `src/main/agents/drivers/index.ts`: `kitAgentCommandTemplates(userId, agentId)` supplies it
- `src/main/services/localAgents/sharingService.ts`: `ensurePinnedInBackground` after a team Get, Update and Use
- `src/main/auth/reload.ts`: a managed connector is started at app start if `startsUnattended`, or if `launchBlockOf(row)` is non-null so the manager refuses it with the reason; `src/main/hub/core.ts`: `collectGarbage()` at start
- `src/main/mcp/config.ts`, `src/main/mcp/manager.ts`: `mcpRowToConfig` returns `resolveManagedLaunch(...)`; the manager throws `config.blockedReason` before it starts a server and sends a server's declared headers
- `src/main/services/mcpService.ts`: `upsertManaged` / `assertManagedEdit`, `managedByTitle`, `McpProviderDto.envSlots`
- `src/main/ipc/addons.ipc.ts`: the plugin channels below

### Shared
- `src/shared/addons/plugins.ts`: `PluginPinStatus`, `PluginServerStatus`, `PluginSkillStatus`, `PluginRefusal`, the input and result types
- `src/shared/addons/engineSupport.ts`: `engineSupports`, `enabledParts`, `compatibilityOf`, `engineDetails`, `ADDON_ENGINES`, `ENGINE_LABELS`
- `src/shared/kit/manifest.ts`: `MarketplacePluginPin`, `MarketplacePluginDisabled`

### Preload
- `src/preload/index.ts`: `addons.pluginStatus`, `.setPluginDisabled`, `.updatePlugin`, `.revealPlugin`, `.recheckRuntimes`

### Renderer
- `src/renderer/src/components/agents/local/PluginRow.tsx`: `PluginRow`, `pluginSummary`, `pluginIssues`, `PLUGIN_ROW_TEXT`, the nested connector line with its in-place setup form
- `src/renderer/src/components/agents/local/AgentAddonsTab.tsx`: owns the plugin verbs (set-disabled, update, remove, reveal) so one in flight outlives its row; plugins join the frozen order and the badge
- `src/renderer/src/components/agents/local/AddonPickerDetail.tsx`: a plugin's detail (what it adds, **Works with**, needs, **Check again**, the runs-code button), `SetupStep`, `EnvSlotFields`
- `src/renderer/src/hooks/useAddonDirectory.ts`: `useAddonPluginStatus` (`['addons','plugin-status',agentId]`, under `ADDONS_KEY` so every add or remove reads it again), `useSetPluginDisabled`, `useUpdatePlugin`, `useRevealPlugin`, `useRecheckRuntimes`
- `src/renderer/src/components/settings/MCPProviderCard.tsx`: `managedBy` (read-only fields, no delete, the "From *plugin*" badge) and `envSlots` (one password field per name)

## Database Schema

Three nullable columns on `mcp_providers` (`src/main/db/schema.ts`; idempotent `ALTER TABLE`, no DML):

| Column | Notes |
|---|---|
| `managed_by` | `plugin:<entry_uuid>@<archive_sha256>` (lowercase) for a plugin snapshot's server, else null. One row per snapshot. A comment in `migrations/mcp-managed-by.ts` still shows the older `plugin:<entry_uuid>` form; the code writes and reads the `@<sha>` form (`pluginManagedBy`), and a value with no `@` parses with a null sha |
| `env_secret_enc` | the user's values for the slots, one encrypted JSON object (safeStorage), read in main at launch only. Also used, with the same encryption, by a local connector made from a directory entry ([Agent Addons](addons_tech.md)) |
| `managed_spec` | JSON `ManagedSpec`: `root` (the cached folder), `slots`, declared `headers`, `bearer`, `work` (the working copy's path) |

The pins and `disabled` live in the agent's `cinna-agent.json`, not in the database.

## IPC Channels

All activation-gated, scoped with `getSettingsScopeUserId()`, answered as **data** (`{ok:false, code, message}`) because a thrown error's code does not survive IPC.

| Channel | Signature | Notes |
|---|---|---|
| `addons:add` / `addons:remove` | with a `core-marketplace-plugin` ref | The pin's verbs go through the directory ([Agent Addons](addons_tech.md)) |
| `addons:plugin-status` | `({agentId}) → PluginStatusResult` | Every pin as its row shows it: against its marketplace (one batch lookup; a failed lookup is `unknown`, never an error), on this computer, against the agent's engine, part by part |
| `addons:set-plugin-disabled` | `({agentId, name, disabled}) → PluginActionResult` | Each key given replaces the pin's own; an empty `disabled` is dropped from the pin |
| `addons:update-plugin` | `({agentId, name}) → PluginActionResult` | |
| `addons:reveal-plugin` | `({agentId, name}) → PluginRevealResult` | Shows the cached folder through the host; refused when the agent has no such pin or the snapshot is not validly on this computer |
| `addons:recheck-runtimes` | `() → {ok, node, docker}` | Re-reads the login shell's PATH, then probes again |

Refusal codes (`PluginRefusal`): the marketplace skills' (`no_account`, `not_found`, `not_kit_agent`, `read_only`, `access_unknown`, `already_added`, `unsupported`, `preparing`, `snapshot_missing`, `download_failed`, `hash_mismatch`, `invalid_archive`, `too_large`, `manifest_modified`, `write_failed`, `reauth_required`, `network`) plus `blocked` (a server needs a runtime this computer lacks, or the policy) and `runtime_failed` (the managed uv could not be installed).

## Services & Key Methods

### `marketplacePluginService`
- `discover()`: every claude- and codex-format entry the person sees, page by page (`/api/v1/llm-plugins/discover`)
- `addToAgent(userId, agentId, entryUuid)`: inside the agent's chain (below): account → kit agent → batch lookup (`not_found` when the entry is not visible) → `entryRefusal` → `changeability` → `collision` (same entry, or same name) → `fetchSnapshot` → `readyToPin` → `writePins` through the manifest guard → `syncServers`. The result's `next` is `env` when a new connector has an empty slot, else `bearer` when one needs a token
- `update(userId, agentId, name)`: the pin keeps its name; already current is a no-op unless the cached copy fails `verifyPluginTree`, then it is discarded (`marketplacePluginCache.discard`, with the snapshot's working copy) and downloaded again
- `remove(userId, agentId, name)`: drops the pin; `syncServers` releases its connectors and deletes a row nothing references; the cache stays for `collectGarbage`
- `setDisabled(userId, agentId, name, disabled)`: rewrites the pin's `disabled`; connectors follow at once (`syncServers`); skills, commands and hooks reach the engine at the next session
- `ensurePinned(userId, agentId)`: downloads every pin not in the cache, installs the managed uv when a server is Python, then reconciles. **Never throws.** `ensurePinnedInBackground` is the same, never awaited
- `status(userId, agentId)`: builds the `PluginPinStatus` list; a copy changed on disk reads `failed` with `PLUGIN_TREE_MODIFIED_SENTENCE`; hooks are `hooksBlockedByPolicy` when on and forbidden, else `hooksReason` names the engine
- `reveal(userId, agentId, name)`
- `launchBlockOf(row)`: the sentence a connector that `startsUnattended` holds back is refused with, when a launch block alone holds it back (attached, no value or bearer missing); null otherwise. `PluginRow.pluginIssues` skips a connector failure equal to the plugin's `cacheMessage` when `cache === 'failed'`
- `startsUnattended(row)`: the app-start gate for a managed connector — attached to some agent, no empty slot, no bearer missing, `managedLaunchBlock` null, and Node or Docker present for a command that needs it
- `collectGarbage()`: once per app start; skipped when any agent's pins cannot be read. Removes the snapshots no registered agent pins, then the working copies (`collectPluginWork`) whose `entry/sha` no pin and no remaining managed row names. A managed row no pin references and no agent uses goes first; one still standing keeps its folder

**`serialized(agentId, run)`** — one chain of pin writes and syncs per agent: add, update, remove, set-disabled and a background ensure each run only after the one before on the same agent has settled. Without it a slow ensure could sync from a manifest a remove had already changed.

**`fetchSnapshot(profile, host, ref)`** — one download per snapshot at a time. The gzip is compared with the server's `X-Archive-Sha256` and the pin's digest, then `readPluginArchive` unpacks it into the cache with `archiveDigests` in the marker. A 404 (the entry is gone or its marketplace is no longer visible) is recorded as *not available* on the cache (`recordNotAvailable`, which the row reads as "no longer available") and answered `not_found`; a 404 whose detail code is `snapshot_missing` is its own refusal, a 409 `snapshot_pending` is `preparing`, and any other failure is recorded with its sentence for the row.

### `marketplacePluginCache.verifyPluginTree(dir)`
Walks the folder (a link or any non-file is a fail), compares the file set with the marker's and each file's size and sha256. Per session it remembers the stat key (size, mtime, ctime, inode) of each file that last hashed clean and does not read it again. A marker with no digests (a copy cached before they were recorded) does not verify.

### `pluginMcpProviders.sync`
- One row per `(entry, sha, server)`; an enabled, unblocked server of each cached pin gets its row attached to the agent. A server off, or named by the `block` callback, is detached and its row left
- A row is built from the tree: `${CLAUDE_PLUGIN_ROOT}` (and Codex's `${PLUGIN_ROOT}`) already the cached folder, a Python command through `throughManagedUv`, the plugin's env literals, the `ManagedSpec`
- A row is deleted only when `agentsUsing` is empty and `referenced()` — every `entry/sha` some agent pins — does not name its snapshot; when the pins cannot all be read (`null`) nothing is deleted
- A new snapshot's row copies the values of the same server of another snapshot of the plugin

### `mcp/managed.ts:resolveManagedLaunch(config, row)`
- Fills each `${VAR}` in command, args, URL, env and declared headers from the plugin's literals, then the user's decrypted values; an unknown name is left as written
- Under the managed uv (the command *is* the pinned `uv`/`uvx`) it adds the toolchain's `UV_*` (including `UV_PYTHON_PREFERENCE=only-managed`, so only uv's own Python is ever used) and `UV_PROJECT_ENVIRONMENT` under `plugin-envs`
- `blockedReason`: the policy forbids local servers or the tree fails `verifyPluginTree`; the manager throws it as the connection error. The working copy is not made here: the config carries a `workCopy` spec, and `manager.ts` runs `prepareWorkCopy` in the connect, refusing with `PLUGIN_TREE_MODIFIED_SENTENCE` when the copy changed under a running server, or `PLUGIN_WORK_COPY_FAILED` when it cannot be made
- A row with no `managedBy` goes to `directoryLaunch` (a directory connector: uv env, policy block, decrypted values)

### `stdioRuntimes`
- `runtimeOfCommand`: `uvx`/`uv`/`python`/`python3` → python; `node`/`npx`/`npm`/`pnpm`/`pnpx`/`yarn` → node; `docker` → docker; anything else null (run as written)
- `available(runtime)`: python is always true (the managed uv brings it); node and docker are probed once per app session on the login-shell PATH (`shell/env.ts:which`; Node is present if `node` or `npx` is). `recheck()` resets the shell environment and the probes
- `throughManagedUv(command, args, uv, root, work)`: see the rules in [the feature doc](plugins.md#managed-mcp-servers); answers `usesWork` when it pointed the command into the working copy
- `blockOf(servers, policy)`: the sentence the picker and Add show, from the policy and the probes

### `agentPluginWrappers.ensureAgentPluginWrappers`
Builds `<userData>/cinna-plugins/agents/<key>-plugins/<plugin name>/` as `.claude-plugin/plugin.json` plus a symlink per top-level entry of the cached folder, except `.mcp.json`, `skills`, `.claude-plugin`, `.codex-plugin` and, when hooks are off or forbidden, `hooks`. Rebuilt only when the link set changes (`.cinna-plugin-wrapper.json`); wrappers of plugins no longer pinned are removed; a plugin's name that would collide with the agent's skills plugin is skipped (`reserved`). Never throws: a wrapper that cannot be written is a session without it, logged.

### OpenCode commands and Cinna's expansion
`engineConfigSource.pluginCommands(cachedPlugins(manifest))` reads each `commands/*.md` (`readPluginCommand`: body = template, frontmatter `description`) and emits `<plugin>:<command>`; `configGenerator` writes `command["<agent key>/<plugin>:<command>"] = {template, description?, agent: <key>}`, skipping a name already present. It is the legacy `command` key, which OpenCode 2.0.27 normalises to `commands`. The commands are part of the config bytes, so a change restarts the warm process like a skill-set change does.

The same set is what Cinna expands. `kitAgentCommandTemplates` answers `{agentKey, commands}` for a kit folder agent only (null for synthetic and AI-function runtimes, the chat conductor, the development agent, a custom launcher or a bare agent), gated by `kitAgentPluginCommands` exactly as the config is. `expandPluginCommandInput` acts only on opencode, codex and antigravity, only when `isSlashCommand` holds, and only when the leading token's name (minus `<agent key>/` on OpenCode alone) is one of the commands; otherwise the input is returned as it was. A throw while reading the commands is logged and the text goes as typed. `refusePrompt` is asked of the typed text first, then of the final wire text. `expandPluginCommand` takes `$ARGUMENTS` as the whole argument string and `$1`…`$9` as its words, appends `ARGUMENTS: <args>` to a template with no placeholder, leaves `@file` references alone, and turns each `` !`cmd` `` into a marker preceded once by `SHELL_LEAD_IN`.

## Configuration

None user-facing. The admin's `plugin_hooks` and `stdio_mcp` flags apply ([Agent Addons](addons_tech.md#policy)); a snapshot is capped at `MAX_ARCHIVE_BYTES` (16 MB).

## Security

- **Two digests before unpack, one marker after.** The archive must equal the server's digest and the pin's; the unpacked tree is then held to per-file digests at every launch. Together they make "what the user consented to run" the same bytes at download, at pin and at launch
- **Read-only cache, writable copies elsewhere.** Nothing a plugin does can change the verified tree: servers write only into `plugin-envs` and `plugin-work`. The working copy is re-made from the cache when it changed
- **The user's values never reach the renderer.** The DTO carries slot names and `hasValue`; `env_secret_enc` is decrypted in `resolveManagedLaunch` only
- **No native `.mcp.json`, no plugin hooks from the engine's own loader.** Servers run as Cinna providers behind the permission ask; Claude's hooks arrive only through the wrapper and only while `plugin_hooks` allows
- **A policy block never deletes.** `blockedReason` and a detach leave the row and the values

## Tests

- `marketplacePluginService.test.ts` (add, update, remove, set-disabled, digests, collisions, status, garbage collection, the ordering chain), `marketplacePluginCache` coverage through it, `pluginTree.test.ts`, `pluginMcpProviders.test.ts`, `stdioRuntimes.test.ts`, `agentPluginWrappers.test.ts`, `mcp/managed.test.ts`, `shared/addons/engineSupport.test.ts`, `engine/configGenerator.test.ts` (the commands), `services/pluginCommandExpansion.test.ts`, `agents/drivers/acp/acpDriver.test.ts` (a plugin’s slash command: expanded on the three engines, left alone on Claude, refused before expansion), `ipc/addons.ipc.test.ts`
- `AgentAddonsTab.plugins.test.tsx`, `AddonPicker.plugins.test.tsx`, `MCPProviderCard.test.tsx`
- `e2e/specs/marketplace-plugins.spec.ts`: against a fake core and the scripted engine — the picker's detail and runs-code Add, the token step, the plugin row with its nested connector, the part switches, the connector refusing edits, the token reaching the server through `${LEDGER_TOKEN}`, a chat calling the server's tool through `cinna`, OpenCode's config carrying the command and skill, and Remove. It does not prove a real engine runs the command or skill, Claude's wrapper, hooks, or the managed uv for a Python server
- `e2e/specs/live-plugin-commands-hooks.spec.ts` (`@live`, real core and engine): Claude runs `/commit-commands:commit` through the wrapper and commits; OpenCode lists it as `<agent key>/commit-commands:commit` and receives Cinna's expansion of it (the template with the git lines left for the model to run), whose commit streams into the transcript and holds the turn until it is made (C2 and C2b, no longer `test.fail`); `explanatory-output-style`'s SessionStart hook reaches Claude through `${CLAUDE_PLUGIN_ROOT}` in the wrapper and stops after the Hooks switch is turned off. The Claude contract entries `claude.session.options-plugins-wrapper` and `claude.session.slash-command-leads` check the same layout and that a command still runs with the turn context after it in one block (it lands in `$ARGUMENTS`); `opencode.session.slash-command-context` still checks that a configured command runs with only its own argument when the context follows as an assistant-only block (`acpDriver.placeTurnContext`) — the engine's behaviour, no longer the path a plugin command takes from a chat. Locators in [Writing E2E Tests](../../development/e2e/e2e_llm.md)
