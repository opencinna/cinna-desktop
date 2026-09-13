# Settings

## Purpose

Settings screen for managing chat modes, installation-wide agent folders/runtime and profile-owned Cinna agents, AI credentials, MCP server connections, the local development toolchain, user accounts and cloud sync. Accessed from the sidebar, which transforms into a vertical settings navigation menu split into two scope groups — see [Settings Scope](../../core/settings_scope/settings_scope.md).

## Core Concepts

- **Settings View** — A dedicated app view (`activeView: 'settings'`) that replaces the chat interface
- **Settings Tab** — A sub-section within settings, selected from the sidebar menu. The union is `SettingsMenu` in `ui.store.ts`, and `sectionTitles` in `SettingsPage.tsx` gives every member a title; the two are kept in step by hand, so a tab added to one and not the other is a compile error on the title lookup. Fifteen members: `'chats' | 'llm' | 'mcp' | 'local-agents' | 'local-dev' | 'accounts' | 'features' | 'development' | 'profile-agents' | 'profile-local-dev' | 'profile-chats' | 'profile-llm' | 'profile-catalog' | 'profile-sync' | 'trash'`
- **Default Group** — Sidebar section labeled "Default" containing the machine-local settings, in menu order: Chats, Agents, Local Development, AI Credentials, MCP Providers, User Accounts, Features, Development. Always visible. "Machine-local" is the rule that puts the agent folders/runtime tab here rather than in the Profile group — the agents home follows the machine, not whoever is signed in.
- **Profile Group** — Sidebar section labeled "Profile {displayName}" containing profile-bound settings, in menu order: Chats, Agents, Local Development, AI Credentials, Catalog, Cloud Sync. Only rendered when the active profile has profile-scope content (`showProfileGroup = isCinnaUser && !!profileLabel` in `Sidebar.tsx`), so today: Cinna users only. Cinna re-authentication is not a standalone menu item — it lives on the account's card in Settings → User Accounts.
- **Sidebar Menu Mode** — When settings are active, the sidebar replaces the chat list with the two-group vertical settings menu plus a footer "Trash" entry.

> **UI naming note:** The settings section for LLM providers (the `'llm'` / `'profile-llm'` tab) is labeled **"AI Credentials"** in the UI — in the sidebar menu item, the page title, and the "Add AI Credentials" button. "LLM Provider" is the canonical/technical name used in code (`useProviders`, `LLMProviderCard`, the `providers` store) and throughout these docs; "AI Credentials" is just the friendlier user-facing label (matching CinnaCore). They are the same thing. The sidebar menu item itself reads **AI Credentials** in both groups; "LLM Providers" survives only in code and in the technical docs.

## User Stories / Flows

### Entering Settings

1. User clicks the avatar in the sidebar footer to open the profile dropdown
2. User clicks the "Settings" entry in the dropdown
3. Sidebar transforms: chat list replaced by settings menu with "Back" button, a "Default" header followed by the machine-local menu items (Chats, Agents, Local Development, AI Credentials, MCP Providers, User Accounts, Features, Development), and — for Cinna users — a "Profile {name}" header followed by the profile-bound items (Chats, Agents, Local Development, AI Credentials, Catalog, Cloud Sync). A separator + "Trash" entry sits at the bottom.
4. Main content area shows the active settings section (Chat Modes by default)

### Navigating Between Sections

1. User clicks a menu item in the sidebar (e.g., "MCP Providers")
2. Previous section unmounts completely — any open forms or unsaved input are discarded
3. New section renders fresh with default state

### Returning to Chat

1. User clicks "Back" arrow button at top of sidebar settings menu
2. Sidebar reverts to chat list mode
3. Main content area returns to active chat or welcome screen

### Choosing the correct Agents settings

1. **Default → Agents** manages the machine's registered folders, runtime defaults and task concurrency; its internal tab id remains `local-agents`.
2. **Profile → Agents** manages only agents supplied by the active Cinna server. It groups them under that server's host, includes hidden agents, offers Enable/Disable and Sync, and exposes Settings for enabled rows. Sync/reauthentication failures and visibility-write errors stay visible beside the relevant controls.
3. **Agents sidebar → Add an agent → A2A Agent** opens a modal for a direct connection. Enter a card URL and optional access token, optionally Test Connection, then Save Agent. Creation stays open on failure and closes only after successful save. Direct A2A, ACP and Managed connections are configured from their own agent page's **Settings** action; there is no separate Default Remote agents tab.

### Agent sidebar sections

