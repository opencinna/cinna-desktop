# Settings — Technical Details

## File Locations

### Renderer — Components

- `src/renderer/src/components/settings/SettingsPage.tsx` — Shell component: reads `settingsTab`, renders section title and active section
- `src/renderer/src/components/settings/LLMSettingsSection.tsx` — LLM providers list + add-provider form toggle
- `src/renderer/src/components/settings/MCPSettingsSection.tsx` — MCP providers list + add-remote form + add-local button; contains private `AddRemoteMcpForm`
- `src/renderer/src/components/settings/LLMProviderCard.tsx` — Expandable card: enable/disable, default toggle, API key management, model selection
- `src/renderer/src/components/settings/LLMProviderForm.tsx` — New provider wizard: type selection → API key → model picker
- `src/renderer/src/components/settings/MCPProviderCard.tsx` — Expandable card: transport config, env vars, connect/disconnect, tools list
- `src/renderer/src/components/settings/AgentsSettingsSection.tsx` — Agents list + add-agent form toggle
- `src/renderer/src/components/settings/AgentCard.tsx` — Expandable card: agent details, access token, test connection
- `src/renderer/src/components/settings/A2AAgentForm.tsx` — New agent wizard: card URL fetch → save
- `src/renderer/src/components/settings/ChatModesSection.tsx` — Chat modes list + add-mode form toggle
- `src/renderer/src/components/settings/ChatModeCard.tsx` — Expandable card: name, color, provider/model, MCP bindings
- `src/renderer/src/components/settings/ChatModeForm.tsx` — New chat mode form: name, color, provider, MCP selection
- `src/renderer/src/components/settings/UserAccountsSection.tsx` — User accounts list with expandable cards per user
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

## State Management

### UI Store (`ui.store.ts`)

| State | Type | Default | Purpose |
|-------|------|---------|---------|
| `activeView` | `'chat' \| 'settings'` | `'chat'` | Controls sidebar mode and main content |
| `settingsTab` | `'chats' \| 'agents' \| 'llm' \| 'mcp' \| 'accounts' \| 'trash'` | `'chats'` | Active settings section |

### Section Reset on Tab Switch

Each section is rendered with a `key` prop matching the tab ID. Switching tabs unmounts the previous section, destroying all local `useState` (open forms, expanded cards, partial input).

## Renderer Components

### Sidebar Settings Menu (`Sidebar.tsx`)

Menu items defined as static array:
- `{ id: 'chats', label: 'Chats', icon: MessageSquare }`
- `{ id: 'agents', label: 'Agents', icon: Bot }`
- `{ id: 'llm', label: 'LLM Providers', icon: Brain }`
- `{ id: 'mcp', label: 'MCP Providers', icon: Plug }`
- `{ id: 'accounts', label: 'User Accounts', icon: Users }`

Active item highlighted with `bg-[var(--color-bg-tertiary)]`. Back button calls `setActiveView('chat')`.

### SettingsPage (`SettingsPage.tsx`)

Thin shell — derives `sectionTitle` from `settingsTab`, conditionally renders one of the six section components.

### LLMSettingsSection (`LLMSettingsSection.tsx`)

- Lists providers from `useProviders()` as `LLMProviderCard` instances
- Local state `showAddLLM` toggles `LLMProviderForm` visibility

### MCPSettingsSection (`MCPSettingsSection.tsx`)

- Lists providers from `useMcpProviders()` as `MCPProviderCard` instances
- Local state `showAddRemoteMcp` toggles inline `AddRemoteMcpForm`
- "Add Local MCP" button directly creates a disabled stdio provider via `useUpsertMcpProvider()`

## IPC Channels

Settings components interact with these IPC channels via `window.api.*`:

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
