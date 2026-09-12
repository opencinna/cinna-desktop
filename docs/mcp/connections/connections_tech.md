# MCP Connections — Technical Details

## File Locations

### Main Process
- `src/main/mcp/types.ts` — `McpProviderConfig`, `McpTool`, `McpConnection` types. `McpProviderConfig.authType` (`'oauth' | 'bearer'`, required) selects the auth branch; `bearerTokenEncrypted` carries the encrypted static token; `userId`, `configRevision` and `oauthDiscoveryState` bind OAuth storage to the captured configuration
- `src/main/shell/env.ts` — the login-shell environment resolver the stdio branch draws from (`getShellEnv`, `shellEnvForChild`, `mergeEnv`, `droppedChildEnvNames`, all re-exported from `src/main/shell/envMerge.ts`). See [Shell Environment Resolution](../../development/shell_environment/shell_environment_tech.md)
- `src/main/mcp/manager.ts` — `MCPManager` singleton: connect, disconnect, callTool, getTools, OAuth flow, bearer-token headers. Persists OAuth patches through revision-checked `mcpProviderRepo.saveOAuthState()`; bearer tokens are persisted through the normal `mcpService.upsert()` path instead (no callback to persist after-the-fact)
- `src/main/mcp/oauth-provider.ts` — `ElectronOAuthProvider` class (DCR metadata, token/client-info storage, PKCE, browser redirect). Only used on the `authType: 'oauth'` branch
- `src/main/mcp/oauth-callback.ts` — `startOAuthCallback(expectedState, timeoutMs)` — already-bound loopback listener with validated callback, full query parameters and idempotent abort
- `src/main/db/mcpProviders.ts` — `mcpProviderRepo` — `list/getOwned/upsert/delete`, all scoped by `userId`. `saveOAuthState(userId, id, configRevision, patch)` atomically checks ownership/revision for every OAuth write; zero changed rows throw. `upsert()` handles `authType`/`bearerTokenEncrypted` with three-state semantics (`undefined` preserves the stored value, `null` clears it, a `Buffer` sets it)
- `src/main/services/mcpService.ts` — `mcpService` — DTO mapping (`hasAuth`, `authType`, live `status`, `tools`, `error`), transport + auth-type validation, encrypts a plaintext `bearerToken` input via `encryptApiKey` before it reaches the repo, calls `mcpManager.connect()/disconnect()` after every upsert/delete based on `enabled`
- `src/main/ipc/mcp.ipc.ts` — Thin `mcp:*` handlers wrapped by `ipcHandle()`, gated by `requireActivated()`, delegate to `mcpService`. `mcp:connect` returns `{ success: false, error }` for inline display in the settings UI. `mcp:upsert` accepts `authType`/`bearerToken` alongside the existing fields
- `src/main/errors.ts` — `McpError` + `McpErrorCode` (`not_found`, `not_activated`, `invalid_transport`, `invalid_auth_type`, `connect_failed`)
- `src/main/db/schema.ts` — `mcpProviders`, `chatMcpProviders` table definitions
- `src/main/db/migrations/mcp.ts` — `migrateMcp()`: creates `mcp_providers`/adds `auth_tokens_enc`/`client_info`/`auth_type`/`bearer_token_enc`/`oauth_discovery_state`/`config_revision` columns, all guarded by `hasColumn()`
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
| `mcp_providers` | MCP server configs | id, name, transport_type (stdio\|sse\|streamable-http), command, args (json), url, env (json), enabled, auth_type (oauth\|bearer, default oauth), auth_tokens_enc (encrypted blob, OAuth), client_info (json, OAuth DCR), bearer_token_enc (encrypted blob, Bearer), oauth_discovery_state (JSON), config_revision (integer, default0) |
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
- `src/main/db/mcpProviders.ts:saveOAuthState(userId, id, configRevision, patch)` — one UPDATE constrained by all three fields. Patch values are tokens, registration or discovery; explicit null clears a scope. A missing/replaced row throws, so old callbacks cannot persist over a new endpoint.
- `src/main/db/mcpProviders.ts:upsert()` — URL/transport/auth-mode changes clear OAuth token, registration and discovery columns. These changes, command/args/env/enabled edits and explicit bearer writes increment configRevision; name-only changes preserve it and credentials. Existing rows acquire revision0/discoveryNULL through idempotent migration.
- `src/main/mcp/manager.ts:createClient(config)` — `@modelcontextprotocol/client` v2. Streamable HTTP uses `versionNegotiation.mode: auto` with a10,000ms probe and zero probe retries; stdio/SSE use `legacy`. The fresh post-OAuth client uses this same factory. SDK fallback is for a legacy discovery result, not an authorization/server failure.
- `src/main/mcp/manager.ts:connect(config)` — invalidates the generation and closes the previous client's pending work before enqueueing `_connect(config,generation)`. Queued stale requests exit disconnected; different providers progress independently. Browser callback processing runs outside the queue and rechecks ownership after each await.
- `src/main/mcp/manager.ts:isSuperseded(id, connection)` — checks live-map identity, generation and the current owned row's configRevision. `assertCurrent()` gates dispatch/persistence; `setStatus()` discards stale updates. Superseded clients/listeners close without publishing a false failure over the replacement.
- `src/main/mcp/manager.ts:_connect()` — stdio awaits the login shell and revalidates before spawn. Child env remains `mergeEnv(shellEnvForChild(shellEnv), config.env)`, using `DEFAULT_INHERITED_ENV_VARS` from `@modelcontextprotocol/client/stdio`, session additions and process-only proxy/CA variables. Names-only dropped-variable logging is unchanged.
- `src/main/mcp/manager.ts:bearerAuthHeaders()` — decrypts the configured static token for SSE/HTTP headers; absent token fails. SSE's non-bearer branch has no OAuth provider. Streamable HTTP's OAuth branch restores full SDK state and uses `onInsufficientScope: throw`.
- `src/main/mcp/manager.ts:disconnect()` / `disconnectAll()` — generation invalidation aborts listeners and pending clients immediately; queued teardown removes the live entry before awaiting close. Disconnect-all starts each provider teardown concurrently.
- `src/main/mcp/manager.ts:callTool()` — requires connected/current ownership before and after the SDK request, validates `isCallToolResult`, and returns `{content,isError}`. `McpToolProvider` forwards that shape unchanged. Unsupported/deferred results throw; this slice does not add Tasks/resume, Tasks polling or elicitation advertisement. Client capabilities remain empty. Unauthorized, insufficient-scope, reauthorization-required or latched persistence failure closes the connection and reports the settings reconnect message.
- `src/main/mcp/oauth-provider.ts` — SDK `OAuthClientProvider` exposes stored token/client/discovery getters and scoped invalidation (`all/client/tokens/verifier/discovery`). Persistence happens before in-memory mutation; a durable write failure is latched and makes future provider operations fail. Native metadata uses `application_type: native`, `token_endpoint_auth_method: none`, authorization-code/refresh grants and code response.
- `src/main/mcp/oauth-provider.ts:prepareForAuth()` — clears a prior listener, generates32random bytes of state and binds one listener. `waitForAuthCode()` returns its full `URLSearchParams` after state/attempt revalidation. `cleanup()` aborts and clears callback/state/verifier. Both state creation and browser redirect require `callback.isPending()`. Consumed or expired listeners cannot authorize again; consuming a valid callback clears its authorization state while retaining the verifier until exchange. A post-connect authorization request requires a new explicit Connect.
- `src/main/mcp/manager.ts:handleOAuthCallback()` — awaits validated full parameters, passes them to `finishAuth`, closes the old client and creates a fresh auto-negotiating HTTP client. Lists tools and cleans the listener before connected. SDK owns issuer checks, registration, PKCE, token exchange and refresh; no hand-built token flow in the manager.
- `src/main/mcp/oauth-callback.ts:startOAuthCallback(expectedState, timeoutMs=120000)` — binds127.0.0.1:0 before exposing `/oauth/callback`. Only GET/exact path/Host is accepted. Requires one matching state, at most one code and issuer; preserves full query parameters for SDK validation. Unrelated paths leave it pending; invalid callback/timeout/abort close it. Fixed neutral HTML has no callback interpolation, `no-store` and restrictive CSP. Cinna account OAuth reuses this listener and separately requires code/client_id.

