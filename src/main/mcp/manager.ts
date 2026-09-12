import { Client, SSEClientTransport, StreamableHTTPClientTransport, UnauthorizedError, InsufficientScopeError, isCallToolResult } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { McpProviderConfig, McpTool, McpConnection } from './types'
import { ElectronOAuthProvider, McpReauthorizationRequiredError, OAuthStoredState } from './oauth-provider'
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
  generation: number
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

export class MCPManager {
  private generations = new Map<string, number>()
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
    if (this.isSuperseded(providerId, connection)) return
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
    const row = mcpProviderRepo.getOwned(connection.config.userId, providerId)
    return this.connections.get(providerId) !== connection || this.generations.get(providerId) !== connection.generation ||
      !row || row.configRevision !== connection.config.configRevision
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
    if (this.connections.get(providerId) === connection && this.isSuperseded(providerId, connection)) {
      this.connections.delete(providerId)
      broadcastStatusChange(providerId, 'disconnected')
    }
    logger.debug(reason, { providerId, providerName: connection.config.name })
  }

  private invalidate(providerId: string): number {
    const next = (this.generations.get(providerId) ?? 0) + 1
    this.generations.set(providerId, next)
    const old = this.connections.get(providerId)
    old?.oauthProvider?.cleanup()
    // Invalidate before queueing; pending SDK requests must not hold Disconnect
    // behind an abandoned browser flow or write tokens over a replacement.
    void old?.client?.close().catch(() => {})
    return next
  }

  private assertCurrent(connection: InternalConnection): void {
    if (this.isSuperseded(connection.config.id, connection)) throw new Error('The MCP connection or configuration changed. Connect again.')
  }

  private createClient(config: McpProviderConfig): Client {
    return new Client({ name: 'cinna-desktop', version: '0.1.0' }, {
      capabilities: {},
      versionNegotiation: { mode: config.transportType === 'streamable-http' ? 'auto' : 'legacy', probe: { timeoutMs: 10_000, maxRetries: 0 } }
    })
  }

  async connect(config: McpProviderConfig): Promise<McpConnection> {
    const generation = this.invalidate(config.id)
    return this.enqueue(config.id, () => this._connect(config, generation))
  }

  private async _connect(config: McpProviderConfig, generation: number): Promise<McpConnection> {
    if (this.generations.get(config.id) !== generation) return { config, tools: [], status: 'disconnected' }
    await this._disconnect(config.id)
    const connection: InternalConnection = { config, generation, tools: [], status: 'disconnected' }
    if (this.generations.get(config.id) !== generation) return this.toPublic(connection)
    this.connections.set(config.id, connection)
    try {
      this.assertCurrent(connection)
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
        this.assertCurrent(connection)
        transport = new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: mergeEnv(shellEnvForChild(shellEnv), config.env)
        })
      } else if ((config.transportType === 'streamable-http' || config.transportType === 'sse') && config.authType === 'bearer') {
        if (!config.url) throw new Error('URL is required for streamable-http transport')
        transport = new (config.transportType === 'sse' ? SSEClientTransport : StreamableHTTPClientTransport)(new URL(config.url), {
          requestInit: { headers: this.bearerAuthHeaders(config) }
        })
      } else if (config.transportType === 'streamable-http' || config.transportType === 'sse') {
        if (!config.url) throw new Error('URL is required for streamable-http transport')

        // Build OAuth provider for streamable-http (supports DCR)
        const storedState: OAuthStoredState = { discovery: config.oauthDiscoveryState }

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
          storedState.clientInfo = (typeof config.clientInfo.encrypted === 'string'
            ? JSON.parse(decryptApiKey(Buffer.from(config.clientInfo.encrypted, 'base64')))
            : config.clientInfo) as import('@modelcontextprotocol/client').StoredOAuthClientInformation
          if (typeof config.clientInfo.encrypted !== 'string') this.persistOAuth(connection, { clientInfo: storedState.clientInfo })
        }

        const oauthProvider = new ElectronOAuthProvider(storedState, {
          assertCurrent: () => this.assertCurrent(connection),
          save: (patch) => this.persistOAuth(connection, patch)
        })

        // Prepare callback server before connecting
        connection.oauthProvider = oauthProvider
        await oauthProvider.prepareForAuth()
        transport = new (config.transportType === 'sse' ? SSEClientTransport : StreamableHTTPClientTransport)(new URL(config.url), {
          authProvider: oauthProvider, onInsufficientScope: 'throw'
        })
      } else {
        throw new Error(`Unknown transport type: ${config.transportType}`)
      }

      this.assertCurrent(connection)
      const client = this.createClient(config)

      connection.client = client
      connection.transport = transport
      this.connections.set(config.id, connection)

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
          this.handleOAuthCallback(config.id).catch(async (authErr) => {
            if (this.isSuperseded(config.id, connection)) {
              await this.discardSuperseded(connection, 'oauth flow superseded, ignoring failure', config.id)
              return
            }
            await this.discardSuperseded(connection, 'OAuth failed; closing connection', config.id)
            logger.error(`OAuth failed for ${config.name}`, authErr)
            this.setStatus(config.id, connection, 'error', `OAuth failed: ${String(authErr)}`)
          })

          return this.toPublic(connection)
        }
        throw err
      }

      // Connected successfully (no auth needed, or tokens were valid).
      this.assertCurrent(connection)
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
      // A concurrent disconnect or configuration edit may close this client
      // while connect or listTools is still awaiting a response.
      if (this.isSuperseded(config.id, connection)) {
        await this.discardSuperseded(
          connection,
          'connect superseded, ignoring failure',
          config.id
        )
        return this.toPublic(connection)
      }
      await this.discardSuperseded(connection, 'connect failed; closing connection', config.id)
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

    const httpTransport = conn.transport as StreamableHTTPClientTransport | SSEClientTransport
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
    const freshTransport = new (conn.config.transportType === 'sse' ? SSEClientTransport : StreamableHTTPClientTransport)(
      new URL(conn.config.url!),
      { authProvider: conn.oauthProvider, onInsufficientScope: 'throw' }
    )
    await conn.client?.close()
    this.assertCurrent(conn)
    conn.transport = freshTransport

    // Now reconnect with a fresh client + transport
    const client = this.createClient(conn.config)
    conn.client = client

    await client.connect(freshTransport)
    this.assertCurrent(conn)

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

  private persistOAuth(connection: InternalConnection, patch: Parameters<import('./oauth-provider').OAuthProviderCallbacks['save']>[0]): void {
    this.assertCurrent(connection)
    const stored: Parameters<typeof mcpProviderRepo.saveOAuthState>[3] = {}
    if ('tokens' in patch) stored.authTokensEncrypted = patch.tokens ? encryptApiKey(JSON.stringify(patch.tokens)) : null
    if ('clientInfo' in patch) stored.clientInfo = patch.clientInfo ? { encrypted: encryptApiKey(JSON.stringify(patch.clientInfo)).toString('base64') } : null
    if ('discovery' in patch) stored.oauthDiscoveryState = patch.discovery ?? null
    mcpProviderRepo.saveOAuthState(connection.config.userId, connection.config.id, connection.config.configRevision, stored)
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
    this.invalidate(providerId)
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
    await Promise.all([...ids].map((id) => this.disconnect(id)))
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
  ): Promise<{ content: unknown; isError?: boolean }> {
    const captured = this.connections.get(providerId)
    return this.enqueue(providerId, () => {
      if (this.connections.get(providerId) !== captured) throw new Error('The MCP connection changed before this tool call could run.')
      return this.callToolSerialized(providerId, toolName, input)
    })
  }

  private async callToolSerialized(providerId: string, toolName: string, input: Record<string, unknown>): Promise<{ content: unknown; isError?: boolean }> {
    const conn = this.connections.get(providerId)
    if (!conn || !conn.client || conn.status !== 'connected') {
      throw new Error(`MCP provider ${providerId} not connected`)
    }

    const started = Date.now()
    try {
      this.assertCurrent(conn)
      const result = await conn.client.callTool({ name: toolName, arguments: input })
      this.assertCurrent(conn)
      if (!isCallToolResult(result)) throw new Error('The MCP server returned an unsupported tool result.')
      logger.debug('tool ok', {
        providerId,
        providerName: conn.config.name,
        tool: toolName,
        duration: Date.now() - started
      })
      return { content: result.content, isError: result.isError }
    } catch (err) {
      if (err instanceof UnauthorizedError || err instanceof InsufficientScopeError || err instanceof McpReauthorizationRequiredError || conn.oauthProvider?.hasPersistenceFailure()) {
        await this.discardSuperseded(conn, 'Tool authorization failed; closing connection', providerId)
        this.setStatus(providerId, conn, 'error', 'Authorization needs attention. Connect again in MCP settings.')
      }
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
