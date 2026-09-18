# Settings — Technical Details

## File Locations

### Renderer — Components

- `src/renderer/src/components/settings/SettingsPage.tsx` — Shell component: reads `settingsTab`, renders section title (`sectionTitles`) and active section
- `src/renderer/src/components/settings/SettingsLayout.tsx` — The section/card/row/status primitives a tab is built from (`SettingsSection`, `SettingsCard`, `SettingsRows`/`SettingsRow`, `SettingsLabel`, `SettingsInfoTip`, `SettingsToggleRow`, `SettingsHint`, `SettingsStatusRow`, `SettingsButton`/`SettingsAddButton`/`SettingsIconButton`/`SettingsBadge`, `settingsInputClass`), plus `useDialogChrome` — the shared modal behaviour (initial focus, Escape and outside-click dismissal, both suppressed while a write is pending). `SettingsLabel`'s `info` prop puts a control's standing explanation behind a `SettingsInfoTip` beside the label, named `About <label>`; the prop type is a union, so a label that is not a plain string must name its tip through `infoLabel` rather than fall back to a generic name. `SettingsToggleRow` is a one-line row for a `SettingsRows` list — label, tip and `role="switch"` — with `id` required so the label names the switch and `title` carrying the branching state sentence. `SettingsHint` is one line of live value, never standing prose. The Default Agents, Features and Development tabs are built from these, and Local Development puts a `SettingsInfoTip` on its own section title; see [UI Guidelines](../../development/ui_guidelines/ui_guidelines_llm.md) for the pattern and the settings type scale
- `src/renderer/src/components/settings/LLMSettingsSection.tsx` — LLM providers list + add-provider form toggle (Default scope: user-created providers only)
- `src/renderer/src/components/settings/MCPSettingsSection.tsx` — MCP providers list + add-remote form + add-local button; contains private `AddRemoteMcpForm`
- `src/renderer/src/components/settings/LLMProviderCard.tsx` — Expandable card: enable/disable, default toggle, API key management, model selection. Switching **off** raises `DisableCredentialDialog` when a chat mode or folder agent depends on the credential; a standing line under the controls counts what is inactive for as long as it is off
- `src/renderer/src/components/settings/DisableCredentialDialog.tsx` — that confirm, built on `useDialogChrome` (focus on Cancel, dismissal ignored while the write runs) plus `describeDependents()`, the counted form the card's line uses
- `src/renderer/src/components/settings/LLMProviderForm.tsx` — New provider wizard: type selection → API key → model picker
- `src/renderer/src/components/settings/MCPProviderCard.tsx` — Expandable card: transport config, env vars, connect/disconnect, tools list
- `src/renderer/src/components/settings/AgentsSettingsSection.tsx` — Profile-only Cinna visibility rows (including hidden agents), grouped by `serverLabel`, plus sync and reauthentication; has no scope prop or direct-connection creation
- `src/renderer/src/components/settings/AgentCard.tsx` — A2A/Cinna connection details, Authentication and Connection test sections; `connectionOnly` omits the expandable header, skills and agent-wide controls for the external page
- `src/renderer/src/components/settings/A2AAgentForm.tsx` — Portaled Add A2A Agent dialog launched by the sidebar Add an agent flow: card URL + optional token, optional card test, save. Labels use `useId`; token visibility has an accessible name. Escape/outside click/Cancel cannot dismiss a pending save; returned failures and thrown errors leave the dialog open.
- `src/renderer/src/components/settings/ChatModesSection.tsx` — Chat modes list + add-mode form toggle
- `src/renderer/src/components/settings/ChatModeCard.tsx` — Expandable card: name, color, provider/model, MCP bindings
- `src/renderer/src/components/settings/ChatModeForm.tsx` — New chat mode form: name, color, provider, MCP selection
- `src/renderer/src/components/settings/UserAccountsSection.tsx` — User accounts list with expandable cards per user
- `src/renderer/src/components/settings/FeaturesSettingsSection.tsx` — Controls in two titled sections (AI Functions, Interface), each one `SettingsRows` list. Interface starts with a labeled System/Dark/Light button group and Extra UI animation switch wired directly to `useUIStore`; they remain enabled while service settings load or fail. Other feature switches use `SettingsToggleRow` and `useAppSettings`. Reset hints is a row of its own under Show hints, present only while hints are on. A failed settings read is said once, as the last row of the last list: service-backed switches read the same query, and a copy under each label moved every switch down when it arrived. Save errors use `unwrapIpcError` and a final `role="alert"` row; `Unknown app setting:` gets restart guidance, other failures retain their reason. The Interface list includes `showAgentSidebarSections` (default on). See [Auto Chat Titles](../../chat/auto_titles/auto_titles.md)
- `src/renderer/src/components/settings/DevelopmentSettingsSection.tsx` — Two sections: **About** (repository and website links) and **Testing**, one `SettingsToggleRow` that arms force-onboarding (`isForceOnboardingArmed` / `setForceOnboarding` in `constants/onboarding`, localStorage-backed — not an `app_settings` key)
- `src/renderer/src/components/settings/LocalAgentsSettingsSection.tsx` — Agent Folders, Runtime and Tasks; see [Agents Tab](../../agents/local_agents/agents_tab.md). Owns `ManagedCliAction`, the one text action beside a managed CLI's status line: *Install now*, *Try again*, or *Fix path* (opens the `local-dev` settings menu) when a saved path failed
- `src/renderer/src/components/settings/RootRepositoryDialog.tsx` — The Repository dialog opened from an Agent Folders row: remote, branches, head commit, Check and Update; see [Agents Folder Updates](../../agents/local_agents/folder_updates.md)
- `src/renderer/src/components/settings/LocalDevSettingsSection.tsx` — Shared managed CLI readout and Add to PATH; see [Local Development](../../agents/local_dev/local_dev.md)
- `src/renderer/src/components/settings/ProfileLocalDevSettingsSection.tsx` — Every account phase, workspace setup/repair/opening and shared server consent; keyed by account ID
- `src/renderer/src/components/settings/DeveloperToolsSettingsSection.tsx` — Shared tools table with managed Cinna precedence and Update, resolved engine OpenCode row, managed Codex and Claude Code rows (`useCodexBinary` / `useClaudeBinary` through `codexToolCell` / `claudeToolCell`, never PATH detection), contract version, `OpenCodeSettingsFields`, `CodexSettingsFields` and `ClaudeSettingsFields`. It renders no failure paragraphs of its own: each runtime's failure is under its path field
- `src/renderer/src/components/settings/RuntimePathField.tsx` — The one "explicit executable path" field, for `localAgentsEnginePath`, `localAgentsCodexPath` and `localAgentsClaudePath`: independent dirty/empty draft, inline failure, Escape discard, `stacked` for a field directly under another, and — below the save error in precedence — the bound binary's `failed` sentence in its Path-field wording (`pathError ?? error`: *"… — fix or clear it."*, never a redirect to the tab it is on), truncated to one line with the full text in `title`. No pending note: main re-resolves every runtime when its path is saved
- `src/renderer/src/components/settings/OpenCodeSettingsFields.tsx`, `CodexSettingsFields.tsx` and `ClaudeSettingsFields.tsx` in the same directory — Installation-wide executable overrides over that field. The Codex and Claude tips state that the override is unverified; OpenCode's tip says *"Cinna checks the file as soon as you save the path."*
- `src/renderer/src/components/settings/managedCliStatus.ts` — Pure text for a managed CLI (`CODEX_CLI`, `CLAUDE_CLI`): the Runtime status line, the picker sub-line and the Developer Tools cell, one module so the three surfaces — and the two CLIs — cannot disagree about a configured path. `codexStatus.ts` and `claudeStatus.ts` are that module applied to one CLI. Sizes are floored from the state's `assetBytes`; Codex keeps binary megabytes, Claude uses decimal, because 215,643,408 bytes is "215 MB" to its vendor and to Finder
- `src/renderer/src/components/settings/TaskConcurrencySetting.tsx` — Default → Agents → Tasks row; device-wide admission limit
- `src/renderer/src/components/settings/ProfileChatModesSection.tsx` — Account-provisioned chat modes (Profile scope), off the same `useChatModes` hook as the Default tab
- `src/renderer/src/components/settings/ProfileLLMSection.tsx` — Account-provisioned (managed) providers (Profile scope)
- `src/renderer/src/components/settings/CatalogSettingsSection.tsx` — Bundle catalog install/uninstall; see [Bundles Catalog](../../agents/bundles_catalog/bundles_catalog.md)
- `src/renderer/src/components/settings/CloudSyncSettingsSection.tsx` — Device pairing and sync state; see [Data Sync](../../sync/data_sync/data_sync.md)
- `src/renderer/src/components/settings/TrashSection.tsx` — Deleted chats management

