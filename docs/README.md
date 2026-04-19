# Cinna Desktop

Electron desktop chat client for LLMs (Anthropic, OpenAI, Gemini) with MCP connector support and A2A agent integration.

## Glossary

| Term | Definition |
|------|-----------|
| **Chat** | A conversation with an LLM, persisted in SQLite with messages and model/provider binding |
| **Chat Mode** | A named preset bundling an LLM provider/model, MCP servers, and a color — used to quickly start configured chats |
| **Provider** | An LLM service (Anthropic, OpenAI, Gemini) configured with an encrypted API key |
| **Adapter** | Implementation of the `LLMAdapter` interface that translates between our chat system and a provider's SDK |
| **MCP Server** | A Model Context Protocol server (local stdio or remote HTTP) that exposes tools to the LLM |
| **MCP Connection** | A live client session to an MCP server, managed by MCPManager |
| **Tool Call** | LLM requests a tool -> main process calls MCP server -> result fed back to LLM |
| **MessagePort** | Electron's streaming channel used to send LLM response chunks from main to renderer |
| **safeStorage** | Electron's OS-keychain encryption used for API keys and OAuth tokens at rest |
| **Agent** | An external AI service (e.g. A2A agent) registered by the user, communicating via a standardized protocol |
| **A2A** | Agent-to-Agent Protocol v1.0 — open standard for AI agent interoperability (discovery, messaging, streaming) |
| **Agent Card** | A2A discovery metadata (JSON) fetched from a well-known URL, describing agent capabilities and endpoint |
| **Message Part** | A typed segment of an assistant message (`kind: 'text' \| 'thinking' \| 'tool'`) — A2A messages may persist a structured `parts[]` list driven by the Cinna `cinna.content_kind` metadata convention |
| **@-mention** | Typing `@` in the new-chat input to open a popup for selecting references (agents, and extensible for future types) |
| **User Account** | A local profile (username + optional password) that scopes all data — chats, providers, agents, settings |
| **Default User** | Built-in guest account (`__default__`) with no password, always present |
| **Cinna Account** | A user account linked to a remote Cinna server (cloud or self-hosted) via OAuth 2.0 + PKCE |
| **Cinna Server** | Remote service (cloud at `opencinna.io` or self-hosted) providing agent orchestration and future features |

## Domain Map

| Domain | Description |
|--------|-------------|
| [Core](core/resource_activation/resource_activation.md) | Cross-cutting architecture: account-scoped resources, activation gate |
| [Auth](auth/user_accounts/user_accounts.md) | Local user accounts, login/registration, user-scoped data |
| [Chat](chat/messaging/messaging.md) | Conversation CRUD, message streaming, tool-call loop |
| [Agents](agents/agents/agents.md) | External AI agent integration (A2A protocol), agent discovery, chat routing |
| [LLM](llm/adapters/adapters.md) | Provider management, adapter abstraction, model selection |
| [MCP](mcp/connections/connections.md) | MCP server connections, tool aggregation, OAuth DCR |
| [UI](ui/settings/settings.md) | Settings screen, sidebar navigation, theming |
| [Development](development/setup/setup.md) | Dev environment, commands, gotchas |

## Feature Registry

### Core
- [Resource Activation](core/resource_activation/resource_activation.md) — Account-scoped resource lifecycle: services only run after user authentication

### Auth
- [User Accounts](auth/user_accounts/user_accounts.md) — Local user profiles with optional password auth, user-scoped data isolation, session management
- [Cinna Accounts](auth/cinna_accounts/cinna_accounts.md) — OAuth 2.0 + PKCE connection to remote Cinna servers (cloud or self-hosted), token rotation

### Chat
- [Messaging](chat/messaging/messaging.md) — Chat CRUD, MessagePort streaming, multi-provider tool-call loop
- [Conversation UI](chat/conversation_ui/conversation_ui.md) — Message rendering: user bubbles, assistant plain text, tool blocks, system errors
- [Chat Modes](chat/chat_modes/chat_modes.md) — Named presets bundling LLM provider/model, MCP servers, and color scheme for one-click chat setup
- [Example Prompts](chat/example_prompts/example_prompts.md) — Remote-agent starter prompts shown as an animated tag cloud and surfaced via `#` in the chat input

### Agents
- [Agents](agents/agents/agents.md) — A2A protocol agent management, card discovery, streaming chat via external agents
- [A2A Streaming Pipeline](agents/agents/streaming_pipeline.md) — Per-part delta computation, `cinna.content_kind` / `cinna.tool_name` metadata contract, structured `parts[]` persistence
- [Remote Agents](agents/remote_agents/remote_agents.md) — Auto-sync agents from Cinna backend, categorized display, JWT-based A2A communication
- [Agent Status](agents/agent_status/agent_status.md) — Title-bar activity indicator + frosted-glass modal surfacing per-agent self-reported status (severity, summary, markdown body) with one-click "Start chat"

### LLM
- [Adapters](llm/adapters/adapters.md) — Custom LLM abstraction layer with Anthropic, OpenAI, Gemini adapters

### MCP
- [Connections](mcp/connections/connections.md) — MCP server lifecycle, stdio/SSE/streamable-http transports, OAuth DCR

### UI
- [Settings](ui/settings/settings.md) — Settings screen with sidebar navigation, LLM provider and MCP server configuration
- [Verbose Mode](ui/verbose_mode/verbose_mode.md) — Compact/verbose display toggle: message timestamps, meta popup, and streaming block auto-expand behaviour

### Development
- [Setup](development/setup/setup.md) — Dev commands, tech stack, gotchas, project status
- [UI Guidelines](development/ui_guidelines/ui_guidelines_llm.md) — Color system, expandable card pattern, button layout rules, form conventions (LLM reference)
- [Logger](development/logger/logger.md) — In-app debug logger with full-window overlay, scoped loggers for main/renderer, ⌘` keyboard shortcut
- [Main-Process Layering](development/main_layering/main_layering_llm.md) — `db → services → ipc` convention, `ipcHandle()` wrap, DomainError codes, DTO masking (LLM reference)

## Architecture

```
+------------------------------------------------+
|                 MAIN PROCESS                   |
|                                                |
|  SQLite (Drizzle)  LLM SDKs  MCP Clients  A2A |
|  User accounts (PBKDF2)  Session management    |
|  API keys & tokens encrypted via safeStorage   |
|                                                |
|  IPC Handlers (ipcMain.handle / .on)           |
|  + MessagePort for streaming                   |
+------------------+-----------------------------+
                   |  contextBridge (typed window.api)
+------------------+-----------------------------+
|              RENDERER (sandboxed)              |
|  contextIsolation: true, nodeIntegration: false|
|  React + Zustand + TanStack Query              |
|  window.api.auth.* / .chat.* / .providers.*    |
|  window.api.agents.* / .mcp.* / .llm.*        |
+------------------------------------------------+
```

**Security model**: API keys and OAuth tokens are encrypted at rest using Electron's `safeStorage` (OS keychain) and stored as blobs in SQLite. They are decrypted only in the main process. User passwords are hashed with PBKDF2-SHA512 (100k iterations). All data is user-scoped — every IPC query filters by the active user ID. The renderer is fully sandboxed — it can only access the typed `window.api.*` methods exposed via contextBridge.
