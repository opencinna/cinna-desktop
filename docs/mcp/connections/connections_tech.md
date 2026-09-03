# MCP Connections — Technical Details

## File Locations

### Main Process
- `src/main/mcp/types.ts` — `McpProviderConfig`, `McpTool`, `McpConnection` types. `McpProviderConfig.authType` (`'oauth' | 'bearer'`, required) selects the auth branch; `bearerTokenEncrypted` carries the encrypted static token alongside the existing `authTokensEncrypted`/`clientInfo` OAuth fields
- `src/main/shell/env.ts` — the login-shell environment resolver the stdio branch draws from (`getShellEnv`, `shellEnvForChild`, `mergeEnv`, `droppedChildEnvNames`, all re-exported from `src/main/shell/envMerge.ts`). See [Shell Environment Resolution](../../development/shell_environment/shell_environment_tech.md)
- `src/main/mcp/manager.ts` — `MCPManager` singleton: connect, disconnect, callTool, getTools, OAuth flow, bearer-token headers. Persists OAuth tokens via `mcpProviderRepo.setAuthTokens()` / `setClientInfo()`; bearer tokens are persisted through the normal `mcpService.upsert()` path instead (no callback to persist after-the-fact)
- `src/main/mcp/oauth-provider.ts` — `ElectronOAuthProvider` class (DCR metadata, token/client-info storage, PKCE, browser redirect). Only used on the `authType: 'oauth'` branch
- `src/main/mcp/oauth-callback.ts` — `waitForOAuthCallback()` (temp HTTP server) + `findAvailablePort()`
- `src/main/db/mcpProviders.ts` — `mcpProviderRepo` — `list/getOwned/upsert/delete`, all scoped by `userId`. `setAuthTokens()` and `setClientInfo()` are called from the manager during OAuth (no ownership check — manager already holds the provider handle). `upsert()` handles `authType`/`bearerTokenEncrypted` with three-state semantics (`undefined` preserves the stored value, `null` clears it, a `Buffer` sets it)
- `src/main/services/mcpService.ts` — `mcpService` — DTO mapping (`hasAuth`, `authType`, live `status`, `tools`, `error`), transport + auth-type validation, encrypts a plaintext `bearerToken` input via `encryptApiKey` before it reaches the repo, calls `mcpManager.connect()/disconnect()` after every upsert/delete based on `enabled`
- `src/main/ipc/mcp.ipc.ts` — Thin `mcp:*` handlers wrapped by `ipcHandle()`, gated by `requireActivated()`, delegate to `mcpService`. `mcp:connect` returns `{ success: false, error }` for inline display in the settings UI. `mcp:upsert` accepts `authType`/`bearerToken` alongside the existing fields
- `src/main/errors.ts` — `McpError` + `McpErrorCode` (`not_found`, `not_activated`, `invalid_transport`, `invalid_auth_type`, `connect_failed`)
- `src/main/db/schema.ts` — `mcpProviders`, `chatMcpProviders` table definitions
- `src/main/db/migrations/mcp.ts` — `migrateMcp()`: creates `mcp_providers`/adds `auth_tokens_enc`/`client_info`/`auth_type`/`bearer_token_enc` columns, all guarded by `hasColumn()`
- `src/main/mcp/config.ts` — `mcpRowToConfig(row)`: the single row→`McpProviderConfig` mapper. Every `mcpManager.connect()` caller must use it — a hand-built literal that omits `authType`/`bearerTokenEncrypted` silently downgrades a bearer provider onto the OAuth/DCR branch
- `src/main/auth/reload.ts` — `reloadUserProviders()`: connects all enabled MCP providers on activation/startup (via `mcpRowToConfig`), not eagerly at app launch
- `src/main/security/keystore.ts` — Encrypt/decrypt for OAuth tokens and bearer tokens (`encryptApiKey`/`decryptApiKey`)

### Preload
- `src/preload/index.ts` — Exposes `window.api.mcp.*` methods via contextBridge. `McpProviderData` includes `authType`; `mcp.upsert()`'s payload includes `authType`/`bearerToken`