1. Open Features → Interface → **Show sections in Agents sidebar** (on by default).
2. Switch it off to show a flat agent list, or click the switch's associated label to toggle it. Ordering, profile ownership and visibility stay the same.
3. The boolean `showAgentSidebarSections` is installation-wide and survives restart. Controls disable during loading/saving. Failed optimistic writes roll back and display the failure; an unknown setting names the need to restart the running app. This feedback prevents a rejected write from appearing to be an inert switch.

## Autonomous task concurrency

Default → Agents → Tasks exposes **Autonomous task concurrency**, a device-wide integer from one to eight, default two. It limits separate autonomous-task and runner-agent admission queues; it does not cap all ordinary chat turns. Busy local agents wait cancelably for their lock. The control uses the existing app-settings read/write path and disables while loading or saving. Its explanation is behind the (?) beside its label. A read or save failure is rendered under the select only while one exists. See [autonomous configuration](../../jobs/tasks/autonomous_tasks_tech.md#configuration).

## Local Development scopes

- **Build page → Settings → Local Development Runtime** is a separate details view, reached from the footer build entry or an internal builder's Settings action. Its Default Runtime/Claude Agent/Codex/Custom OpenCode cards, optional OpenCode credential and Work complexity configure building only. Settings are installation-wide; complexity defaults to Complex even when the engine is inherited. **Start chat** returns to the preserved build draft. This is not another application settings tab; see [Account Build Sessions](../../agents/local_dev/build_sessions.md).

- **Default → Local Development** shows the desktop-managed CLI version and binary, terminal PATH integration, and Developer Tools. The installed CLI is read from the desktop toolchain independently of the active account's workspace readiness.
- **Profile → Local Development** shows the active Cinna account's workspace, setup status, setup/repair actions, and consent. Switching accounts remounts the profile page; activation clears and reconciles local-development state for the new account.
- Developer Tools includes the resolved OpenCode version and editable OpenCode Path. The Cinna detected from PATH can differ from the desktop-managed CLI; both readouts describe their own executable. OpenCode edits survive refresh and failed saves, including an empty draft; Escape discards.
- Runtime keeps its default choice buttons, with credential/Open agents with selectors in the rightmost third. Tasks is separate; Add an agents folder sits beside Rescan. Grouped Features and Runtime rows use 16 px inset dividers.
- Consent remains stored per server host. The Profile page explicitly says that accounts on the same server share the answer.

## Business Rules

- Switching application settings sections always resets the page — open forms, partial input, expanded cards are all discarded on navigation
- **Explanation behind the (?), status under the control, nothing reserved for nothing** ([UX Rules](../../development/ui_guidelines/ux_rules.md), rules 1 and 12). What a setting is for sits in a tip beside its label, because a paragraph under every label pushed the controls below the fold on every visit after the first. Under a control there is either a one-line status that has something true to say in every state, reserved at exactly one line, or a message rendered only while it applies, last in its card, so its arrival moves nothing the user is about to click. An always-present slot that is empty in the healthy state is not a reservation: it read as padding, a card with the wrong bottom edge
- Application settings is entered from the profile dropdown ("Settings" item); there is no dedicated Settings button in the sidebar footer
- A "Back" button replaces the chat list at the top of the sidebar while in settings view
- The Interface popover (Console / Verbose / Theme toggles) remains accessible from the sidebar footer regardless of view — see [App Shell](../app_shell/app_shell.md)
- Default settings tab is "Chat Modes" (`settingsTab: 'chats'`)
- Settings view state (`settingsTab`) persists across view switches — returning to settings reopens the last active section
- When the active profile loses access to a Profile-scope tab (e.g. user signs out of a Cinna account while `settingsTab === 'profile-agents'`), the sidebar auto-resets the selection to `'chats'` so no orphaned menu item is highlighted. `PROFILE_SCOPE_TABS` in `ui.store.ts` is the guard's list — all six profile tabs (`profile-agents`, `profile-local-dev`, `profile-chats`, `profile-llm`, `profile-catalog`, `profile-sync`). A profile tab added to the union but not to that array leaves the sidebar highlighting a menu item the group no longer renders

## Architecture Overview

```
UserMenu (profile dropdown in sidebar footer)
  └── "Settings" → setActiveView('settings')

Sidebar (settings menu mode)
  ├── Back button → setActiveView('chat')
  ├── "Default" header (defaultMenuItems in Sidebar.tsx)
  │     └── 'chats' | 'local-agents' | 'local-dev' | 'llm' | 'mcp' | 'accounts' | 'features' | 'development'
  ├── "Profile {name}" header (profileMenuItems; Cinna users only)
  │     └── 'profile-chats' | 'profile-agents' | 'profile-local-dev' | 'profile-llm' | 'profile-catalog' | 'profile-sync'
  └── (separator) → 'trash'

MainArea
  └── SettingsPage (shell)
        ├── Section title (sectionTitles[settingsTab])
        ├── ChatModesSection (when tab = 'chats')
        ├── LLMSettingsSection (when tab = 'llm')
        ├── LocalAgentsSettingsSection (when tab = 'local-agents')
        ├── LocalDevSettingsSection (when tab = 'local-dev')
        ├── MCPSettingsSection (when tab = 'mcp')
        ├── UserAccountsSection (when tab = 'accounts')   # hosts the per-account password modal + Cinna re-auth button
        ├── FeaturesSettingsSection (when tab = 'features')
        ├── DevelopmentSettingsSection (when tab = 'development')
        ├── ProfileLocalDevSettingsSection (when tab = 'profile-local-dev')
        ├── AgentsSettingsSection (when tab = 'profile-agents')
        ├── ProfileChatModesSection (when tab = 'profile-chats')
        ├── ProfileLLMSection (when tab = 'profile-llm')
        ├── CatalogSettingsSection (when tab = 'profile-catalog')
        ├── CloudSyncSettingsSection (when tab = 'profile-sync')
        └── TrashSection (when tab = 'trash')
```

Every section is rendered with a `key` equal to its tab id (the Profile Local Development page uses the active account id), which is what makes tab switching a remount rather than a re-render — see the reset rule under Business Rules.

## Integration Points

- **UI Store** — `activeView`, `settingsTab`, and the `PROFILE_SCOPE_TABS` constant drive sidebar mode, group rendering, and the stale-tab guard
- [Settings Scope](../../core/settings_scope/settings_scope.md) — defines which menu items belong to the Default vs Profile group
- [App Shell](../app_shell/app_shell.md) — Hosts the profile dropdown (settings entry) and the sidebar's settings-menu mode
- [Chat Modes](../../chat/chat_modes/chat_modes.md) — Chat modes section manages named presets
- [Switching an AI Credential Off](../../llm/adapters/credential_enablement.md) — the AI Credentials tab's off switch: the confirm that names what stops, and the line the card keeps while it is off
- [Auto Chat Titles](../../chat/auto_titles/auto_titles.md) — The Features tab hosts the "AI Functions" subsection where this opt-in toggle lives
- [Hints](../hints/hints.md) — The Features tab's "Interface" group hosts the `showHints` toggle and the "Reset hints" button that clears the localStorage retirement counters
- [Agents](../../agents/agents/agents.md) — Add an agent in the Agents sidebar creates direct A2A connections; each agent page exposes its own Settings action
- [Local Agents](../../agents/local_agents/agents_tab.md) — Agents section (Default group): the registered agent folders, the local engine and its binary path, and the detected developer tools, in three titled sections
- [Local Development](../../agents/local_dev/local_dev.md) — Local Development section: the managed uv / cinna-cli / Mutagen toolchain, its consent and repair actions
- [Bundles Catalog](../../agents/bundles_catalog/bundles_catalog.md) — Catalog section (Profile group) installs and uninstalls bundles
- [Data Sync](../../sync/data_sync/data_sync.md) — Cloud Sync section (Profile group) manages device pairing and sync state
- [Remote Agents](../../agents/remote_agents/remote_agents.md) — Agents section (Profile group) lists Cinna-synced remote agents with per-profile enable/disable overrides
- [Adapters](../../llm/adapters/adapters.md) — LLM settings section manages provider configuration consumed by the adapter layer
- [MCP Connections](../../mcp/connections/connections.md) — MCP settings section manages server connections
- [User Accounts](../../auth/user_accounts/user_accounts.md) — Accounts section manages local user profiles
- [UI Guidelines](../../development/ui_guidelines/ui_guidelines_llm.md) — The settings type scale and the settings section pattern, with the shared `SettingsLayout` primitives (`SettingsSection`, `SettingsCard`, `SettingsRows`, `SettingsLabel` and its (?) tip, `SettingsToggleRow`, `SettingsStatusRow`, `settingsInputClass`) a new tab is built from — the Default Agents, Features and Development tabs are built on them, and the older tabs match the same scale with their own markup; expandable card pattern, button layout rules, color system