### Renderer — Shared UI

- `src/renderer/src/components/ui/AnimatedCollapse.tsx` — Animated height/opacity transition wrapper for expandable content

### Renderer — Layout Integration

- `src/renderer/src/components/layout/Sidebar.tsx` — Sidebar switches between chat-list mode and settings-menu mode based on `activeView`
- `src/renderer/src/components/layout/MainArea.tsx` — Routes to `SettingsPage` when `activeView === 'settings'`

### Renderer — State & Hooks

- `src/renderer/src/stores/ui.store.ts` — Zustand store: `activeView`, `settingsTab`, `sidebarOpen`, `theme`
- `src/renderer/src/hooks/useProviders.ts` — React Query hooks for LLM provider CRUD and key testing
- `src/renderer/src/hooks/useMcp.ts` — React Query hooks for MCP provider CRUD and connection management
- `src/renderer/src/hooks/useAgents.ts` — React Query hooks for agent CRUD and testing
- `src/renderer/src/hooks/useChatModes.ts` — React Query hooks for chat mode CRUD
- `src/renderer/src/hooks/useAuth.ts` — React Query hooks for user account management
- `src/renderer/src/hooks/useAppSettings.ts` — React Query hooks for the `app_settings` KV store (`useAppSettings` read, `useSetAppSetting` write with optimistic update + rollback)
- `src/renderer/src/hooks/useLocalAgents.ts` — Roots and folder agents: list, rescan, add/remove root, restore hidden, and the git status/check/update hooks
- `src/renderer/src/hooks/useLocalTools.ts` — Detected assistants and editors, the default-tool value and `openIn`
- `src/renderer/src/hooks/useEngine.ts` — Read-only engine binary state and explicit resolution/retry
- `src/renderer/src/hooks/useLocalDev.ts` — Main-owned `LocalDevState`, the independent `managed-local-dev-cli` query refetched on phase changes, PATH mutation with rejected IPC errors converted to inline refusals, and profile-keyed `useCinnaCliUpdate` / shared-key `useUpdateCinnaCli`
- `src/renderer/src/hooks/useCatalog.ts` — Bundle catalog listing and install/uninstall
- `src/renderer/src/hooks/useSync.ts` — Cloud Sync state and device pairing

