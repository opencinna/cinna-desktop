# Settings — Technical Details

## File Locations

### Renderer — Components

- `src/renderer/src/components/settings/SettingsPage.tsx` — Shell component: reads `settingsTab`, renders section title (`sectionTitles`) and active section
- `src/renderer/src/components/settings/SettingsLayout.tsx` — The section/card/row/status primitives a tab is built from (`SettingsSection`, `SettingsCard`, `SettingsRows`/`SettingsRow`, `SettingsLabel`/`SettingsHint`, `SettingsStatusRow`, `SettingsButton`/`SettingsAddButton`/`SettingsIconButton`/`SettingsBadge`, `settingsInputClass`), plus `useDialogChrome` — the shared modal behaviour (initial focus, Escape and outside-click dismissal, both suppressed while a write is pending). Local Agents is the first caller; see [UI Guidelines](../../development/ui_guidelines/ui_guidelines_llm.md) for the pattern and the settings type scale
- `src/renderer/src/components/settings/LLMSettingsSection.tsx` — LLM providers list + add-provider form toggle (Default scope: user-created providers only)
- `src/renderer/src/components/settings/MCPSettingsSection.tsx` — MCP providers list + add-remote form + add-local button; contains private `AddRemoteMcpForm`
- `src/renderer/src/components/settings/LLMProviderCard.tsx` — Expandable card: enable/disable, default toggle, API key management, model selection. Switching **off** raises `DisableCredentialDialog` when a chat mode or folder agent depends on the credential; a standing line under the controls counts what is inactive for as long as it is off
- `src/renderer/src/components/settings/DisableCredentialDialog.tsx` — that confirm, built on `useDialogChrome` (focus on Cancel, dismissal ignored while the write runs) plus `describeDependents()`, the counted form the card's line uses
- `src/renderer/src/components/settings/LLMProviderForm.tsx` — New provider wizard: type selection → API key → model picker
- `src/renderer/src/components/settings/MCPProviderCard.tsx` — Expandable card: transport config, env vars, connect/disconnect, tools list
- `src/renderer/src/components/settings/AgentsSettingsSection.tsx` — Agents list + add-agent form toggle
- `src/renderer/src/components/settings/AgentCard.tsx` — Expandable card: agent details, access token, test connection
- `src/renderer/src/components/settings/A2AAgentForm.tsx` — New agent wizard: card URL fetch → save
- `src/renderer/src/components/settings/ChatModesSection.tsx` — Chat modes list + add-mode form toggle
- `src/renderer/src/components/settings/ChatModeCard.tsx` — Expandable card: name, color, provider/model, MCP bindings
- `src/renderer/src/components/settings/ChatModeForm.tsx` — New chat mode form: name, color, provider, MCP selection
- `src/renderer/src/components/settings/UserAccountsSection.tsx` — User accounts list with expandable cards per user
- `src/renderer/src/components/settings/FeaturesSettingsSection.tsx` — Opt-in toggles in two titled sections (AI Functions, Interface); see [Auto Chat Titles](../../chat/auto_titles/auto_titles.md)
- `src/renderer/src/components/settings/DevelopmentSettingsSection.tsx` — Two sections: **About** (repository and website links) and the force-onboarding arming toggle (`isForceOnboardingArmed` / `setForceOnboarding` in `constants/onboarding`, localStorage-backed — not an `app_settings` key)
- `src/renderer/src/components/settings/LocalAgentsSettingsSection.tsx` — Agent Folders, Engine Settings and Developer Tools; see [Agents Tab](../../agents/local_agents/agents_tab.md)
- `src/renderer/src/components/settings/AgentsRootGit.tsx` — The per-root update check rendered inside an Agent Folders row; see [Agents Folder Updates](../../agents/local_agents/folder_updates.md)
- `src/renderer/src/components/settings/LocalDevSettingsSection.tsx` — Every phase of `LocalDevState`, with Set up / Repair / Add to PATH / Reset consent; see [Local Development](../../agents/local_dev/local_dev.md)
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
- `src/renderer/src/hooks/useEngine.ts` — Engine state, start and stop
- `src/renderer/src/hooks/useLocalDev.ts` — `LocalDevState` for the Local Development tab (main owns the reconciler; the tab renders state and never derives it)
- `src/renderer/src/hooks/useCatalog.ts` — Bundle catalog listing and install/uninstall
- `src/renderer/src/hooks/useSync.ts` — Cloud Sync state and device pairing

