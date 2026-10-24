# Chat Modes — Technical Details

## File Locations

### Main process

- `src/main/db/schema.ts` — `chatModes` table schema (including the `isDefault` boolean column); `chats.modeId` column
- `src/main/db/migrations/chat-modes.ts` — `chat_modes` table creation + `is_default`, `complexity` and `builtin_engine` column migrations (guarded by `hasColumn`); `migrateChatModeRuntimeIndex()` creates the partial unique index `chat_modes_builtin_engine` on `(user_id, builtin_engine)`. It needs `user_id`, which the legacy backfill adds after this module on an old database, so `src/main/db/migrations/index.ts` calls it a second time after `migrateUserIdColumns`
- `src/main/db/migrations/chats.ts` — `mode_id` column migration on `chats`
- `src/main/db/chatModes.ts` — `chatModeRepo` — pure CRUD primitives (`list`, `getOwned`, `clearDefaults`, `insert`, `update`, `delete`, plus `getRuntimeMode`, `setName` and `insertRuntimeModeIfMissing`, which relies on the unique index and ignores the losing insert of a race); `update` keeps the stored `builtinEngine` and the stored `complexity` when the caller omits it; each accepts an optional `DbOrTx` so a service-level transaction can drive them
- `src/main/services/chatModeService.ts` — `chatModeService` — owns the single-default-per-user invariant inside `getDb().transaction(...)`: clears other defaults, then inserts/updates; throws `ChatModeError` on update of a non-existent mode; also `ensureRuntimeModes(userId)`, `reset(userId, id)` and the `guardRuntimeModeEdit` check (see Runtime modes below)
- `src/main/errors.ts` — `ChatModeError` + `ChatModeErrorCode` (`not_found`)
- `src/main/ipc/chatmode.ipc.ts` — CRUD IPC handlers for chat modes (wrapped with `ipcHandle()`, gated by `requireActivated()`, delegate to `chatModeService`); `chatmode:upsert` accepts `isDefault?: boolean` and `complexity`; `chatmode:list` returns `listChatModesWithRuntimes()`; `chatmode:reset` calls `chatModeService.reset`
- `src/main/ipc/index.ts` — `registerChatModeHandlers()` registration
- `src/main/services/localAgents/runtimeModeAvailability.ts` — `createRuntimeModeAvailability(deps)` (injectable, so tests prove no CLI is spawned), `runtimeModeAvailability`, `listChatModesWithRuntimes()`
- `src/main/hub/core.ts:initializeHubCore()` — calls `ensureRuntimeModes` at startup (failure is logged, not fatal)
- `src/main/services/chatConductorService.ts` — `WORKSPACE_PROMPT`, `clearWorkspaceInstructionFiles`, `conductorGrantKey`, `syncToolPolicy`, `hasWorkspace`, `openFolder`; see Workspace policy below

### Preload

- `src/preload/index.ts` — `ChatModeData` interface (includes `isDefault: boolean`); `window.api.chatModes` namespace (list, get, upsert, reset, delete); `upsert` payload accepts `isDefault?: boolean` and `complexity`; `ChatModeData.runtime?` carries a runtime mode's availability; `window.api.chat.openFolder(chatId)`; `window.api.chat.get` returns `workspace`

### Renderer