## State Management

### UI Store (`ui.store.ts`)

| State | Type | Default | Purpose |
|-------|------|---------|---------|
| `activeView` | `ActiveView` (see UI store) | `'chat'` | Controls sidebar mode and main content |
| `settingsTab` | `SettingsMenu` (15 members — see `ui.store.ts`) | `'chats'` | Active settings section |

`SettingsMenu` is the single source of truth for the tab ids; `sectionTitles` in `SettingsPage.tsx` must give every member a title, or the `sectionTitles[settingsTab]` lookup fails to compile. `PROFILE_SCOPE_TABS` lists the six profile-scope members and drives the sidebar's stale-tab guard.

### Section Reset on Tab Switch

Each section is keyed by tab ID, except Profile Local Development, which uses the active account ID and therefore also resets on account changes. Switching tabs unmounts the previous section, destroying all local `useState` (open forms, expanded cards, partial input).

## Renderer Components

### Sidebar Settings Menu (`Sidebar.tsx`)

Two static arrays, rendered under their group headers by the shared `renderMenuButton`.

`defaultMenuItems`:
- `{ id: 'chats', label: 'Chats', icon: MessageSquare }`
- `{ id: 'local-agents', label: 'Agents', icon: FolderCog }`
- `{ id: 'local-dev', label: 'Local Development', icon: TerminalSquare }`
- `{ id: 'llm', label: 'AI Credentials', icon: Sparkles }`
- `{ id: 'mcp', label: 'MCP Providers', icon: Plug }`
- `{ id: 'accounts', label: 'User Accounts', icon: Users }`
- `{ id: 'features', label: 'Features', icon: SlidersHorizontal }`
- `{ id: 'development', label: 'Development', icon: Wrench }`

`profileMenuItems` (rendered only when `showProfileGroup = isCinnaUser && !!profileLabel`):
- `{ id: 'profile-chats', label: 'Chats', icon: MessageSquare }`
- `{ id: 'profile-agents', label: 'Agents', icon: Waypoints }`
- `{ id: 'profile-local-dev', label: 'Local Development', icon: TerminalSquare }`
- `{ id: 'profile-llm', label: 'AI Credentials', icon: Sparkles }`
- `{ id: 'profile-catalog', label: 'Catalog', icon: Package }`
- `{ id: 'profile-sync', label: 'Cloud Sync', icon: Cloud }`

`'trash'` is not in either array — it is a separate footer button below a separator.