## State Management

### UI Store (`ui.store.ts`)

| State | Type | Default | Purpose |
|-------|------|---------|---------|
| `activeView` | `'chat' \| 'settings'` | `'chat'` | Controls sidebar mode and main content |
| `settingsTab` | `SettingsMenu` (15 members — see `ui.store.ts`) | `'chats'` | Active settings section |

`SettingsMenu` is the single source of truth for the tab ids; `sectionTitles` in `SettingsPage.tsx` must give every member a title, or the `sectionTitles[settingsTab]` lookup fails to compile. `PROFILE_SCOPE_TABS` lists the five profile-scope members and drives the sidebar's stale-tab guard.

### Section Reset on Tab Switch

Each section is rendered with a `key` prop matching the tab ID. Switching tabs unmounts the previous section, destroying all local `useState` (open forms, expanded cards, partial input).

## Renderer Components

### Sidebar Settings Menu (`Sidebar.tsx`)

Two static arrays, rendered under their group headers by the shared `renderMenuButton`.

`defaultMenuItems`:
- `{ id: 'chats', label: 'Chats', icon: MessageSquare }`
- `{ id: 'agents', label: 'Agents', icon: Bot }`
- `{ id: 'local-agents', label: 'Local Agents', icon: FolderCog }`
- `{ id: 'local-dev', label: 'Local Development', icon: TerminalSquare }`
- `{ id: 'llm', label: 'AI Credentials', icon: Sparkles }`
- `{ id: 'mcp', label: 'MCP Providers', icon: Plug }`
- `{ id: 'accounts', label: 'User Accounts', icon: Users }`
- `{ id: 'features', label: 'Features', icon: SlidersHorizontal }`
- `{ id: 'development', label: 'Development', icon: Wrench }`

`profileMenuItems` (rendered only when `showProfileGroup = isCinnaUser && !!profileLabel`):
- `{ id: 'profile-chats', label: 'Chats', icon: MessageSquare }`
- `{ id: 'profile-agents', label: 'Remote Agents', icon: Bot }`
- `{ id: 'profile-llm', label: 'AI Credentials', icon: Sparkles }`
- `{ id: 'profile-catalog', label: 'Catalog', icon: Package }`
- `{ id: 'profile-sync', label: 'Cloud Sync', icon: Cloud }`

`'trash'` is not in either array — it is a separate footer button below a separator.

Active item highlighted with `bg-[var(--color-bg-tertiary)]`. Back button calls `setActiveView('chat')`. An effect snaps `settingsTab` back to `'chats'` when the profile group disappears while a `PROFILE_SCOPE_TABS` member is selected.

### SettingsPage (`SettingsPage.tsx`)

Thin shell — looks the title up in `sectionTitles`, then conditionally renders one of the fourteen section components (`AgentsSettingsSection` serves two tabs via its `scope` prop). Each is given a `key` equal to its tab id, which is what makes a tab switch a remount.

### LLMSettingsSection (`LLMSettingsSection.tsx`)

- Lists providers from `useProviders()` as `LLMProviderCard` instances
- Local state `showAddLLM` toggles `LLMProviderForm` visibility

### MCPSettingsSection (`MCPSettingsSection.tsx`)

- Lists providers from `useMcpProviders()` as `MCPProviderCard` instances
- Local state `showAddRemoteMcp` toggles inline `AddRemoteMcpForm`
- "Add Local MCP" button directly creates a disabled stdio provider via `useUpsertMcpProvider()`

## IPC Channels

Settings components interact with these IPC channels via `window.api.*`. The list below covers the tabs documented here; the tabs with their own feature docs carry their own channel lists — `window.api.localAgents.*` / `localTools.*` / `engine.*` in [Agents Tab](../../agents/local_agents/agents_tab_tech.md), `localDev.*` in [Local Development](../../agents/local_dev/local_dev.md), `catalog.*` in [Bundles Catalog](../../agents/bundles_catalog/bundles_catalog.md) and `sync.*` in [Data Sync](../../sync/data_sync/data_sync.md).

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
- `settings.set(key, value)` — Update one setting; throws `AppSettingsError` (`invalid_key` / `invalid_value`) on validation failure. Backs the Features tab toggles; see [Auto Chat Titles](../../chat/auto_titles/auto_titles.md) for the schema-update pattern.
