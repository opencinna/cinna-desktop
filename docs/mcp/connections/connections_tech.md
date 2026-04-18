# MCP Connections — Technical Details

## File Locations

### Main Process
- `src/main/mcp/types.ts` — `McpProviderConfig`, `McpTool`, `McpConnection` types
- `src/main/mcp/manager.ts` — `MCPManager` singleton: connect, disconnect, callTool, getTools, OAuth flow. Persists OAuth tokens via `mcpProviderRepo.setAuthTokens()` / `setClientInfo()`.
- `src/main/mcp/oauth-provider.ts` — `ElectronOAuthProvider` class (DCR metadata, token/client-info storage, PKCE, browser redirect)
- `src/main/mcp/oauth-callback.ts` — `waitForOAuthCallback()` (temp HTTP server) + `findAvailablePort()`
- `src/main/db/mcpProviders.ts` — `mcpProviderRepo` — `list/getOwned/upsert/delete`, all scoped by `userId`. `setAuthTokens()` and `setClientInfo()` are called from the manager during OAuth (no ownership check — manager already holds the provider handle).
- `src/main/services/mcpService.ts` — `mcpService` — DTO mapping (`hasAuth`, live `status`, `tools`, `error`), transport validation, calls `mcpManager.connect()/disconnect()` after every upsert/delete based on `enabled`
- `src/main/ipc/mcp.ipc.ts` — Thin `mcp:*` handlers wrapped by `ipcHandle()`, gated by `requireActivated()`, delegate to `mcpService`. `mcp:connect` returns `{ success: false, error }` for inline display in the settings UI.
- `src/main/errors.ts` — `McpError` + `McpErrorCode` (`not_found`, `not_activated`, `invalid_transport`, `connect_failed`)
- `src/main/db/schema.ts` — `mcpProviders`, `chatMcpProviders` table definitions
- `src/main/db/client.ts` — Migrations for MCP tables
- `src/main/index.ts` — `initMcpProviders()`: connects all enabled MCP providers on startup (called by activation, not eagerly)
- `src/main/security/keystore.ts` — Encrypt/decrypt for OAuth tokens

### Preload
- `src/preload/index.ts` — Exposes `window.api.mcp.*` methods via contextBridge

### Renderer
- `src/renderer/src/hooks/useMcp.ts` — useMcpProviders, useUpsertMcpProvider, useDeleteMcpProvider, useConnectMcp, useDisconnectMcp
- `src/renderer/src/components/settings/SettingsPage.tsx` — Settings page with MCP Providers tab
- `src/renderer/src/components/settings/MCPProviderCard.tsx` — Transport config, env vars, tool list, connection status, OAuth status, reconnect/disconnect

## Database Schema

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `mcp_providers` | MCP server configs | id, name, transport_type (stdio\|sse\|streamable-http), command, args (json), url, env (json), enabled, auth_tokens_enc (encrypted blob), client_info (json) |
| `chat_mcp_providers` | Junction: MCP servers active per chat | chat_id, mcp_provider_id (composite PK) |

## IPC Channels

| Channel | Type | Purpose |
|---------|------|---------|
| `mcp:list` | invoke | List MCP configs + connection status + tools |
| `mcp:upsert` | invoke | Create/update MCP config |
| `mcp:delete` | invoke | Delete MCP config |
| `mcp:connect` | invoke | Connect to MCP server |
| `mcp:disconnect` | invoke | Disconnect from MCP server |
| `mcp:list-tools` | invoke | List tools from a connected server |

## Services & Key Methods

- `src/main/services/mcpService.ts:list(userId)` — Returns `McpProviderDto[]` joining repo rows with live connection status/tools/errors from the manager.
- `src/main/services/mcpService.ts:upsert(userId, input)` — Validates transport, persists via `mcpProviderRepo.upsert()`, then connects (if enabled) or disconnects (if disabled).
- `src/main/services/mcpService.ts:delete(userId, id)` — Disconnects then removes the row.
- `src/main/services/mcpService.ts` — `connect()`, `disconnect()`, `listTools()` — look up the owned row, then forward to the manager.
- `src/main/db/mcpProviders.ts:setAuthTokens(id, encrypted)` / `setClientInfo(id, info)` — Called from the manager during OAuth callback, intentionally without an ownership check (the manager already holds the provider handle).
- `src/main/mcp/manager.ts:connect(config)` — Creates transport, creates MCP Client, calls `client.connect()` + `client.listTools()`, caches tools
- `src/main/mcp/manager.ts:disconnect(id)` — Calls `client.close()`, cleans up OAuth state, removes from map
- `src/main/mcp/manager.ts:callTool(providerId, toolName, input)` — Calls `client.callTool()` on the connected client
- `src/main/mcp/manager.ts:getToolsForProviders(ids)` — Returns aggregated tool list for given provider IDs
- `src/main/mcp/oauth-provider.ts` — `ElectronOAuthProvider`: implements SDK's `OAuthClientProvider` interface (DCR metadata, token storage callbacks, PKCE code verifier, `shell.openExternal()` for browser redirect). `prepareForAuth()` attaches a no-op `.catch()` to prevent unhandled rejections when `cleanup()` aborts a never-awaited auth code promise (happens on successful connection with valid tokens)
- `src/main/mcp/oauth-callback.ts:waitForOAuthCallback()` — Starts temp HTTP server, waits for redirect, returns auth code. `abort()` rejects the promise and closes the server
- `src/main/mcp/oauth-callback.ts:findAvailablePort()` — Finds random available port for callback server

## Renderer Components

- `src/renderer/src/components/settings/MCPProviderCard.tsx` — Shows transport config (command/args for stdio, URL for HTTP), environment variables editor, tool list from connected server, connection status badge, OAuth status, reconnect/disconnect buttons

## Security

- OAuth tokens encrypted at rest via `safeStorage`, stored as blobs in `mcp_providers.auth_tokens_enc`
- DCR client info (client_id, client_secret) persisted in `mcp_providers.client_info` (not encrypted — not secret per OAuth spec)
- Tokens decrypted only in main process when reconnecting to authenticated servers
- OAuth redirect uses `127.0.0.1` (not `localhost`) to avoid DNS resolution issues
- Callback server has a 2-minute timeout to prevent lingering open ports
