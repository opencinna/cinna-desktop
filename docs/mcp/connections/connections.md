# MCP Connections

## Purpose

Manage connections to MCP (Model Context Protocol) servers — local stdio processes and remote HTTP servers — so that LLMs can call external tools during conversations.

## Core Concepts

- **MCP Provider** — A configured MCP server (persisted in DB) with transport type, connection details, and optional auth (OAuth tokens or a bearer token)
- **MCP Connection** — A live client session to an MCP server, held in memory by MCPManager
- **Transport** — How the client communicates: `stdio` (local process), `sse` (deprecated legacy Server-Sent Events), or `streamable-http` (the default for new remote servers)
- **Tool** — A capability exposed by an MCP server (name, description, input schema), aggregated and passed to LLM adapters
- **Auth Type** (`authType`) — How a remote (`sse`/`streamable-http`) server authenticates: `'oauth'` (DCR, the default — also covers servers needing no auth, since the OAuth-capable transport just never hits a 401) or `'bearer'` (a static token the user pastes in). Unused for `stdio`; legacy SSE supports a static bearer header or an unauthenticated connection, without the native OAuth flow
- **OAuth DCR** — Dynamic Client Registration (RFC 7591) used for authenticating with remote MCP servers when `authType: 'oauth'`
- **Bearer Token** — A static, user-supplied access token sent as `Authorization: Bearer <token>` on every request, for servers that don't support DCR. No browser round-trip, no `awaiting-auth` state — set once and it's used immediately, encrypted at rest like other credentials
- **Registry** — A public catalog of MCP servers the user can browse to discover and one-click install — see [Registries](../registries/registries.md)
- **Inherited Environment** (`stdio`) — The fixed, narrow set of variables a spawned server process receives from the app, valued from the user's **login shell** rather than the app's own environment. See [Stdio Environment](#stdio-environment)
- **Server `env` map** — The per-server environment variables the user types into the provider card. Merged on top of the inherited set and always wins; it is the escape hatch for anything the inherited set does not carry

## User Stories / Flows

### Adding a local MCP server (stdio)
1. User goes to Settings > MCP Providers, clicks "Add Local MCP"
2. Enters name, command (e.g., `npx`), args (e.g., `["-y", "@modelcontextprotocol/server-filesystem"]`), optional env vars
3. Saves; system auto-connects and lists available tools
4. The command is resolved against the user's **login-shell `PATH`**, so `npx` / `uvx` / a Homebrew or mise-installed binary works whether the app was started from the Dock or from a terminal. What the server process can read is otherwise deliberately narrow — see [Stdio Environment](#stdio-environment)

### Adding a remote MCP server (streamable-http)
1. User clicks "Add Custom MCP", enters name and URL, and picks an authentication mode: **OAuth** (default) or **Bearer Token**
2. **OAuth**: saves; system attempts connection. If the server requires OAuth, status becomes `awaiting-auth`, browser opens for authorization. After the user authorizes in browser, the OAuth callback completes, tokens are encrypted and persisted, and the connection resumes with the authenticated transport
3. **Bearer Token**: user also pastes the server's access token. It's encrypted (`safeStorage`) and persisted immediately; the connection is made synchronously with an `Authorization: Bearer <token>` header — no browser round-trip, no `awaiting-auth` state
4. Tools are listed once connected. A connection failure leaves the saved provider available with its error and Reconnect action; it does not lose the server configuration.

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
- All enabled MCP providers are auto-connected when a user session activates — not eagerly at process launch (see [Resource Activation](../../core/resource_activation/resource_activation.md)). Persisted OAuth tokens or the bearer token are restored as part of that connect
- The active auth mode is resolved from the provider's persisted config on **every** connect, including the automatic one at activation. A bearer-token server therefore never opens a browser at any point in its lifecycle — if one appears, the auth mode was lost on the way to the connection layer
- On app quit, all connections are cleanly disconnected
- OAuth tokens are encrypted via `safeStorage` and persisted; if still valid on next launch, no browser auth needed
- Native public-client registration and discovered issuer metadata are persisted separately. The SDK can reuse valid registration and refresh tokens while checking they belong to the discovered authorization server
- The OAuth redirect uses a temporary local HTTP server on `127.0.0.1` with a random port; redirect_uri changes each auth flow (DCR handles this automatically)
- The callback listener binds its OS-selected loopback port before publishing the redirect URL. It accepts only its exact GET path/Host and one matching state, rejects duplicate state/code/issuer parameters, and closes after the callback, cancellation or a 2-minute timeout. The browser page says to return to Cinna; it does not claim authorization succeeded before token exchange
- Bearer tokens are encrypted via the same `safeStorage`-backed `encryptApiKey`/`decryptApiKey` helpers as OAuth tokens and API keys, stored in `mcp_providers.bearer_token_enc`
- `authType` defaults to `'oauth'` for every provider (including pre-existing rows migrated forward and registry-installed providers) — Bearer Token is opt-in per server
- A bearer-token connection never enters `awaiting-auth`: the token is static and known up front, so `client.connect()` either succeeds or fails straight to `error` (e.g. wrong/expired token → 401 surfaces as a connect error, not a re-auth prompt)
- Changing a provider's URL, transport or auth mode clears its stored OAuth tokens, client registration and discovery state. Credentials tied to one endpoint must not be reused at another. Renaming preserves them; bearer tokens retain their separate write-only, omit-to-preserve semantics.

### Stdio Environment

What a local (`stdio`) MCP server process inherits from Cinna. This behaviour **changed**: it previously received either the MCP SDK's minimal default environment (when the server had no `env` map) or the app's whole `process.env` (when it did). It now receives one rule on both branches.

**The rule: the MCP SDK's inherit-allowlist, valued from the user's login-shell environment, plus three named additions, with the server's own `env` map merged on top. `config.env` always wins.**

- **Why the login shell.** A Dock-launched app on macOS inherits `launchd`'s environment — a bare `PATH`, and none of the user's profile. That is why a server command resolved when the app was started from a terminal but not otherwise, and why passing `process.env` never fixed it. Cinna now asks the user's login shell for its environment once and takes `PATH` (and the rest of the inherited set) from there. See [Shell Environment Resolution](../../development/shell_environment/shell_environment.md)
- **Why not the whole shell environment.** Sourcing `.zshrc` / `.bashrc` is exactly how `ANTHROPIC_API_KEY`, `GITHUB_TOKEN` and `AWS_SECRET_ACCESS_KEY` reach a shell. Handing that wholesale to a third-party binary would widen every one of those secrets' blast radius. The inherited set is therefore an allowlist imported from the SDK — on POSIX exactly `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`

The three additions each have a **different** justification:

1. **`PATHEXT` (Windows only)** — a deliberate addition, *not* SDK parity. Without it a server cannot resolve the `.cmd` shims `npm` and `uv` install on Windows
2. **Session variables** — `SSH_AUTH_SOCK`, `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS`, `TMPDIR`. These are already in a GUI-launched app's environment, so a server with an `env` map receives them **today**; omitting them would be a regression, not a hypothetical. `SSH_AUTH_SOCK` is the sharp case — a git-over-SSH server would silently lose agent auth on private repos
3. **Proxy / CA variables** — `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY` (and lowercase) plus `NODE_EXTRA_CA_CERTS`, taken from **`process.env` only, never from the shell dump**. On Windows (full user environment from Explorer, where IT and MDM push these) and Linux (display manager sourcing `/etc/environment`) a server has them today, so dropping them would regress. On macOS they arrive only as a shell export, so sourcing them from the shell would be *new capability* rather than regression protection — and reading them from `process.env` means a `.zshrc` export cannot introduce or overwrite them. Where both sources have a variable, `process.env` wins. The motivation for the split: a proxy URL routinely embeds credentials, and `NODE_EXTRA_CA_CERTS` changes TLS trust for a third-party child

Deliberately **not** inherited: `NODE_PATH` and `npm_config_*` — shell exports on every platform, so omitting them regresses nothing, and they redirect where a child resolves its code.

Also:

- **Values starting with `()` are dropped**, whatever their name. That is bash's encoding of an exported shell function (the Shellshock surface), which a login-shell dump can contain and the app's own environment effectively cannot
- **The user-visible consequence, stated plainly: this narrows what a stdio MCP server can read.** A server that silently relied on an inherited variable outside this set will need that variable added to its own `env` map
- **The `env` map is the answer to "my server needs variable X".** It is a per-variable, per-server, explicit opt-in — deliberately not a global toggle
- **The diagnostic**: on every stdio connect a debug log line names the variables the old behaviour would have passed and this rule drops. **Names only, never values.** When a server stops working for a reason that looks unrelated, that line is the one-minute diagnosis — see [Logger](../../development/logger/logger.md), scope `MCP`

### Protocol negotiation and tool results

- Streamable HTTP uses the SDK's automatic modern/legacy negotiation, including the fresh connection after OAuth. Discovery is bounded to 10 seconds with zero probe retries. A legacy method-not-found response can fall back to initialization; authentication errors, permission errors and server failures do not silently select another protocol.
- Legacy SSE and stdio use legacy negotiation explicitly. SSE remains usable and is labelled **SSE (deprecated)** in the transport selector on a stdio card; selecting it switches that editor to URL/auth fields. Existing remote cards do not expose this selector.
- Client ID Metadata Documents (CIMD) are unconfigured: no hosted native-client metadata URL is supplied or owned by this app. Dynamic Client Registration remains the implemented authorization flow.
- Tool-level `isError` stays attached to the returned content. Deferred or other unsupported result shapes are rejected instead of being reported as successful empty output. MCP Tasks/resume support is not implemented here: the required official SDK lifecycle is unavailable for this conditional slice. The client advertises neither Tasks nor elicitation and starts no Tasks poller.
- If a connected tool needs new authorization or broader scope, its connection fails with **Authorization needs attention. Connect again in MCP settings.** A tool call does not silently open a new browser flow or grant more scope.

### Connection Lifecycle & Concurrency

- **Ownership survives every await.** Each connect/disconnect advances a generation before joining the per-provider queue. OAuth writes also require the captured user, provider and configuration revision in the database. A replaced or deleted configuration cannot receive late tokens, tools or status. Failed credential persistence remains fatal to that connection instead of being swallowed and retried as a new browser authorization.
- **One live connection per provider.** Connect and disconnect requests for the same provider are serialized, so they never overlap — a double-clicked Reconnect, or a re-activation landing mid-handshake, cannot leave two live sessions behind. Different providers connect concurrently
- **A superseded attempt is discarded silently.** When a newer connect or a disconnect replaces an attempt that is still waiting on the network, the abandoned attempt closes its own session and reports nothing: it does not set `error`, and it does not overwrite the surviving attempt's status. Only the surviving attempt reports. Users should never see a transient failure caused purely by an internal reconnect
- **Genuine failures still surface.** Config errors that fail before a connection is established (missing URL, missing bearer token) and real network/auth failures always report `error` with the underlying message
- **A pending OAuth authorization never blocks teardown.** Because the browser round-trip is user-paced, Disconnect, sign-out, and profile switch take effect immediately rather than queueing behind an unfinished auth flow. If the flow later completes for a connection that is no longer live, its result is thrown away
- **The status a user sees is always the live connection's status** — a late-completing attempt can never resurrect a provider the user just disconnected

## Architecture Overview

```
Settings UI -> IPC -> MCPManager.connect(config)
  -> Serialize per provider (close any existing connection first)
  -> Create transport (Stdio / SSE / StreamableHTTP)
       Stdio: env = SDK allowlist + session vars (+ PATHEXT on win32)
                    valued from the login shell,
                    + proxy/CA vars from process.env,
                    then config.env merged on top (config.env wins)
  -> For remote transports, branch on authType:
       'bearer' -> static Authorization header
       'oauth'  -> attach ElectronOAuthProvider (DCR, browser round-trip)
  -> MCP Client.connect() + listTools()
  -> Cache tools in memory (unless superseded meanwhile — then discard)

Chat flow:
  LLM Adapter -> tool_use -> MCPManager.callTool(providerId, toolName, input)
    -> MCP Client.callTool() -> result back to LLM
```

## OAuth DCR Flow (Remote Servers)

1. MCPManager creates `ElectronOAuthProvider` for Streamable HTTP with stored SDK token, registration and discovery state.
2. The native public client declares `application_type: native` and `token_endpoint_auth_method: none`; a bound loopback listener and random state exist before authorization starts.
3. The SDK handles authorization-server discovery, issuer checks, registration, PKCE and token refresh. Browser authorization opens through `shell.openExternal()` when needed during connection.
4. The listener validates the callback and preserves its complete query parameters, including issuer and OAuth error fields, for `transport.finishAuth(searchParams)`.
5. Token exchange and durable token/registration/discovery writes must still belong to the same configuration and live attempt. The in-memory state changes only after persistence succeeds.
6. A fresh client and transport reconnect with the same automatic HTTP negotiation and list tools. Only then does the app report connected; the callback listener and verifier are cleared. A consumed or expired listener cannot start another authorization; a new connection is required.

The flow is abandoned — with the connection left untouched — if the user disconnects the provider, signs out, or switches profile while the browser step is pending, or if the callback doesn't arrive within 2 minutes.

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
- [Shell Environment Resolution](../../development/shell_environment/shell_environment.md) — the login-shell resolver the stdio spawn draws `PATH` and the inherited set from; the narrowing rule lives there in full
- Database — MCP configs, OAuth tokens, and chat-MCP junction stored in SQLite