## Renderer Components

- `src/renderer/src/components/settings/AddCustomMcpForm.tsx` — Always creates streamable-http. Name + URL fields, an OAuth/Bearer Token segmented toggle, and (Bearer only) a password-masked token input; disables Connect until the token is filled in when Bearer is selected; Connect/Connecting share a120px minimum width so pending does not move Cancel
- `src/renderer/src/components/settings/MCPProviderCard.tsx` — Shows transport config (command/args for stdio, URL for HTTP), environment variables editor, tool list from connected server, connection status badge, auth status (Shield icon labeled "OAuth authenticated" or "Bearer token configured" per `provider.authType`), an auth-mode toggle + write-only token-rotation input for `sse`/`streamable-http` providers, reconnect/disconnect buttons; Reconnect/Connecting share a120px minimum width. The transport selector appears only for a currently edited stdio card and labels the legacy option `SSE (deprecated)`; selecting remote swaps in URL/auth fields

## Security

- **Stdio servers never receive the user's shell secrets.** `getShellEnv()` sources `.zshrc`/`.bashrc`, which is where `ANTHROPIC_API_KEY`, `GITHUB_TOKEN` and `AWS_*` live; `shellEnvForChild()` narrows that to the SDK allowlist plus the session group (plus `PATHEXT` on win32) before it reaches a third-party binary, and drops any `()`-prefixed value (exported bash functions, the Shellshock encoding). Proxy/CA variables come from `process.env` only, so a shell profile cannot introduce or overwrite them. Anything else is opted into explicitly per server via `config.env`. Full rationale in [Stdio Environment](connections.md#stdio-environment)
- OAuth tokens encrypted at rest via `safeStorage`, stored as blobs in `mcp_providers.auth_tokens_enc`
- Full SDK client-registration and discovery structures persist as JSON in `mcp_providers.client_info` / `oauth_discovery_state`; tokens remain encrypted. New registration is a native public client, with no client-secret authentication request. No hosted native-client metadata URL is configured, so CIMD is not delivered; DCR remains the actual flow. Endpoint/auth changes clear all OAuth state; do not treat historical registration fields as generally public data
- Bearer tokens encrypted at rest via the same `safeStorage`-backed `encryptApiKey`, stored in `mcp_providers.bearer_token_enc`; never round-tripped to the renderer (`McpProviderDto`/`McpProviderData` only expose `hasAuth`/`authType`) — the edit-form token input is always blank, write-only
- Tokens decrypted only in main process when reconnecting to authenticated servers
- OAuth redirect uses `127.0.0.1` (not `localhost`) to avoid DNS resolution issues
- Callback server has a 2-minute timeout to prevent lingering open ports

## Verification and limits

- `src/main/mcp/manager.peer.test.ts` with `src/main/mcp/testSupport/protocolPeers.ts` exercises the real SDK against raw modern/legacy HTTP, SSE and stdio peers; includes actual loopback OAuth callback/token exchange, issuer mismatch, insufficient scope, preserved tool errors and persistence failure. UI, repository and keystore edges are mocked there.
- `src/main/mcp/oauth-provider.test.ts` covers real database migration, revision/owner writes, invalidation and latched persistence failure. `src/main/mcp/oauth-callback.test.ts` covers callback path/state/issuer parameters, neutral HTML, timeout and abort.
- `e2e/specs/mcp-connection.spec.ts` uses a local synthetic bearer server for saved HTTP configuration, discovery failure/reconnect, tool display and the disabled legacy transport choice. They do not verify real external OAuth accounts or browser authorization. Broader Tasks/resume and managed-agent work remain separate.
