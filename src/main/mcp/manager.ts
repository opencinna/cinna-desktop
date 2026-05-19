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

  async connect(config: McpProviderConfig): Promise<McpConnection> {
    // Disconnect existing if any
    await this.disconnect(config.id)

    const connection: InternalConnection = {
      config,
      tools: [],
      status: 'disconnected'
    }

    try {
      let transport: AnyTransport

      if (config.transportType === 'stdio') {
        if (!config.command) throw new Error('Command is required for stdio transport')
        transport = new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: config.env ? { ...process.env, ...config.env } as Record<string, string> : undefined
        })
      } else if (config.transportType === 'sse') {
        if (!config.url) throw new Error('URL is required for SSE transport')
        transport = new SSEClientTransport(new URL(config.url))
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

      try {
        await client.connect(transport)
      } catch (err) {
        if (err instanceof UnauthorizedError && connection.oauthProvider) {
          // OAuth flow initiated — browser was opened for user to authorize
          this.setStatus(config.id, connection, 'awaiting-auth')
          logger.info(`${config.name}: awaiting OAuth authorization...`)

          // Wait for the callback in the background
          this.handleOAuthCallback(config.id).catch((authErr) => {
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

      this.setStatus(config.id, connection, 'connected')
      logger.info(`Connected: ${config.name} (${tools.length} tools)`)
      return this.toPublic(connection)
    } catch (err) {
      if (connection.oauthProvider) {
        connection.oauthProvider.cleanup()
      }
      this.setStatus(config.id, connection, 'error', String(err))
      logger.error(`Connect failed for ${config.name}`, err)
      return this.toPublic(connection)
    }
  }

  private async handleOAuthCallback(providerId: string): Promise<void> {
    const conn = this.connections.get(providerId)
    if (!conn?.oauthProvider || !conn.transport) return

    const httpTransport = conn.transport as StreamableHTTPClientTransport
    const code = await conn.oauthProvider.waitForAuthCode()

    // Exchange the auth code for tokens
    await httpTransport.finishAuth(code)

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
    this.setStatus(providerId, conn, 'connected')
    logger.info(`Connected after OAuth: ${conn.config.name} (${tools.length} tools)`)
  }

  private async listToolsFromClient(client: Client, providerId: string): Promise<McpTool[]> {
    const toolsResult = await client.listTools()
    return toolsResult.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema as Record<string, unknown>,
      mcpProviderId: providerId
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
    const conn = this.connections.get(providerId)
    if (conn) {
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
      this.connections.delete(providerId)
      // Notify the renderer so any UI that had been showing this provider as
      // `connected` flips back to `disconnected` immediately.
      broadcastStatusChange(providerId, 'disconnected')
    }
  }

  async disconnectAll(): Promise<void> {
    const ids = Array.from(this.connections.keys())
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
