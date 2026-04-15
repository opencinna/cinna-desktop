# Settings

## Purpose

Settings screen for configuring LLM providers (API keys, default models) and MCP server connections. Accessed from the sidebar, which transforms into a vertical settings navigation menu.

## Core Concepts

- **Settings View** — A dedicated app view (`activeView: 'settings'`) that replaces the chat interface
- **Settings Tab** — A sub-section within settings (`settingsTab: 'llm' | 'mcp'`), selected from the sidebar menu
- **Sidebar Menu Mode** — When settings are active, the sidebar replaces the chat list with a vertical settings menu

## User Stories / Flows

### Entering Settings

1. User clicks "Settings" button in the sidebar bottom bar
2. Sidebar transforms: chat list replaced by settings menu with "Back" button, "Settings" header, and vertical menu items (LLM Providers, MCP Providers)
3. Main content area shows the active settings section (LLM Providers by default)

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
- The sidebar "Settings" button is hidden when already in settings view (replaced by "Back" button)
- Theme toggle remains in sidebar bottom bar regardless of view
- Default settings tab is "LLM Providers" (`settingsTab: 'llm'`)
- Settings view state (`settingsTab`) persists across view switches — returning to settings reopens the last active section

## Architecture Overview

```
Sidebar (settings menu mode)
  ├── Back button → setActiveView('chat')
  ├── "Settings" header
  └── Menu items → setSettingsTab('llm' | 'mcp')

MainArea
  └── SettingsPage (shell)
        ├── Section title (dynamic)
        ├── LLMSettingsSection (when tab = 'llm')
        └── MCPSettingsSection (when tab = 'mcp')
```

## Integration Points

- **UI Store** — `activeView` and `settingsTab` state drives both sidebar mode and settings page content
- [Adapters](../../llm/adapters/adapters.md) — LLM settings section manages provider configuration consumed by the adapter layer
- [MCP Connections](../../mcp/connections/connections.md) — MCP settings section manages server connections
