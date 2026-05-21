# Settings

## Purpose

Settings screen for managing chat modes, agents, LLM providers, MCP server connections, and user accounts. Accessed from the sidebar, which transforms into a vertical settings navigation menu split into two scope groups — see [Settings Scope](../../core/settings_scope/settings_scope.md).

## Core Concepts

- **Settings View** — A dedicated app view (`activeView: 'settings'`) that replaces the chat interface
- **Settings Tab** — A sub-section within settings (`settingsTab: 'chats' | 'agents' | 'llm' | 'mcp' | 'accounts' | 'features' | 'development' | 'profile-agents' | 'trash'`), selected from the sidebar menu
- **Default Group** — Sidebar section labeled "Default" containing the shared settings (Chats, Agents, LLM Providers, MCP Providers, User Accounts, Features, Development). Always visible.
- **Profile Group** — Sidebar section labeled "Profile {displayName}" containing profile-bound settings. Only rendered when the active profile has profile-scope content (currently: Cinna users only, with a single "Agents" entry showing remote agents).
- **Sidebar Menu Mode** — When settings are active, the sidebar replaces the chat list with the two-group vertical settings menu plus a footer "Trash" entry.

## User Stories / Flows

### Entering Settings

1. User clicks the avatar in the sidebar footer to open the profile dropdown
2. User clicks the "Settings" entry in the dropdown
3. Sidebar transforms: chat list replaced by settings menu with "Back" button, a "Default" header followed by the shared menu items (Chats, Agents, LLM Providers, MCP Providers, User Accounts, Features, Development), and — for Cinna users — a "Profile {name}" header followed by the profile-only menu items (Agents). A separator + "Trash" entry sits at the bottom.
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
- When the active profile loses access to a Profile-scope tab (e.g. user signs out of a Cinna account while `settingsTab === 'profile-agents'`), the sidebar auto-resets the selection to `'chats'` so no orphaned menu item is highlighted (`PROFILE_SCOPE_TABS` in `ui.store.ts`)

## Architecture Overview

```
UserMenu (profile dropdown in sidebar footer)
  └── "Settings" → setActiveView('settings')

Sidebar (settings menu mode)
  ├── Back button → setActiveView('chat')
  ├── "Default" header
  │     └── Menu items → 'chats' | 'agents' | 'llm' | 'mcp' | 'accounts' | 'features' | 'development'
  ├── "Profile {name}" header (Cinna users only)
  │     └── Menu items → 'profile-agents'
  └── (separator) → 'trash'

MainArea
  └── SettingsPage (shell)
        ├── Section title (dynamic)
        ├── ChatModesSection (when tab = 'chats')
        ├── AgentsSettingsSection scope="default" (when tab = 'agents')
        ├── AgentsSettingsSection scope="profile" (when tab = 'profile-agents')
        ├── LLMSettingsSection (when tab = 'llm')
        ├── MCPSettingsSection (when tab = 'mcp')
        ├── UserAccountsSection (when tab = 'accounts')
        ├── FeaturesSettingsSection (when tab = 'features')
        ├── DevelopmentSettingsSection (when tab = 'development')
        └── TrashSection (when tab = 'trash')
```

## Integration Points

- **UI Store** — `activeView`, `settingsTab`, and the `PROFILE_SCOPE_TABS` constant drive sidebar mode, group rendering, and the stale-tab guard
- [Settings Scope](../../core/settings_scope/settings_scope.md) — defines which menu items belong to the Default vs Profile group
- [App Shell](../app_shell/app_shell.md) — Hosts the profile dropdown (settings entry) and the sidebar's settings-menu mode
- [Chat Modes](../../chat/chat_modes/chat_modes.md) — Chat modes section manages named presets
- [Auto Chat Titles](../../chat/auto_titles/auto_titles.md) — The Features tab hosts the "AI Functions" subsection where this opt-in toggle lives
- [Agents](../../agents/agents/agents.md) — Agents section (Default group) manages local A2A agent registrations
- [Remote Agents](../../agents/remote_agents/remote_agents.md) — Agents section (Profile group) lists Cinna-synced remote agents with per-profile enable/disable overrides
- [Adapters](../../llm/adapters/adapters.md) — LLM settings section manages provider configuration consumed by the adapter layer
- [MCP Connections](../../mcp/connections/connections.md) — MCP settings section manages server connections
- [User Accounts](../../auth/user_accounts/user_accounts.md) — Accounts section manages local user profiles
- [UI Guidelines](../../development/ui_guidelines/ui_guidelines_llm.md) — Expandable card pattern, button layout rules, color system
