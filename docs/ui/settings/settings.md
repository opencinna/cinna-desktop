# Settings

## Purpose

Settings screen for managing chat modes, agents (local A2A, folder agents and remote), AI credentials, MCP server connections, the local development toolchain, user accounts and cloud sync. Accessed from the sidebar, which transforms into a vertical settings navigation menu split into two scope groups — see [Settings Scope](../../core/settings_scope/settings_scope.md).

## Core Concepts

- **Settings View** — A dedicated app view (`activeView: 'settings'`) that replaces the chat interface
- **Settings Tab** — A sub-section within settings, selected from the sidebar menu. The union is `SettingsMenu` in `ui.store.ts`, and `sectionTitles` in `SettingsPage.tsx` gives every member a title; the two are kept in step by hand, so a tab added to one and not the other is a compile error on the title lookup. Fifteen members today: `'chats' | 'llm' | 'mcp' | 'agents' | 'local-agents' | 'local-dev' | 'accounts' | 'features' | 'development' | 'profile-agents' | 'profile-chats' | 'profile-llm' | 'profile-catalog' | 'profile-sync' | 'trash'`
- **Default Group** — Sidebar section labeled "Default" containing the machine-local settings, in menu order: Chats, Agents, Local Agents, Local Development, AI Credentials, MCP Providers, User Accounts, Features, Development. Always visible. "Machine-local" is the rule that puts Local Agents here rather than in the Profile group — the agents home follows the machine, not whoever is signed in.
- **Profile Group** — Sidebar section labeled "Profile {displayName}" containing profile-bound settings, in menu order: Chats, Remote Agents, AI Credentials, Catalog, Cloud Sync. Only rendered when the active profile has profile-scope content (`showProfileGroup = isCinnaUser && !!profileLabel` in `Sidebar.tsx`), so today: Cinna users only. Cinna re-authentication is not a standalone menu item — it lives on the account's card in Settings → User Accounts.
- **Sidebar Menu Mode** — When settings are active, the sidebar replaces the chat list with the two-group vertical settings menu plus a footer "Trash" entry.

> **UI naming note:** The settings section for LLM providers (the `'llm'` / `'profile-llm'` tab) is labeled **"AI Credentials"** in the UI — in the sidebar menu item, the page title, and the "Add AI Credentials" button. "LLM Provider" is the canonical/technical name used in code (`useProviders`, `LLMProviderCard`, the `providers` store) and throughout these docs; "AI Credentials" is just the friendlier user-facing label (matching CinnaCore). They are the same thing. The sidebar menu item itself reads **AI Credentials** in both groups; "LLM Providers" survives only in code and in the technical docs.

## User Stories / Flows

### Entering Settings

1. User clicks the avatar in the sidebar footer to open the profile dropdown
2. User clicks the "Settings" entry in the dropdown
3. Sidebar transforms: chat list replaced by settings menu with "Back" button, a "Default" header followed by the machine-local menu items (Chats, Agents, Local Agents, Local Development, AI Credentials, MCP Providers, User Accounts, Features, Development), and — for Cinna users — a "Profile {name}" header followed by the profile-bound items (Chats, Remote Agents, AI Credentials, Catalog, Cloud Sync). A separator + "Trash" entry sits at the bottom.
4. Main content area shows the active settings section (Chat Modes by default)

### Navigating Between Sections

1. User clicks a menu item in the sidebar (e.g., "MCP Providers")
2. Previous section unmounts completely — any open forms or unsaved input are discarded
3. New section renders fresh with default state

### Returning to Chat

1. User clicks "Back" arrow button at top of sidebar settings menu
2. Sidebar reverts to chat list mode
3. Main content area returns to active chat or welcome screen

## Business Rules

- Switching settings sections always resets the page — open forms, partial input, expanded cards are all discarded on navigation
- Settings is entered from the profile dropdown ("Settings" item); there is no dedicated Settings button in the sidebar footer
- A "Back" button replaces the chat list at the top of the sidebar while in settings view
- The Interface popover (Console / Verbose / Theme toggles) remains accessible from the sidebar footer regardless of view — see [App Shell](../app_shell/app_shell.md)
- Default settings tab is "Chat Modes" (`settingsTab: 'chats'`)
- Settings view state (`settingsTab`) persists across view switches — returning to settings reopens the last active section
- When the active profile loses access to a Profile-scope tab (e.g. user signs out of a Cinna account while `settingsTab === 'profile-agents'`), the sidebar auto-resets the selection to `'chats'` so no orphaned menu item is highlighted. `PROFILE_SCOPE_TABS` in `ui.store.ts` is the guard's list — all five profile tabs (`profile-agents`, `profile-chats`, `profile-llm`, `profile-catalog`, `profile-sync`). A profile tab added to the union but not to that array leaves the sidebar highlighting a menu item the group no longer renders

