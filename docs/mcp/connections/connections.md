# MCP Connections

## Purpose

Manage connections to MCP (Model Context Protocol) servers — local stdio processes and remote HTTP servers — so that LLMs can call external tools during conversations.

## Core Concepts

- **MCP Provider** — A configured MCP server (persisted in DB) with transport type, connection details, and optional OAuth tokens
- **MCP Connection** — A live client session to an MCP server, held in memory by MCPManager
- **Transport** — How the client communicates: `stdio` (local process), `sse` (Server-Sent Events), or `streamable-http` (bidirectional HTTP)
- **Tool** — A capability exposed by an MCP server (name, description, input schema), aggregated and passed to LLM adapters
- **OAuth DCR** — Dynamic Client Registration (RFC 7591) used for authenticating with remote MCP servers

## User Stories / Flows

### Adding a local MCP server (stdio)
1. User goes to Settings > MCP Providers, clicks "Add Local MCP"
2. Enters name, command (e.g., `npx`), args (e.g., `["-y", "@modelcontextprotocol/server-filesystem"]`), optional env vars
3. Saves; system auto-connects and lists available tools

### Adding a remote MCP server (streamable-http)
1. User clicks "Add Remote MCP", enters name and URL
2. Saves; system attempts connection
3. If server requires OAuth: status becomes `awaiting-auth`, browser opens for authorization
4. After user authorizes in browser, OAuth callback completes, tokens are encrypted and persisted
5. Connection resumes with authenticated transport, tools are listed

### Using MCP tools in a chat
1. User enables MCP servers for a chat via the [+] config menu or MCP toggle pills
2. When sending a message, enabled MCP tools are passed to the LLM adapter
3. If LLM emits `tool_use`, main process calls `mcpManager.callTool()` on the correct server
4. Result is fed back to the LLM

## Business Rules

- Connection statuses: `connected`, `disconnected`, `error`, `awaiting-auth`
- On app start, all enabled MCP providers are auto-connected (including restoring persisted OAuth tokens)
- On app quit, all connections are cleanly disconnected
- OAuth tokens are encrypted via `safeStorage` and persisted; if still valid on next launch, no browser auth needed
- DCR client info (client_id, client_secret) is persisted separately so re-registration isn't needed
- The OAuth redirect uses a temporary local HTTP server on `127.0.0.1` with a random port; redirect_uri changes each auth flow (DCR handles this automatically)
- The callback server shuts down after receiving the callback or after a 2-minute timeout

## Architecture Overview

```
Settings UI -> IPC -> MCPManager.connect(config)
  -> Create transport (Stdio / SSE / StreamableHTTP)
  -> For streamable-http: attach ElectronOAuthProvider if auth needed
  -> MCP Client.connect() + listTools()
  -> Cache tools in memory

Chat flow:
  LLM Adapter -> tool_use -> MCPManager.callTool(providerId, toolName, input)
    -> MCP Client.callTool() -> result back to LLM
```

## OAuth DCR Flow (Remote Servers)

1. MCPManager creates `ElectronOAuthProvider` and passes it to `StreamableHTTPClientTransport`
2. On 401, SDK transport performs Dynamic Client Registration (RFC 7591)
3. Provider opens system browser to the authorization URL via `shell.openExternal()`
4. Temporary local HTTP server listens for the redirect callback
5. Browser redirects to `http://127.0.0.1:{port}/oauth/callback?code=...`
6. Callback server extracts code, displays success page, shuts down
7. `transport.finishAuth(code)` exchanges code for tokens (PKCE throughout)
8. Fresh Client reconnects through authenticated transport
9. Tokens encrypted and persisted to `mcp_providers.auth_tokens_enc`
10. DCR client info persisted to `mcp_providers.client_info`

## Integration Points

- [Chat Messaging](../../chat/messaging/messaging.md) — Tool calls during streaming are routed through MCPManager
- [LLM Adapters](../../llm/adapters/adapters.md) — MCP tools are converted to each provider's tool schema format
- Database — MCP configs, OAuth tokens, and chat-MCP junction stored in SQLite
