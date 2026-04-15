# Cinna Desktop

Electron desktop chat client for LLMs (Anthropic, OpenAI, Gemini) with MCP connector support.

## Glossary

| Term | Definition |
|------|-----------|
| **Chat** | A conversation with an LLM, persisted in SQLite with messages and model/provider binding |
| **Provider** | An LLM service (Anthropic, OpenAI, Gemini) configured with an encrypted API key |
| **Adapter** | Implementation of the `LLMAdapter` interface that translates between our chat system and a provider's SDK |
| **MCP Server** | A Model Context Protocol server (local stdio or remote HTTP) that exposes tools to the LLM |
| **MCP Connection** | A live client session to an MCP server, managed by MCPManager |
| **Tool Call** | LLM requests a tool -> main process calls MCP server -> result fed back to LLM |
| **MessagePort** | Electron's streaming channel used to send LLM response chunks from main to renderer |
| **safeStorage** | Electron's OS-keychain encryption used for API keys and OAuth tokens at rest |

## Domain Map

| Domain | Description |
|--------|-------------|
| [Chat](chat/messaging/messaging.md) | Conversation CRUD, message streaming, tool-call loop |
| [LLM](llm/adapters/adapters.md) | Provider management, adapter abstraction, model selection |
| [MCP](mcp/connections/connections.md) | MCP server connections, tool aggregation, OAuth DCR |
| [UI](ui/settings/settings.md) | Settings screen, sidebar navigation, theming |
| [Development](development/setup/setup.md) | Dev environment, commands, gotchas |

## Feature Registry

### Chat
- [Messaging](chat/messaging/messaging.md) — Chat CRUD, MessagePort streaming, multi-provider tool-call loop
- [Conversation UI](chat/conversation_ui/conversation_ui.md) — Message rendering: user bubbles, assistant plain text, tool blocks, system errors

### LLM
- [Adapters](llm/adapters/adapters.md) — Custom LLM abstraction layer with Anthropic, OpenAI, Gemini adapters

### MCP
- [Connections](mcp/connections/connections.md) — MCP server lifecycle, stdio/SSE/streamable-http transports, OAuth DCR

### UI
- [Settings](ui/settings/settings.md) — Settings screen with sidebar navigation, LLM provider and MCP server configuration

### Development
- [Setup](development/setup/setup.md) — Dev commands, tech stack, gotchas, project status

## Architecture

```
+------------------------------------------------+
|                 MAIN PROCESS                   |
|                                                |
|  SQLite (Drizzle)  LLM SDKs    MCP Clients    |
|  API keys encrypted via safeStorage            |
|                                                |
|  IPC Handlers (ipcMain.handle / .on)           |
|  + MessagePort for streaming                   |
+------------------+-----------------------------+
                   |  contextBridge (typed window.api)
+------------------+-----------------------------+
|              RENDERER (sandboxed)              |
|  contextIsolation: true, nodeIntegration: false|
|  React + Zustand + TanStack Query              |
|  window.api.chat.* / .providers.* / .mcp.*     |
+------------------------------------------------+
```

**Security model**: API keys and OAuth tokens are encrypted at rest using Electron's `safeStorage` (OS keychain) and stored as blobs in SQLite. They are decrypted only in the main process. The renderer is fully sandboxed — it can only access the typed `window.api.*` methods exposed via contextBridge.