## Architecture Overview

```
UserMenu (profile dropdown in sidebar footer)
  └── "Settings" → setActiveView('settings')

Sidebar (settings menu mode)
  ├── Back button → setActiveView('chat')
  ├── "Default" header (defaultMenuItems in Sidebar.tsx)
  │     └── 'chats' | 'agents' | 'local-agents' | 'local-dev' | 'llm' | 'mcp' | 'accounts' | 'features' | 'development'
  ├── "Profile {name}" header (profileMenuItems; Cinna users only)
  │     └── 'profile-chats' | 'profile-agents' | 'profile-llm' | 'profile-catalog' | 'profile-sync'
  └── (separator) → 'trash'

MainArea
  └── SettingsPage (shell)
        ├── Section title (sectionTitles[settingsTab])
        ├── ChatModesSection (when tab = 'chats')
        ├── LLMSettingsSection (when tab = 'llm')
        ├── AgentsSettingsSection scope="default" (when tab = 'agents')
        ├── LocalAgentsSettingsSection (when tab = 'local-agents')
        ├── LocalDevSettingsSection (when tab = 'local-dev')
        ├── MCPSettingsSection (when tab = 'mcp')
        ├── UserAccountsSection (when tab = 'accounts')   # hosts the per-account password modal + Cinna re-auth button
        ├── FeaturesSettingsSection (when tab = 'features')
        ├── DevelopmentSettingsSection (when tab = 'development')
        ├── AgentsSettingsSection scope="profile" (when tab = 'profile-agents')
        ├── ProfileChatModesSection (when tab = 'profile-chats')
        ├── ProfileLLMSection (when tab = 'profile-llm')
        ├── CatalogSettingsSection (when tab = 'profile-catalog')
        ├── CloudSyncSettingsSection (when tab = 'profile-sync')
        └── TrashSection (when tab = 'trash')
```

Every section is rendered with a `key` equal to its tab id, which is what makes tab switching a remount rather than a re-render — see the reset rule under Business Rules.

## Integration Points

- **UI Store** — `activeView`, `settingsTab`, and the `PROFILE_SCOPE_TABS` constant drive sidebar mode, group rendering, and the stale-tab guard
- [Settings Scope](../../core/settings_scope/settings_scope.md) — defines which menu items belong to the Default vs Profile group
- [App Shell](../app_shell/app_shell.md) — Hosts the profile dropdown (settings entry) and the sidebar's settings-menu mode
- [Chat Modes](../../chat/chat_modes/chat_modes.md) — Chat modes section manages named presets
- [Auto Chat Titles](../../chat/auto_titles/auto_titles.md) — The Features tab hosts the "AI Functions" subsection where this opt-in toggle lives
- [Hints](../hints/hints.md) — The Features tab's "Interface" group hosts the `showHints` toggle and the "Reset hints" button that clears the localStorage retirement counters
- [Agents](../../agents/agents/agents.md) — Agents section (Default group) manages local A2A agent registrations
- [Local Agents](../../agents/local_agents/agents_tab.md) — Local Agents section: the registered agent folders, the local engine and its binary path, and the detected developer tools, in three titled sections
- [Local Development](../../agents/local_dev/local_dev.md) — Local Development section: the managed uv / cinna-cli / Mutagen toolchain, its consent and repair actions
- [Bundles Catalog](../../agents/bundles_catalog/bundles_catalog.md) — Catalog section (Profile group) installs and uninstalls bundles
- [Data Sync](../../sync/data_sync/data_sync.md) — Cloud Sync section (Profile group) manages device pairing and sync state
- [Remote Agents](../../agents/remote_agents/remote_agents.md) — Agents section (Profile group) lists Cinna-synced remote agents with per-profile enable/disable overrides
- [Adapters](../../llm/adapters/adapters.md) — LLM settings section manages provider configuration consumed by the adapter layer
- [MCP Connections](../../mcp/connections/connections.md) — MCP settings section manages server connections
- [User Accounts](../../auth/user_accounts/user_accounts.md) — Accounts section manages local user profiles
- [UI Guidelines](../../development/ui_guidelines/ui_guidelines_llm.md) — The settings type scale and the settings section pattern, with the shared `SettingsLayout` primitives (`SettingsSection`, `SettingsCard`, `SettingsRows`, `SettingsStatusRow`, `settingsInputClass`) a new tab is built from — Local Agents is the first caller, and the older tabs match the same scale with their own markup; expandable card pattern, button layout rules, color system