### Renderer
- `src/renderer/src/hooks/useMcp.ts` — useMcpProviders, useUpsertMcpProvider (payload includes `authType`/`bearerToken`), useDeleteMcpProvider, useConnectMcp, useDisconnectMcp
- `src/renderer/src/components/settings/SettingsPage.tsx` — Settings page with MCP Providers tab
- `src/renderer/src/components/settings/AddCustomMcpForm.tsx` — Add-remote-server form: name, URL, OAuth/Bearer Token toggle, conditional password-masked token input
- `src/renderer/src/components/settings/MCPProviderCard.tsx` — Transport config, env vars, tool list, connection status, auth status (OAuth vs Bearer Token badge), auth-mode toggle + token-rotation input for `sse`/`streamable-http` providers, reconnect/disconnect

## Database Schema

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `mcp_providers` | MCP server configs | id, name, transport_type (stdio\|sse\|streamable-http), command, args (json), url, env (json), enabled, auth_type (oauth\|bearer, default oauth), auth_tokens_enc (encrypted blob, OAuth), client_info (json, OAuth DCR), bearer_token_enc (encrypted blob, Bearer) |
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
- `src/main/services/mcpService.ts:upsert(userId, input)` — Validates transport (`assertTransport`) and auth type (`assertAuthType`), encrypts a plaintext `input.bearerToken` via `encryptApiKey` (omit to preserve the stored token), persists via `mcpProviderRepo.upsert()`, then connects (if enabled) or disconnects (if disabled). Logs `authType` alongside `transport`/`enabled` on every create/update.
- `src/main/services/mcpService.ts:delete(userId, id)` — Disconnects then removes the row.
- `src/main/services/mcpService.ts` — `connect()`, `disconnect()`, `listTools()` — look up the owned row, then forward to the manager.
- `src/main/db/mcpProviders.ts:setAuthTokens(id, encrypted)` / `setClientInfo(id, info)` — Called from the manager during OAuth callback, intentionally without an ownership check (the manager already holds the provider handle).
- `src/main/mcp/manager.ts:connect(config)` — Creates transport, creates MCP Client, calls `client.connect()` + `client.listTools()`, caches tools. Branches on `config.authType`: `'bearer'` builds the transport with a static `Authorization` header via `bearerAuthHeaders()`; anything else attaches `ElectronOAuthProvider` (the historic default, also covers no-auth servers)
- `src/main/mcp/manager.ts:_connect(config)` — **stdio env**: `await getShellEnv()` → `mergeEnv(shellEnvForChild(shellEnv), config.env)` becomes the `StdioClientTransport` `env`. Replaces the previous `config.env ? { ...process.env, ...config.env } : undefined`, which gave the SDK's minimal default env on one branch and the app's whole `process.env` on the other. One rule now covers both branches, and `config.env` still merges last and still wins. A `logger.debug('stdio env narrowed to the inherit allowlist', { providerId, dropped })` line fires per connect with `droppedChildEnvNames(shellEnv, config.env)` — **names only, never values**; the dropped set is the secret-bearing half of the environment. The allowlist itself is imported from `@modelcontextprotocol/sdk/client/stdio.js` (`DEFAULT_INHERITED_ENV_VARS`) rather than copied, so it cannot drift from the SDK
- `src/main/mcp/manager.ts:enqueue(id, task)` — per-provider task queue. `connect()`/`disconnect()` are thin wrappers that enqueue `_connect()`/`_disconnect()`, so lifecycle work for one provider never overlaps — two concurrent connects would otherwise each build a client while the map holds only one, leaking the loser's HTTP/SSE session (or stdio child process). Different providers still run concurrently. **`_connect`/`_disconnect` must never enqueue** — they run inside the queue already, so re-entering deadlocks. `handleOAuthCallback` is intentionally outside the queue (it waits on the user's browser; holding the queue would make Disconnect hang behind an abandoned auth flow)
- `src/main/mcp/manager.ts:discardSuperseded(connection, reason, id)` — closes a superseded attempt's client and cleans up its OAuth state, so no orphaned session survives the race
- `src/main/mcp/manager.ts:isSuperseded(id, connection)` — Identity check against the live map entry. A `connect()` whose entry was replaced/removed mid-flight (concurrent `disconnect()`/`disconnectAll()`, or a second `connect()` for the same provider) returns quietly at `debug` instead of logging `Connect failed` and broadcasting an `error` status — the superseding call already closed the client, which is what surfaces as `McpError -32000: Connection closed`. Guarded by a local `registered` flag so pre-registration failures (bad URL, missing bearer token) still surface as real errors
- `src/main/mcp/manager.ts:bearerAuthHeaders(config)` — Decrypts `config.bearerTokenEncrypted` via `decryptApiKey`, returns `{ Authorization: 'Bearer <token>' }`; throws if the config is `authType: 'bearer'` with no stored token
- `src/main/mcp/manager.ts:disconnect(id)` — Removes from the map **first**, then cleans up OAuth state and calls `client.close()`. The ordering matters: `close()` rejects the client's pending requests synchronously, so an in-flight `connect()` resumes as a microtask during the `await` — with the entry still present it would fail `isSuperseded()` and log a bogus failure
- `src/main/mcp/manager.ts:callTool(providerId, toolName, input)` — Calls `client.callTool()` on the connected client
- `src/main/mcp/manager.ts:getToolsForProviders(ids)` — Returns aggregated tool list for given provider IDs
- `src/main/mcp/manager.ts:handleOAuthCallback(id)` — finishes the browser flow and reconnects. Re-checks `isSuperseded()` after every await (auth-code wait, token exchange, reconnect) because it runs outside the per-provider queue; on supersession it discards via `discardSuperseded()` instead of calling `setStatus()`, which would otherwise re-insert a torn-down connection into the map as `connected`
- `src/main/mcp/oauth-provider.ts` — `ElectronOAuthProvider`: implements SDK's `OAuthClientProvider` interface (DCR metadata, token storage callbacks, PKCE code verifier, `shell.openExternal()` for browser redirect). `prepareForAuth()` attaches a no-op `.catch()` to prevent unhandled rejections when `cleanup()` aborts a never-awaited auth code promise (happens on successful connection with valid tokens). Not instantiated on the `authType: 'bearer'` branch
- `src/main/mcp/oauth-callback.ts:waitForOAuthCallback()` — Starts temp HTTP server, waits for redirect, returns auth code. `abort()` rejects the promise and closes the server
- `src/main/mcp/oauth-callback.ts:findAvailablePort()` — Finds random available port for callback server

