# MCP Connections

## Purpose

Manage connections to MCP (Model Context Protocol) servers — local stdio processes and remote HTTP servers — so that LLMs can call external tools during conversations.

## Core Concepts

- **MCP Provider** — A configured MCP server (persisted in DB) with transport type, connection details, and optional auth (OAuth tokens or a bearer token)
- **MCP Connection** — A live client session to an MCP server, held in memory by MCPManager
- **Transport** — How the client communicates: `stdio` (local process), `sse` (Server-Sent Events), or `streamable-http` (bidirectional HTTP)
- **Tool** — A capability exposed by an MCP server (name, description, input schema), aggregated and passed to LLM adapters
- **Auth Type** (`authType`) — How a remote (`sse`/`streamable-http`) server authenticates: `'oauth'` (DCR, the default — also covers servers needing no auth, since the OAuth-capable transport just never hits a 401) or `'bearer'` (a static token the user pastes in). Unused for `stdio`
- **OAuth DCR** — Dynamic Client Registration (RFC 7591) used for authenticating with remote MCP servers when `authType: 'oauth'`
- **Bearer Token** — A static, user-supplied access token sent as `Authorization: Bearer <token>` on every request, for servers that don't support DCR. No browser round-trip, no `awaiting-auth` state — set once and it's used immediately, encrypted at rest like other credentials
- **Registry** — A public catalog of MCP servers the user can browse to discover and one-click install — see [Registries](../registries/registries.md)

## User Stories / Flows

### Adding a local MCP server (stdio)
1. User goes to Settings > MCP Providers, clicks "Add Local MCP"
2. Enters name, command (e.g., `npx`), args (e.g., `["-y", "@modelcontextprotocol/server-filesystem"]`), optional env vars
3. Saves; system auto-connects and lists available tools

### Adding a remote MCP server (streamable-http)
1. User clicks "Add Custom MCP", enters name and URL, and picks an authentication mode: **OAuth** (default) or **Bearer Token**
2. **OAuth**: saves; system attempts connection. If the server requires OAuth, status becomes `awaiting-auth`, browser opens for authorization. After the user authorizes in browser, the OAuth callback completes, tokens are encrypted and persisted, and the connection resumes with the authenticated transport
3. **Bearer Token**: user also pastes the server's access token. It's encrypted (`safeStorage`) and persisted immediately; the connection is made synchronously with an `Authorization: Bearer <token>` header — no browser round-trip, no `awaiting-auth` state
4. Tools are listed once connected

### Editing an existing remote server's auth

The provider card's expanded edit form lets the user switch `sse`/`streamable-http` servers between OAuth and Bearer Token, or rotate a bearer token. The token input is always blank (write-only — the stored value never round-trips to the renderer); leaving it blank on Save keeps the currently stored token. The header Shield icon indicates which auth mode is active (`hasAuth` is true for either).

### Browsing a registry
See [MCP Registries](../registries/registries.md). The Connect button in the picker reuses the same `mcp:upsert` → `mcpManager.connect` path documented below.

### Using MCP tools in a chat
1. User enables MCP servers for a chat via the [+] config menu or MCP toggle pills
2. When sending a message, enabled MCP tools are passed to the LLM adapter
3. If LLM emits `tool_use`, main process calls `mcpManager.callTool()` on the correct server
4. Result is fed back to the LLM
5. For lazy per-chat engagement, see [On-Demand MCP](../on_demand/on_demand.md) — users `@-mention` MCPs in the composer so tool schemas are only attached when actually needed

## Business Rules

- Connection statuses: `connected`, `disconnected`, `error`, `awaiting-auth`
- On app start, all enabled MCP providers are auto-connected (including restoring persisted OAuth tokens or the bearer token)
- On app quit, all connections are cleanly disconnected
- OAuth tokens are encrypted via `safeStorage` and persisted; if still valid on next launch, no browser auth needed
- DCR client info (client_id, client_secret) is persisted separately so re-registration isn't needed
- The OAuth redirect uses a temporary local HTTP server on `127.0.0.1` with a random port; redirect_uri changes each auth flow (DCR handles this automatically)
- The callback server shuts down after receiving the callback or after a 2-minute timeout
- Bearer tokens are encrypted via the same `safeStorage`-backed `encryptApiKey`/`decryptApiKey` helpers as OAuth tokens and API keys, stored in `mcp_providers.bearer_token_enc`
- `authType` defaults to `'oauth'` for every provider (including pre-existing rows migrated forward and registry-installed providers) — Bearer Token is opt-in per server
- A bearer-token connection never enters `awaiting-auth`: the token is static and known up front, so `client.connect()` either succeeds or fails straight to `error` (e.g. wrong/expired token → 401 surfaces as a connect error, not a re-auth prompt)
- Switching a provider's `authType` doesn't clear the other auth mode's stored credentials (OAuth tokens/client info survive a switch to Bearer and vice versa) — harmless since the manager only reads the credential matching the active `authType`

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

## Bearer Token Flow (Remote Servers)

1. User picks "Bearer Token" in the Add Custom MCP form (or the provider card's edit form) and pastes the server's access token
2. `mcpService.upsert` encrypts the token with `encryptApiKey` and stores it in `mcp_providers.bearer_token_enc` alongside `auth_type = 'bearer'`
3. `MCPManager.connect()` sees `authType === 'bearer'`, decrypts the token, and constructs the `SSEClientTransport`/`StreamableHTTPClientTransport` with `requestInit: { headers: { Authorization: 'Bearer <token>' } }` instead of attaching an `ElectronOAuthProvider`
4. `client.connect()` proceeds synchronously — no DCR, no system-browser round-trip, no local callback server
5. On success the connection is `connected` immediately; on a bad/expired token it goes straight to `error` with the underlying HTTP failure surfaced

## Integration Points

- [MCP Registries](../registries/registries.md) — Discovery layer; the picker creates providers through `mcp:upsert` and reuses the connection flow above
- [Chat Messaging](../../chat/messaging/messaging.md) — Tool calls during streaming are routed through MCPManager
- [LLM Adapters](../../llm/adapters/adapters.md) — MCP tools are converted to each provider's tool schema format
- Database — MCP configs, OAuth tokens, and chat-MCP junction stored in SQLite
