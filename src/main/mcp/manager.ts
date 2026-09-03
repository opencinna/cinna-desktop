import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { McpProviderConfig, McpTool, McpConnection } from './types'
import { ElectronOAuthProvider, OAuthStoredState } from './oauth-provider'
import { encryptApiKey, decryptApiKey } from '../security/keystore'
import { mcpProviderRepo } from '../db/mcpProviders'
import { createLogger } from '../logger/logger'
import { getMainWindow } from '../index'
import { droppedChildEnvNames, getShellEnv, mergeEnv, shellEnvForChild } from '../shell/env'

/**
 * Channel the main process uses to tell the renderer that one or more MCP
 * connection states have changed (connected ↔ disconnected ↔ awaiting-auth ↔
 * error). The renderer reacts by invalidating its `mcp-providers` query so
 * UI surfaces — Settings cards, the on-demand `@` picker, the chips below
 * the composer — reflect the new status without a manual refresh.
 */
export const MCP_STATUS_CHANGED_CHANNEL = 'mcp:status-changed'

const logger = createLogger('MCP')

type AnyTransport = StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport

interface InternalConnection extends McpConnection {
  client?: Client
  transport?: AnyTransport
  oauthProvider?: ElectronOAuthProvider
}

function broadcastStatusChange(providerId: string, status: string): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(MCP_STATUS_CHANGED_CHANNEL, { providerId, status })
  }
}

class MCPManager {
  private connections = new Map<string, InternalConnection>()
  /** Tail of each provider's task queue — see `enqueue()`. */
  private queues = new Map<string, Promise<unknown>>()