## Renderer Components

- `src/renderer/src/components/settings/AddCustomMcpForm.tsx` — Name + URL fields, an OAuth/Bearer Token segmented toggle, and (Bearer only) a password-masked token input; disables Connect until the token is filled in when Bearer is selected
- `src/renderer/src/components/settings/MCPProviderCard.tsx` — Shows transport config (command/args for stdio, URL for HTTP), environment variables editor, tool list from connected server, connection status badge, auth status (Shield icon labeled "OAuth authenticated" or "Bearer token configured" per `provider.authType`), an auth-mode toggle + write-only token-rotation input for `sse`/`streamable-http` providers, reconnect/disconnect buttons

## Security

- **Stdio servers never receive the user's shell secrets.** `getShellEnv()` sources `.zshrc`/`.bashrc`, which is where `ANTHROPIC_API_KEY`, `GITHUB_TOKEN` and `AWS_*` live; `shellEnvForChild()` narrows that to the SDK allowlist plus the session group (plus `PATHEXT` on win32) before it reaches a third-party binary, and drops any `()`-prefixed value (exported bash functions, the Shellshock encoding). Proxy/CA variables come from `process.env` only, so a shell profile cannot introduce or overwrite them. Anything else is opted into explicitly per server via `config.env`. Full rationale in [Stdio Environment](connections.md#stdio-environment)
- OAuth tokens encrypted at rest via `safeStorage`, stored as blobs in `mcp_providers.auth_tokens_enc`
- DCR client info (client_id, client_secret) persisted in `mcp_providers.client_info` (not encrypted — not secret per OAuth spec)
- Bearer tokens encrypted at rest via the same `safeStorage`-backed `encryptApiKey`, stored in `mcp_providers.bearer_token_enc`; never round-tripped to the renderer (`McpProviderDto`/`McpProviderData` only expose `hasAuth`/`authType`) — the edit-form token input is always blank, write-only
- Tokens decrypted only in main process when reconnecting to authenticated servers
- OAuth redirect uses `127.0.0.1` (not `localhost`) to avoid DNS resolution issues
- Callback server has a 2-minute timeout to prevent lingering open ports