Active item highlighted with `app-nav-active`. Back button calls `setActiveView('chat')`. An effect snaps `settingsTab` back to `'chats'` when the profile group disappears while a `PROFILE_SCOPE_TABS` member is selected.

### SettingsPage (`SettingsPage.tsx`)

Thin shell — looks the title up in `sectionTitles`, then conditionally renders one of the fifteen section components (`LocalAgentsSettingsSection` renders Default Agents; `AgentsSettingsSection` renders Profile Agents only). Tab switches remount their sections; Profile Local Development also remounts when the account ID changes.

### LLMSettingsSection (`LLMSettingsSection.tsx`)

- Lists providers from `useProviders()` as `LLMProviderCard` instances
- Local state `showAddLLM` toggles `LLMProviderForm` visibility

### MCPSettingsSection (`MCPSettingsSection.tsx`)

- Lists providers from `useMcpProviders()` as `MCPProviderCard` instances
- Local state `showAddRemoteMcp` toggles inline `AddRemoteMcpForm`
- "Add Local MCP" button directly creates a disabled stdio provider via `useUpsertMcpProvider()`

### Managed Cinna CLI controls

`DeveloperToolsSettingsSection` overlays the detected `cinna` row with `useManagedLocalDevCli` path/version/source whenever a managed installation is returned; nullable version stays unknown rather than borrowing the shell version. Without managed data it retains the detection result. `useCinnaCliUpdate` keys by profile ID with 60-second staleness and no retries. Refresh triggers detection, managed inspection and update-query refetch together. `useUpdateCinnaCli` invalidates update status, managed CLI, local tools and development context on settlement.