- `src/renderer/src/constants/chatModeColors.ts` — `COLOR_PRESETS` array (10 presets), `getPreset()`, `ColorPreset` interface, `ChatModeData` type alias
- `src/renderer/src/hooks/useChatModes.ts` — `useChatModes()`, `useUpsertChatMode()`, `useDeleteChatMode()`, `useDefaultChatMode()` (renderer-side filter that picks the single mode with `isDefault: true`), `useResetChatMode()`
- `src/renderer/src/stores/chat.store.ts` — `sendError: string | null` slot + `setSendError()`; cleared automatically on `setActiveChatId` (to a different chat, or to `null` — profile switches and the new-chat screen rely on it; re-selecting the open chat changes nothing), `startStreaming`, and `reset`
- `src/renderer/src/components/settings/ChatModesSection.tsx` — Settings section listing modes with add button; renders `RuntimeModesSection` above the saved modes
- `src/renderer/src/components/settings/RuntimeModesSection.tsx` — the **Runtimes** group: one `ChatModeCard` per runtime mode in `RUNTIME_MODE_ENGINES` order; `runtimeModeChip()` maps availability plus the shared `useRuntimeSetup` phase to the chip the Agents cards use; the status slot has a fixed height so the header never resizes. The setup run is the Agents tab's (`useRuntimeSetup`)
- `src/renderer/src/components/settings/ResetRuntimeModeDialog.tsx` — `runtimeModeResetChanges(mode)` (what a reset clears and restores; empty means nothing to reset) and the confirm dialog
- `src/renderer/src/components/chat/ChatModeGlyph.tsx` — the one glyph per mode (terminal for runtime modes, dot otherwise)
- `src/renderer/src/utils/composerModes.ts` — `composerModes()` (active runtime modes first, then enabled saved modes) and `composerModeGroup()` (Runtimes / Saved modes headings, none when no runtime mode is listed); `MentionPopup` takes `getGroup`, `ComposerPlusMenu` draws the headings
- `src/renderer/src/components/settings/ChatModeCard.tsx` — Expandable card for editing a single mode (auto-save); header includes a star toggle that flips `isDefault`, plus the `Inactive` badge and its cause. The longer `detail` sentence is rendered only while the mode is inactive, as the last element of the expanded body. It is not reserved for: an always-present two-line slot between the Credential and Model selects was padding in the healthy state, and as the last element its arrival moves no select. The credential select lists `isCredentialActive` rows and adds a synthetic option for a bound one that is not among them (`credentialOptionLabel`) or has left the machine. Both selects have real `htmlFor`/`id` pairs built from `useId`, since the page renders one card per mode and a literal id would point every label at the first card's field
- `src/renderer/src/utils/chatModeStatus.ts` — `chatModeInactiveReason(providerId, providers)` → `{short, detail}` or null, plus `INACTIVE_BADGE_CLASS` / `INACTIVE_CAUSE_CLASS`. Constants rather than a component because the two cards place the badge differently; the shared thing is the wording and the scale. Returns null for a mode with no credential and while `providers` is undefined
- `src/renderer/src/components/settings/ManagedChatModeCard.tsx` — the account-provisioned card; reads the same `chatModeInactiveReason`, rendering the cause in the metadata row rather than the header, which already holds the mode's own on/off switch
- `src/renderer/src/utils/credentialLabel.ts` — `credentialOptionLabel(provider)`: the `— inactive` suffix every settings select that can list an unrunnable credential uses. A suffix and not a colour, because an `<option>` cannot be styled portably
- `src/renderer/src/components/settings/ChatModeForm.tsx` — Inline form for creating a new mode; offers `isCredentialActive` credentials only, and carries the same `useId`-based labels as the card
- `src/renderer/src/components/chat/ComposerPlusMenu.tsx` — the `[+]` composer menu; its **Chat mode** sub-view (`modeMenu` prop) lists the mode cards, and `activeModeColor` tints the button. Replaced the retired standalone `ChatConfigMenu`
- `src/renderer/src/components/chat/ChatInput.tsx` — `modeColor` prop for dynamic border/background tint; `chatModeMenu` / `tildeModePopup` props carry the mode list and selection handlers; resolves the chat's MCP baseline once (`baselineIds`: `chat_mcp_providers` for an active chat, the selected mode's list before it exists) for the chips and the `[+]` picker
- `src/renderer/src/hooks/useApplyChatMode.ts` — applies a mode to an existing chat (provider/model/modeId + baseline MCP replacement)
- `src/renderer/src/components/layout/ChatWorkspace.tsx` — Mode selection state, auto-applies `defaultMode` on new-chat entry, renders the shared `sendErrorBanner` above the chat input in both new-chat and active-chat views
- `src/renderer/src/hooks/useChatStream.ts` — On stream `error` events (LLM + agent), writes the error string into `chat.store.sendError` so the banner surfaces during active-chat sends, not just on the new-chat screen

## Database Schema

### `chat_modes` table