  /**
   * Serialize lifecycle work per provider. The map holds one entry per id, so
   * two overlapping `connect()` calls would each build a client and only the
   * last-registered one would be reachable — the other's HTTP/SSE session (or
   * stdio child process) would leak with nothing left holding a handle to close
   * it. Queueing makes "close the old one, then open the new one" atomic per
   * provider; different providers still run concurrently.
   *
   * The internal `_connect`/`_disconnect` must never enqueue — they already run
   * inside the queue, so re-entering it would deadlock.
   */
  private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(providerId) ?? Promise.resolve()
    // Run `task` whether the previous entry resolved or rejected — one failed
    // connect must not wedge the provider's queue forever.
    const result = prev.then(task, task)
    const tail = result.then(
      () => {},
      () => {}
    )
    this.queues.set(providerId, tail)
    void tail.then(() => {
      // Only the current tail may clean up, or we'd drop a queue that a later
      // call has already chained onto.
      if (this.queues.get(providerId) === tail) {
        this.queues.delete(providerId)
      }
    })
    return result
  }

  /**
   * Persist the status on the connection and notify the renderer. Centralised
   * so every transition (connect, disconnect, OAuth completion, error) goes
   * through the same broadcast — the renderer's `useMcpProviders` listener
   * invalidates its React Query cache off the back of this event.
   */
  private setStatus(
    providerId: string,
    connection: InternalConnection,
    status: McpConnection['status'],
    error?: string
  ): void {
    connection.status = status
    if (error !== undefined) {
      connection.error = error
    } else if (status === 'connected') {
      connection.error = undefined
    }
    this.connections.set(providerId, connection)
    broadcastStatusChange(providerId, status)
  }

  /**
   * True when `connection` is no longer the live entry for the provider — a
   * later `connect()` or a `disconnect()`/`disconnectAll()` replaced or removed
   * it while this attempt was awaiting the network. The superseding call closed
   * our client (which is what surfaces as `McpError -32000: Connection closed`)
   * and owns the status broadcast, so a superseded attempt must not log an
   * error, must not overwrite the status, and must not re-insert itself into
   * the map.
   */
  private isSuperseded(providerId: string, connection: InternalConnection): boolean {
    return this.connections.get(providerId) !== connection
  }

  /**
   * Give up on a connection attempt whose entry is no longer live. Closes our
   * client so the superseded session doesn't linger — the superseding call only
   * closed whatever *it* found in the map, which may not be us (the OAuth
   * callback runs outside the per-provider queue by design, see
   * `handleOAuthCallback`).
   */
  private async discardSuperseded(
    connection: InternalConnection,
    reason: string,
    providerId: string
  ): Promise<void> {
    connection.oauthProvider?.cleanup()
    try {
      await connection.client?.close()
    } catch {
      // Already closing/closed — nothing to salvage.
    }
    logger.debug(reason, { providerId, providerName: connection.config.name })
  }

  async connect(config: McpProviderConfig): Promise<McpConnection> {
    return this.enqueue(config.id, () => this._connect(config))
  }

  private async _connect(config: McpProviderConfig): Promise<McpConnection> {
    // Disconnect existing if any. Calls the unqueued form — we hold the queue.
    await this._disconnect(config.id)

    const connection: InternalConnection = {
      config,
      tools: [],
      status: 'disconnected'
    }

    /** Set once `connection` is in the map, i.e. once supersession is meaningful. */
    let registered = false

    try {
      let transport: AnyTransport

      if (config.transportType === 'stdio') {
        if (!config.command) throw new Error('Command is required for stdio transport')
        // What changed: `PATH` (and the rest of the inherited set) now comes
        // from the user's *login shell* rather than from the app's own
        // environment. A Dock-launched app inherits launchd's bare env, which
        // is why `uvx`/`npx`-style commands resolved when the app was started
        // from a terminal but not otherwise — and why passing `process.env`
        // here never fixed it.
        //
        // What deliberately did NOT change: a server does not become able to
        // read the user's secrets. `shellEnvForChild` narrows to the SDK's own
        // inherit-allowlist plus the session variables a GUI-launched process
        // already carried (`SSH_AUTH_SOCK` and friends — dropping those would
        // regress a git-over-SSH server), so the API keys that live in
        // `.zshrc`/`.bashrc` — which is exactly what `getShellEnv()` goes and
        // reads — stay out of a third-party binary's environment.
        // `config.env` is still merged on top and still wins.
        const shellEnv = await getShellEnv()
        // Narrowing means some server, somewhere, loses a variable it silently
        // relied on, and the failure will not look like it came from here. Name
        // what was dropped once per connect so that report is a one-minute
        // diagnosis. NAMES ONLY — the dropped set is the secret-bearing half of
        // the environment, so a value here would leak into the log buffer
        // exactly what this rule keeps out of the child process.
        logger.debug('stdio env narrowed to the inherit allowlist', {
          providerId: config.id,
          dropped: droppedChildEnvNames(shellEnv, config.env)
        })
        transport = new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: mergeEnv(shellEnvForChild(shellEnv), config.env)
        })
      } else if (config.transportType === 'sse') {
        if (!config.url) throw new Error('URL is required for SSE transport')
        transport =
          config.authType === 'bearer'
            ? new SSEClientTransport(new URL(config.url), {
                requestInit: { headers: this.bearerAuthHeaders(config) }
              })
            : new SSEClientTransport(new URL(config.url))
      } else if (config.transportType === 'streamable-http' && config.authType === 'bearer') {
        if (!config.url) throw new Error('URL is required for streamable-http transport')
        transport = new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: this.bearerAuthHeaders(config) }
        })
      } else if (config.transportType === 'streamable-http') {
        if (!config.url) throw new Error('URL is required for streamable-http transport')

        // Build OAuth provider for streamable-http (supports DCR)
        const storedState: OAuthStoredState = {}

        // Restore persisted tokens
        if (config.authTokensEncrypted) {
          try {
            const json = decryptApiKey(config.authTokensEncrypted)
            storedState.tokens = JSON.parse(json)
          } catch {
            // Corrupted tokens — will re-auth
          }
        }

        // Restore persisted client info
        if (config.clientInfo) {
          storedState.clientInfo = config.clientInfo as
            import('@modelcontextprotocol/sdk/shared/auth.js').OAuthClientInformationMixed
        }

        const oauthProvider = new ElectronOAuthProvider(storedState, {
          onTokens: (tokens) => this.persistTokens(config.id, tokens),
          onClientInfo: (clientInfo) => this.persistClientInfo(config.id, clientInfo)
        })

        // Prepare callback server before connecting
        await oauthProvider.prepareForAuth()

        connection.oauthProvider = oauthProvider
        transport = new StreamableHTTPClientTransport(new URL(config.url), {
          authProvider: oauthProvider
        })
      } else {
        throw new Error(`Unknown transport type: ${config.transportType}`)
      }

      const client = new Client(
        { name: 'cinna-desktop', version: '0.1.0' },
        { capabilities: {} }
      )

      connection.client = client
      connection.transport = transport
      this.connections.set(config.id, connection)
      registered = true

      try {
        await client.connect(transport)
      } catch (err) {
        if (this.isSuperseded(config.id, connection)) {
          await this.discardSuperseded(
            connection,
            'connect superseded, ignoring failure',
            config.id
          )
          return this.toPublic(connection)
        }
        if (err instanceof UnauthorizedError && connection.oauthProvider) {
          // OAuth flow initiated — browser was opened for user to authorize
          this.setStatus(config.id, connection, 'awaiting-auth')
          logger.info(`${config.name}: awaiting OAuth authorization...`)

          // Wait for the callback in the background
          this.handleOAuthCallback(config.id).catch((authErr) => {
            if (this.isSuperseded(config.id, connection)) {
              logger.debug('oauth flow superseded, ignoring failure', {
                providerId: config.id,
                providerName: config.name
              })
              return
            }
            logger.error(`OAuth failed for ${config.name}`, authErr)
            this.setStatus(config.id, connection, 'error', `OAuth failed: ${String(authErr)}`)
          })

          return this.toPublic(connection)
        }
        throw err
      }

      // Connected successfully (no auth needed, or tokens were valid)
      const tools = await this.listToolsFromClient(client, config.id)
      connection.tools = tools

      if (connection.oauthProvider) {
        connection.oauthProvider.cleanup()
      }

      // A disconnect that landed between `listTools()` resolving and here
      // already closed this client — don't resurrect it in the map.
      if (this.isSuperseded(config.id, connection)) {
        await this.discardSuperseded(
          connection,
          'connect superseded, discarding result',
          config.id
        )
        return this.toPublic(connection)
      }

      this.setStatus(config.id, connection, 'connected')
      logger.info(`Connected: ${config.name} (${tools.length} tools)`)
      return this.toPublic(connection)
    } catch (err) {
      if (connection.oauthProvider) {
        connection.oauthProvider.cleanup()
      }
      // Same supersession check as above — covers `listTools()` failing because
      // a concurrent disconnect closed the client under us. `registered` keeps
      // pre-registration failures (bad URL, missing bearer token — the map has
      // no entry for us yet) out of this branch so they still surface.
      if (registered && this.isSuperseded(config.id, connection)) {
        await this.discardSuperseded(
          connection,
          'connect superseded, ignoring failure',
          config.id
        )
        return this.toPublic(connection)
      }
      this.setStatus(config.id, connection, 'error', String(err))
      logger.error(`Connect failed for ${config.name}`, err)
      return this.toPublic(connection)
    }
  }

  /** Static bearer-token auth: no DCR, no browser round-trip — just a header. */
  private bearerAuthHeaders(config: McpProviderConfig): Record<string, string> {
    if (!config.bearerTokenEncrypted) {
      throw new Error('Bearer token is required for bearer auth')
    }
    const token = decryptApiKey(config.bearerTokenEncrypted)
    return { Authorization: `Bearer ${token}` }
  }

  /**
   * Finish a browser-based OAuth flow and reconnect. Deliberately runs *outside*
   * the per-provider queue: `waitForAuthCode()` blocks for as long as the user
   * takes in the browser, and holding the queue that long would make an
   * explicit Disconnect (or a profile switch) hang behind an abandoned auth
   * flow. The cost of staying outside the queue is that a concurrent
   * connect/disconnect can supersede us at any await, so every step re-checks
   * before touching shared state.
   */
  private async handleOAuthCallback(providerId: string): Promise<void> {
    const conn = this.connections.get(providerId)
    if (!conn?.oauthProvider || !conn.transport) return

    const httpTransport = conn.transport as StreamableHTTPClientTransport
    const code = await conn.oauthProvider.waitForAuthCode()
    if (this.isSuperseded(providerId, conn)) {
      return this.discardSuperseded(conn, 'oauth callback superseded before token exchange', providerId)
    }

    // Exchange the auth code for tokens
    await httpTransport.finishAuth(code)
    if (this.isSuperseded(providerId, conn)) {
      return this.discardSuperseded(conn, 'oauth callback superseded after token exchange', providerId)
    }

    // Create a fresh transport — the old one is already started and can't be reused
    const freshTransport = new StreamableHTTPClientTransport(
      new URL(conn.config.url!),
      { authProvider: conn.oauthProvider }
    )
    conn.transport = freshTransport

    // Now reconnect with a fresh client + transport
    const client = new Client(
      { name: 'cinna-desktop', version: '0.1.0' },
      { capabilities: {} }
    )
    conn.client = client

    await client.connect(freshTransport)

    const tools = await this.listToolsFromClient(client, providerId)
    conn.tools = tools

    conn.oauthProvider.cleanup()

    // Last check before `setStatus` — it re-inserts into the map, which would
    // resurrect a connection a concurrent disconnect had already removed.
    if (this.isSuperseded(providerId, conn)) {
      return this.discardSuperseded(conn, 'oauth callback superseded after reconnect', providerId)
    }

    this.setStatus(providerId, conn, 'connected')
    logger.info(`Connected after OAuth: ${conn.config.name} (${tools.length} tools)`)
  }

  private async listToolsFromClient(client: Client, providerId: string): Promise<McpTool[]> {
    const toolsResult = await client.listTools()
    return toolsResult.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema as Record<string, unknown>,
      mcpProviderId: providerId,
      providerType: 'mcp' as const
    }))
  }

  private persistTokens(
    providerId: string,
    tokens: import('@modelcontextprotocol/sdk/shared/auth.js').OAuthTokens
  ): void {
    try {
      const encrypted = encryptApiKey(JSON.stringify(tokens))
      mcpProviderRepo.setAuthTokens(providerId, encrypted)
    } catch (err) {
      logger.error(`Failed to persist OAuth tokens for ${providerId}`, err)
    }
  }

  private persistClientInfo(
    providerId: string,
    clientInfo: import('@modelcontextprotocol/sdk/shared/auth.js').OAuthClientInformationMixed
  ): void {
    try {
      mcpProviderRepo.setClientInfo(providerId, clientInfo as Record<string, unknown>)
    } catch (err) {
      logger.error(`Failed to persist client info for ${providerId}`, err)
    }
  }

  private toPublic(conn: InternalConnection): McpConnection {
    return {
      config: conn.config,
      tools: conn.tools,
      status: conn.status,
      error: conn.error
    }
  }

  async disconnect(providerId: string): Promise<void> {
    return this.enqueue(providerId, () => this._disconnect(providerId))
  }

  private async _disconnect(providerId: string): Promise<void> {
    const conn = this.connections.get(providerId)
    if (conn) {
      // Drop the map entry BEFORE closing the client. `client.close()` rejects
      // the client's pending requests synchronously, so an in-flight
      // `connect()` awaiting `initialize`/`listTools` resumes as a microtask
      // during the `await` below — i.e. before this method could continue.
      // Deleting afterwards meant that attempt still saw itself as the live
      // entry, failed `isSuperseded()`, and logged a bogus
      // `Connect failed … Connection closed` while overwriting the status.
      this.connections.delete(providerId)
      try {
        if (conn.oauthProvider) {
          conn.oauthProvider.cleanup()
        }
        if (conn.client) {
          await conn.client.close()
        }
      } catch (err) {
        logger.error(`Error disconnecting MCP ${providerId}`, err)
      }
      // Notify the renderer so any UI that had been showing this provider as
      // `connected` flips back to `disconnected` immediately.
      broadcastStatusChange(providerId, 'disconnected')
    }
  }

  async disconnectAll(): Promise<void> {
    // Union with `queues`: a provider whose `connect()` is still in flight has
    // no map entry yet, so keys alone would skip it and leave a live client
    // behind after a teardown (quit, sign-out, profile switch). Its queued
    // disconnect runs once that connect registers.
    const ids = new Set([...this.connections.keys(), ...this.queues.keys()])
    for (const id of ids) {
      await this.disconnect(id)
    }
  }

  getConnection(providerId: string): McpConnection | undefined {
    const conn = this.connections.get(providerId)
    if (!conn) return undefined
    return this.toPublic(conn)
  }

  getAllConnections(): McpConnection[] {
    return Array.from(this.connections.values()).map((c) => this.toPublic(c))
  }

  getToolsForProviders(providerIds: string[]): McpTool[] {
    const tools: McpTool[] = []
    for (const id of providerIds) {
      const conn = this.connections.get(id)
      if (conn && conn.status === 'connected') {
        tools.push(...conn.tools)
      }
    }
    return tools
  }

  async callTool(
    providerId: string,
    toolName: string,
    input: Record<string, unknown>
  ): Promise<unknown> {
    const conn = this.connections.get(providerId)
    if (!conn || !conn.client) {
      throw new Error(`MCP provider ${providerId} not connected`)
    }

    const started = Date.now()
    try {
      const result = await conn.client.callTool({ name: toolName, arguments: input })
      logger.debug('tool ok', {
        providerId,
        providerName: conn.config.name,
        tool: toolName,
        duration: Date.now() - started
      })
      return result.content
    } catch (err) {
      logger.error('tool failed', {
        providerId,
        providerName: conn.config.name,
        tool: toolName,
        duration: Date.now() - started,
        error: err instanceof Error ? err.message : String(err)
      })
      throw err
    }
  }
}

export const mcpManager = new MCPManager()
