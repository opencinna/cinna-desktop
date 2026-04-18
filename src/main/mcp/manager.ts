import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { McpProviderConfig, McpTool, McpConnection } from './types'
import { ElectronOAuthProvider, OAuthStoredState } from './oauth-provider'
import { encryptApiKey, decryptApiKey } from '../security/keystore'
import { getDb } from '../db/client'
import { mcpProviders } from '../db/schema'
import { eq } from 'drizzle-orm'
import { createLogger } from '../logger/logger'

const logger = createLogger('MCP')

type AnyTransport = StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport

interface InternalConnection extends McpConnection {
  client?: Client
  transport?: AnyTransport
  oauthProvider?: ElectronOAuthProvider
}

class MCPManager {
  private connections = new Map<string, InternalConnection>()

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
          connection.status = 'awaiting-auth'
          this.connections.set(config.id, connection)
          logger.info(`${config.name}: awaiting OAuth authorization...`)

          // Wait for the callback in the background
          this.handleOAuthCallback(config.id).catch((authErr) => {
            logger.error(`OAuth failed for ${config.name}`, authErr)
            connection.status = 'error'
            connection.error = `OAuth failed: ${String(authErr)}`
            this.connections.set(config.id, connection)
          })

          return this.toPublic(connection)
        }
        throw err
      }

      // Connected successfully (no auth needed, or tokens were valid)
      const tools = await this.listToolsFromClient(client, config.id)
      connection.tools = tools
      connection.status = 'connected'

      if (connection.oauthProvider) {
        connection.oauthProvider.cleanup()
      }

      this.connections.set(config.id, connection)
      logger.info(`Connected: ${config.name} (${tools.length} tools)`)
      return this.toPublic(connection)
    } catch (err) {
      connection.status = 'error'
      connection.error = String(err)
      if (connection.oauthProvider) {
        connection.oauthProvider.cleanup()
      }
      this.connections.set(config.id, connection)
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
    conn.status = 'connected'
    conn.error = undefined

    conn.oauthProvider.cleanup()
    this.connections.set(providerId, conn)
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
      const db = getDb()
      const encrypted = encryptApiKey(JSON.stringify(tokens))
      db.update(mcpProviders)
        .set({ authTokensEncrypted: encrypted })
        .where(eq(mcpProviders.id, providerId))
        .run()
    } catch (err) {
      console.error(`Failed to persist OAuth tokens for ${providerId}:`, err)
    }
  }

  private persistClientInfo(
    providerId: string,
    clientInfo: import('@modelcontextprotocol/sdk/shared/auth.js').OAuthClientInformationMixed
  ): void {
    try {
      const db = getDb()
      db.update(mcpProviders)
        .set({ clientInfo: clientInfo as Record<string, unknown> })
        .where(eq(mcpProviders.id, providerId))
        .run()
    } catch (err) {
      console.error(`Failed to persist client info for ${providerId}:`, err)
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
        console.error(`Error disconnecting MCP ${providerId}:`, err)
      }
      this.connections.delete(providerId)
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

    const result = await conn.client.callTool({ name: toolName, arguments: input })
    return result.content
  }
}

export const mcpManager = new MCPManager()