- `id` TEXT PK
- `user_id` TEXT NOT NULL DEFAULT `__default__` — scope key (default-scope shared resource)
- `name` TEXT NOT NULL
- `provider_id` TEXT — references `llm_providers.id` (nullable, no FK constraint)
- `model_id` TEXT — model identifier string (nullable)
- `mcp_provider_ids` TEXT — JSON array of MCP provider ID strings, default `'[]'`
- `color_preset` TEXT NOT NULL — one of the 10 preset IDs, default `'slate'`
- `is_default` INTEGER NOT NULL DEFAULT 0 — single-default-per-user invariant (enforced in `chatModeService.upsert`)
- `complexity` TEXT — `simple` | `medium` | `complex`, shown as Effort Low / Medium / High; null is no preference
- `builtin_engine` TEXT — set only on a runtime mode; unique per user where not null (partial index `chat_modes_builtin_engine`). Its presence is what makes a row a runtime mode; it is fixed at creation and never changed by an upsert
- `created_at` INTEGER NOT NULL — unix timestamp

### `chats` table addition

- `mode_id` TEXT — references the chat mode used to create this chat (nullable, no FK constraint)

## IPC Channels

- `chatmode:list` — Returns all chat modes for the active user
- `chatmode:get(id)` — Returns a single mode or null
- `chatmode:upsert(data)` — Creates (no `id`) or updates (with `id`) a mode; `data.isDefault` triggers `chatModeRepo.clearDefaults` for other modes in the same transaction; returns `{ id, success }`
- `chatmode:reset(id)` — Restores a runtime mode's defaults, keeping `isDefault`; refuses a saved mode
- `chatmode:delete(id)` — Deletes a mode; refuses a runtime mode (`read_only`); returns `{ success }`
- `chat:open-folder(chatId)` — Opens a Workspace chat's folder; errors come back as `{ success: false, error }` data, since a thrown code never reaches the renderer

## Services & Key Methods

- `src/main/db/chatModes.ts` — `chatModeRepo`:
  - `list(userId, db?)` — list all modes for user
  - `getOwned(userId, id, db?)` — fetch with ownership check
  - `clearDefaults(userId, db?)` — set `isDefault: false` on every mode for the user
  - `insert(userId, input, db?)` — generate id + insert row
  - `update(userId, id, input, db?)` — update row, falls back to existing `isDefault` if unspecified
  - `delete(userId, id, db?)` — scoped delete
- `src/main/services/chatModeService.ts` — `chatModeService`:
  - `list/get/delete` — direct repo passthroughs with logging
  - `upsert(userId, input)` — opens `getDb().transaction(...)`, conditionally calls `clearDefaults`, then dispatches to `update` or `insert`; throws `ChatModeError('not_found', ...)` when updating a missing mode
- `src/main/ipc/chatmode.ipc.ts:registerChatModeHandlers()` — Registers all four `chatmode:*` IPC handlers via `ipcHandle()`; each calls `requireActivated()` then delegates to `chatModeService`
- `src/main/db/migrations/chat-modes.ts:migrateChatModes()` — Creates table when missing (CREATE TABLE includes `is_default`); separately adds `is_default` via ALTER for legacy DBs

## Renderer Components

### Settings

- `ChatModesSection` — Lists `useChatModes()` data, renders `ChatModeCard` per mode + `ChatModeForm` toggle
- `ChatModeCard` — Expandable card; selection fields auto-save on change via `useUpsertChatMode(mode.id)`; name uses local draft state with onBlur save; header includes the `Star` button that toggles `isDefault` (mutation runs through `save({ isDefault: !mode.isDefault })`, which triggers the service-level invariant)
- `ChatModeForm` — Native inline form with Name and Runtime, conditional OpenCode credential, and collapsed More options for color/model/tools/instructions/MCP; Enter in Name submits. Calls `upsert` then `onClose`; errors use `unwrapIpcError`.

### Chat