`useIsMutating({ mutationKey: ['update-cinna-cli'] })` supplies shared pending state. Refresh disables during its queries or an update; Update disables during update or local-development installation. The row renders the advertised server target and a spinning **Updating…** action, with status/error text below the table. These are stage indicators, not download percentages. Service eligibility, serialized tool writes, consent preservation and profile checks live in [Local Development technical details](../../agents/local_dev/local_dev_tech.md#managed-cli-updates-and-fresh-checks).

Build compatibility recovery calls `setSettingsMenu('local-dev')` then `setActiveView('settings')`, selecting Default tools even if Profile setup was previously selected. Its separate account-setup action uses `profile-local-dev`; runtime blockers stay in build details. `DevelopmentRecheckButton` shares `SettingsButton`, including `aria-busy`, and invokes the fresh context path from both build surfaces; see [Build Sessions renderer](../../agents/local_dev/build_sessions_tech.md#renderer-components).

### Agent page settings

`src/renderer/src/components/agents/ExternalAgentPage.tsx` owns the page's Overview/Connection tab and shared chat/settings mode. A2A/Cinna uses `AgentCard connectionOnly` for visible structured fields, authentication and connection testing. ACP and Managed agents use Configure to open their existing dialogs. Agent-wide disable/delete/uninstall actions belong to `ExternalAgentActionsMenu` in the page header. This page mode is independent of `settingsTab`; hiding its composer preserves mounted state, and the session draft store also restores content after navigating away and remounting. App-settings tab changes still unmount their previous section. See [Shared chat workspace](../app_shell/app_shell_tech.md#shared-chat-workspace).

### Grouped rows and control placement

`SettingsRows insetDividers` adds 16 px horizontal group padding and removes child horizontal padding, aligning row dividers with their content. Features AI Functions/Interface and Agents Runtime/Tasks use it; root lists retain their existing full-width dividers. `settingsDropdownRowClass` puts compact selectors in the rightmost 33% column; `settingsControlRowClass` divides label and text input evenly. These are layout primitives, not new persistence behavior.

Default → Agents keeps default-runtime choice buttons and the selected-runtime status arrangement. Credential and Open agents with selectors occupy the right column in subsequent Runtime rows, with the auto-open checkbox below its selector. Task concurrency has its own Tasks section. Add an agents folder is a compact secondary button beside Rescan in the Agent Folders heading. Shared `SettingsButton` styling also governs Repair, Reset consent, Add to PATH, CLI Update and build Check again. Its optional `aria-busy` passes pending state to assistive technology. `aria-disabled` provides the same unavailable appearance while retaining keyboard focus, and the shared click handler suppresses invocation when it is true. Composer readiness actions use that option with the same sizing/background/border, a refresh icon and short pending feedback; see [Readiness presentation](../../agents/drivers/drivers_tech.md#readiness-and-renderer-behavior). Native `disabled` remains available to other callers. Its `ambient-button` class opts enabled, visible secondary actions into the Shell scheduler; the scheduler owns eligibility and at-most-one selection. See [Appearance technical details](../appearance/appearance_tech.md).

## Database Schema

The section preference adds an installation-wide `app_settings` key, not a profile column or new table. `src/shared/appSettings.ts` types `showAgentSidebarSections`; `src/main/db/appSettings.ts` supplies `true` for missing values. Existing agent repositories/configuration own saved connections and visibility overrides; see [Agents](../../agents/agents/agents_tech.md).

## Configuration

`showAgentSidebarSections` is a boolean and defaults to true. `useAppSettings` reads it for Features and the Agents list; `useSetAppSetting` optimistically updates the cache and restores the previous snapshot on failure. Service-backed settings controls disable while loading or writing. Theme and Extra UI animation use independent renderer localStorage keys through `useUIStore`, with no `app_settings` keys or query dependency; the animation preference also gates `ChatTransition`, while drafts/context actions have no settings. Defaults and cross-window propagation are defined in [Appearance](../appearance/appearance_tech.md#configuration). The restart message is triggered by the actual unknown-key error; it does not diagnose every failed switch as an old backend.

## Security

Local Development placement does not change consent storage: `localDevConsent` remains installation-wide JSON keyed by server host. `localdev:get-managed-cli` is an ungated read-only path/version probe; account actions, CLI update discovery/installation and Add to PATH still require activation. Update resolves the active server target in main and cannot answer setup consent or create account workspaces. Account state/action reply ownership is enforced by the [local-development lifecycle](../../agents/local_dev/local_dev_tech.md#services--key-methods). Connection fields reuse existing typed preload APIs. The A2A modal accepts a token for main-process storage; saved secret values are not loaded into its fields. Cinna rows retain profile-scoped ownership and expose visibility controls only for server-provided agents. Agent-page connection tooltips display only host, auth method/presence and credential names; see [Routing details](../../chat/chat_routing/chat_routing_tech.md#renderer-components).

## IPC Channels

Settings components interact with these IPC channels via `window.api.*`. The list below covers the tabs documented here; the tabs with their own feature docs carry their own channel lists — `window.api.localAgents.*` / `localTools.*` / `engine.*` in [Agents Tab](../../agents/local_agents/agents_tab_tech.md) (the `home-state` / `home-grant` / `home-choose` channels behind Default Agents' recovery row are in [The Agents Folder Question](../../agents/local_agents/home_access_tech.md)), `localDev.*` in [Local Development](../../agents/local_dev/local_dev.md), `catalog.*` in [Bundles Catalog](../../agents/bundles_catalog/bundles_catalog.md) and `sync.*` in [Data Sync](../../sync/data_sync/data_sync.md).

### LLM Providers (`window.api.providers.*`)

- `providers.list()` — Fetch all configured providers
- `providers.upsert(data)` — Create or update provider
- `providers.delete(providerId)` — Delete provider
- `providers.test(providerId)` — Test saved provider connection
- `providers.testKey({ type, apiKey })` — Validate API key before saving

### MCP Providers (`window.api.mcp.*`)

- `mcp.list()` — Fetch all configured MCP servers (2s polling during `awaiting-auth`)
- `mcp.upsert(data)` — Create or update MCP server config
- `mcp.delete(providerId)` — Delete MCP server
- `mcp.connect(providerId)` — Connect to MCP server
- `mcp.disconnect(providerId)` — Disconnect from MCP server

### App Settings (`window.api.settings.*`)

- `settings.getAll()` — Snapshot of every known key with defaults applied for missing rows (returns `AppSettingsSchema`)
- `settings.set(key, value)` — Update one setting; throws `AppSettingsError` (`invalid_key` / `invalid_value`) on validation failure. Backs service-owned Features toggles; renderer appearance uses its UI store directly; see [Auto Chat Titles](../../chat/auto_titles/auto_titles.md) for the schema-update pattern.

## Runtime conductor settings

`FeaturesSettingsSection.tsx` persists defaultMultiAgentRouting (human/coordinator, default human), aiFunctionsCredentialId and aiFunctionsModelId (empty by default). Changing the credential clears the model. `ChatModeRuntimeFields.tsx` shares runtime/policy/instruction controls across mode forms; `ChatModesSection.tsx` uses SettingsSection and a title-level Add action. `engine:model-catalog(engine)` returns RuntimeModelCatalog scoped to the activated profile without probing/spawning; model names originate from ACP session metadata.