- `src/renderer/src/hooks/useApplyChatMode.ts` — `useApplyChatMode()` returns `(chatId, mode | null)`: the active-chat mirror of `useNewChatFlow.startNewChat`. Resolves the model via the shared `resolveModel`, writes `modeId`/`providerId`/`modelId` through `useUpdateChat`, then replaces the baseline via `useSetChatMcpProviders` (fire-and-forget `mutate`, since the menu's select handlers don't await it — the mutation's `onError` logs failures under the `chat-mcp` scope). `null` clears `modeId` only and leaves the baseline alone, so detaching a preset doesn't strip the chat's tools
- `ComposerPlusMenu` — the `[+]` menu anchored below the composer; its **Chat mode** sub-view renders mode cards with `getPreset()` for colors, checkmarks `modeMenu.activeId`, and calls `onSelectMode(isActive ? null : mode)` so clicking the active mode deselects it
- `ChatInput` — Accepts optional `modeColor: ColorPreset | null`; when set, overrides the input wrapper's `borderColor` and `backgroundColor` via inline style. There is no per-chat model/MCP control beside it (`ChatControls` was removed)
- `ChatWorkspace`:
  - `useDefaultChatMode()` provides the live default. `modeSelection` is stored per profile and entry surface in `composerDraft.store`: `auto` follows the default, `none` preserves explicit deselection, and `{ id }` follows the selected mode. Navigation does not reset it; a true dispatch result from `startNewChat` consumes unchanged selections; `sending` is locked per draft through preparation and survives remount. See [Draft ownership](../conversation_ui/conversation_ui_tech.md#draft-ownership)
  - `handleNewChat` runs a pre-flight check (`hasDestination = !!selectedAgent || (!!effectiveProviderId && !!resolvedModelId)`) and writes a user-facing message into `chat.store.sendError` when no destination is determinable
  - Renders a shared `sendErrorBanner` element above the `ChatInput` in both the new-chat layout and the active-chat layout; the banner is sourced from `chat.store.sendError` so it covers stream-time errors too
  - For active chats, resolves `activeChatMode` from `chatData.modeId` via `useChatDetail` + `useChatModes`; `handleActiveChatModeChange` is a thin wrapper over the `useApplyChatMode` hook, which owns the provider/model/MCP/modeId writes when switching modes (no implicit provider fallback any more)
  - `effectiveMcpIds = new Set(activeMode?.mcpProviderIds ?? [])` — the mode's list is the whole baseline. There is no `defaultMcpIds` "all enabled providers" fallback (removed): it was latched once per app run from the first non-empty `mcp:list` result, so it was both unselected-by-the-user *and* stale (a server added mid-session never joined it). `handleActiveChatModeChange` passes `mode.mcpProviderIds ?? []` to `setChatMcp` unconditionally so an empty list clears `chat_mcp_providers` instead of re-seeding it

## Configuration

- Color presets are hardcoded in `src/renderer/src/constants/chatModeColors.ts` — each preset defines `id`, `name`, `border` (primary color), `bg` (8% opacity tint), `card` (solid dark bg), `text` (light text for active card)

## Security

- Runtime-mode and Workspace trust boundaries are under Workspace policy below
- No sensitive data — chat modes store only IDs and a color string; no keys or tokens
- MCP provider IDs stored in the mode are validated at chat creation time when `setMcpProviders` is called
- Ownership: every repo method filters by `userId`; settings UI runs at `getSettingsScopeUserId()` so chat modes live in the default (shared) scope

## Runtime binding

`src/shared/chatModeRuntime.ts` adds optional engine, systemPrompt and toolPolicy DTO fields. The guarded chat-mode migration adds engine (nullable), system_prompt (empty string default) and tool_policy (connectors default), backfilling existing provider-bound modes to opencode. Service validation accepts only supported engines, none/connectors policy and at most 100000 instruction characters; invalid values use ChatModeError invalid_value.

`src/renderer/src/components/settings/ChatModeRuntimeFields.tsx` is shared by create/edit forms. Runtime changes clear credential/model; instructions and explicit model IDs save on blur. `src/renderer/src/hooks/useRuntimeModelCatalog.ts` reads engine:model-catalog through preload. `src/main/services/runtimeModelCatalog.ts` records advertised ACP model options, including groups and legacy models.availableModels, scoped by profile/engine with source and update time. Reading does not start a runtime. Synthetic creation/reconfiguration is owned by `src/main/services/chatConductorService.ts`, not the mode repository.

Chat-mode editing keeps a synchronous optimistic draft before each full upsert, so an instructions blur followed by a tool/model selection cannot restore the previous prompt. TanStack mutation scopes serialize saves per mode; success awaits the refreshed mode list before syncing the persisted prop back into the draft. Delete is disabled while saves are pending. The Codex option is enabled and its fields save normally, including when inherited from the machine default. CLI modes do not inherit an AI-credential Inactive badge. The Runtime info tip explains that support is checked on chat start; `prepareCodexConductorPolicy` performs that main-process check rather than starting a CLI from the settings form. No local-agent runtime options change.

## Runtime modes

- `src/shared/chatModeRuntime.ts` — `ChatToolPolicy` (`none` | `connectors` | `workspace`), `RUNTIME_MODE_ENGINES` (fixed order), `RUNTIME_MODE_NAMES`, `RUNTIME_MODE_TAKES_CREDENTIAL`, `runtimeModeDefaults` / `runtimeModeResetFields` (shared by main's `reset` and the card, which shows the result without waiting for the list), `WORKSPACE_POLICY_ENGINES` and `supportsWorkspacePolicy`, `RuntimeModeAvailability`, `isRuntimeModeActive` (ready or needs_login)
- `chatModeService.upsert` ignores an incoming `builtinEngine`, so no upsert creates a runtime mode; for an existing one `guardRuntimeModeEdit` compares the incoming name and engine with the stored ones (the renderer saves whole rows, so presence alone is not a change) and refuses a credential on a CLI runtime. It also refuses `workspace` for an engine outside `WORKSPACE_POLICY_ENGINES`, and a complexity that is not a work tier. Errors are `ChatModeError` `read_only` / `invalid_value`
- `ensureRuntimeModes` also renames an existing row to its engine's current name; created rows start with no model, no credential, no MCP servers, empty instructions and are never `isDefault`
- `runtimeModeAvailability`: Claude / Codex / Antigravity use `peek()` of the binary service (never downloads) plus the auth probe's `lastKnown()` (never asks); `installing` comes from `runtimeSetupService.running()`; OpenCode is `ready` when `firstActiveCredential` (`src/shared/credentials.ts`) finds one — the same function that picks a credential-less OpenCode chat's credential (below). Account-managed modes carry no availability
- `desktopAppConnectService.adoptDesktopEngine` stars the engine's runtime mode through `chatModeService.upsert`, passing the row back whole (an upsert resets omitted fields)
- **Credential and model of an OpenCode chat** (`resolveConductorRuntime` in `chatConductorService.ts`). With no credential on the chat or its mode: the machine credential override, else the effective default chat mode's credential (both `runtimeService.resolveDefault`), else `firstActiveCredential` over `providerService.listMerged()` (local rows only for a chat shared across profiles). The third step lives here, not in `resolveDefault`: a starred runtime mode with no credential *is* the default mode, so the default has none to give. The tier is resolved against `getCachedEngineModels()` (the snapshot folder agents resolve against); an empty catalogue or a tier with no match falls back to the credential's own `defaultModelId`. Because `ensure` usually runs before any model refresh (a first chat, an Ollama catalogue), a row that captured no model is resolved again by `conductorModelId(context, getCachedEngineModels())` when the OpenCode launcher builds its config (`configInput` in `src/main/agents/drivers/index.ts`, after `collectEngineConfigInput` refreshed the cache); the captured row is not rewritten
- Effort reaches the runtime through `chatConductorService.ensure` → `runtimeService.resolve({ complexity })` and is captured as `conductorComplexity` on the chat's runtime row; Codex takes its effort per process from it (`codexEffortForComplexity` in `src/main/agents/drivers/index.ts`), so `syntheticRuntimePoolKey` includes it when set and tiers do not share a process
- `ChatModeRuntimeFields` takes `runtimeMode` (no "No preference", "Model override", instructions placeholder) and `afterModel`; its Tools select lists Workspace first, disabled with the reason on the option when `supportsWorkspacePolicy` is false

## Workspace policy

- **Where it is applied.** `chatConductorService.ensure` captures `conductorToolPolicy` on the chat's runtime row (default instructions `WORKSPACE_PROMPT` when the mode's are empty) and, for Workspace, calls `clearWorkspaceInstructionFiles` instead of writing `AGENTS.md` / `CLAUDE.md`. `acpLauncherFor` (`src/main/agents/drivers/index.ts`) clears them again on every turn's plan, before any session/new or session/load. `conductorBridge` passes the policy to `applyConductorToolPolicy(plan, engine, policy)`; AI functions pass none and stay restricted
- **Per engine** (`applyWorkspacePolicy` in `src/main/agents/drivers/acp/conductorToolPolicy.ts`):
  - Claude — native tools on (no `tools`), `settingSources: ['user']`, no `strictMcpConfig` and no `mcpServers` override, `agents: {}`, the `claude_code` preset with the instructions appended; approval forced to `ask` (`approval` in the Claude launcher)
  - Codex — `prepareCodexWorkspacePolicy` in `codexConductorPolicy.ts` seals the launcher's own plan (user `~/.codex` config and MCPs included) only on the verified CLI version and patched adapter, with `INITIAL_AGENT_MODE=workspace-write` and the Default collaboration mode; never the `agent` mode, whose automatic reviewer would approve for the user. `applyWorkspacePolicy` throws for an unsealed Codex plan. The process runs with a different spec key than the restricted chats, so `prepareAiFunctionRuntime` does not wait on it
  - Antigravity — the conductor `enabledTools` is dropped and `disabledTools` is the launcher's sealed-folder denylist (`schedule`, `start_subagent`); session cwd is the chat's folder; `antigravitySharedHome(processFolder, workspace)` puts a Workspace chat's home in `~workspace-homes` (contract `antigravity.policy.workspace-cwd`)
  - OpenCode — `chatRuntimePermissions('workspace')` in `src/main/engine/configGenerator.ts`: `'*': 'ask'` first (last match wins, so a miss asks), then `read` allow, `external_directory` ask, Cinna's tools allowed. Answers stay once; the desktop keeps Always allow per chat. Contract `opencode.policy.workspace-session-scope`
- **Grants.** `chatConductorService.runtime` → `grantsFor`: Workspace only; reads and writes `desktopStateService` under `conductorGrantKey` (owner, runtime agent id, `chat-runtime:<chatId>`), `rememberScope: 'chat'`. `acpDriver.answerPermission` skips the "chat-owned may only be asked about Cinna's tools" rejection for a Workspace chat and tags the request `rememberScope: 'chat'`, which `PermissionRequestBlock` renders as "this chat". Deleted by `chatConductorService.remove` (`desktopStateService.removeExternal`)
- **Tools sync.** `runExecutionService.resolveAndRun` calls `chatConductorService.syncToolPolicy` at the start of a turn for a chat that already has its runtime; it compares the mode's (or the effective default's) policy with the captured one, and on a difference refreshes the row and releases the chat's sessions (`releaseChatSessions`). `hasWorkspace(chat)` reports the *captured* policy and feeds `chat:get`'s `workspace`, so Open Chat Folder follows what the chat runs on, not what its mode says now
- **Attachments.** `attachmentUploadsDir` (`drivers/index.ts`) returns `chatUploadsDir(folder)` (`agentUploads.ts`) for a Workspace chat, null (inline text) for other chat runtimes
- **Lifecycle.** `chatRemoval` (permanent delete) and `chatService` Empty Trash call `chatConductorService.remove`, which deletes folder, grants and runtime row; soft delete touches none of them
- **Run commands.** `agentWorkspaceFolder` returns null for any chat conductor, so a message's Run resolves to `not_local` in a Workspace chat
- **Contract entries** are `<engine>.policy.workspace-*` in `src/main/agents/drivers/acp/contracts/`; the generated tables are in `docs/agents/local_agents/contracts/`. An engine joins `WORKSPACE_POLICY_ENGINES` only behind them
