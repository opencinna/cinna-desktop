import { mcpProviderRepo, McpProviderRow } from '../db/mcpProviders'
import { chatModeRepo } from '../db/chatModes'
import { mcpManager } from '../mcp/manager'
import { McpError } from '../errors'
import { mcpRowToConfig } from '../mcp/config'
import { encryptApiKey } from '../security/keystore'
import { createLogger } from '../logger/logger'

const logger = createLogger('MCP')

const VALID_TRANSPORTS = new Set(['stdio', 'sse', 'streamable-http'])
const VALID_AUTH_TYPES = new Set(['oauth', 'bearer'])

export interface McpProviderDto {
  id: string
  userId: string
  name: string
  transportType: string
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  enabled: boolean
  createdAt: Date
  hasAuth: boolean
  authType: string
  status: string
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
  error?: string
}

export interface UpsertMcpInput {
  id?: string
  name: string
  transportType: string
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  enabled?: boolean
  authType?: 'oauth' | 'bearer'
  /** Plaintext — encrypted here before it ever reaches the repo/DB. Omit to keep the existing token. */
  bearerToken?: string
}

function assertTransport(t: string): asserts t is 'stdio' | 'sse' | 'streamable-http' {
  if (!VALID_TRANSPORTS.has(t)) {
    throw new McpError('invalid_transport', `Unknown transport type: ${t}`)
  }
}

function assertAuthType(t: string): asserts t is 'oauth' | 'bearer' {
  if (!VALID_AUTH_TYPES.has(t)) {
    throw new McpError('invalid_auth_type', `Unknown auth type: ${t}`)
  }
}

function toDto(row: McpProviderRow): McpProviderDto {
  const conn = mcpManager.getConnection(row.id)
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    transportType: row.transportType,
    command: row.command ?? undefined,
    args: (row.args as string[] | null) ?? undefined,
    url: row.url ?? undefined,
    env: (row.env as Record<string, string> | null) ?? undefined,
    enabled: row.enabled,
    createdAt: row.createdAt,
    hasAuth: !!(row.authTokensEncrypted || row.clientInfo || row.bearerTokenEncrypted),
    authType: row.authType ?? 'oauth',
    status: conn?.status ?? 'disconnected',
    tools: conn?.tools ?? [],
    error: conn?.error
  }
}

export const mcpService = {
  list(userId: string): McpProviderDto[] {
    return mcpProviderRepo.list(userId).map(toDto)
  },

  async upsert(
    userId: string,
    input: UpsertMcpInput
  ): Promise<{ id: string; row: McpProviderDto }> {
    assertTransport(input.transportType)
    if (input.authType !== undefined) assertAuthType(input.authType)

    const { id, created, row } = mcpProviderRepo.upsert(userId, {
      id: input.id,
      name: input.name,
      transportType: input.transportType,
      command: input.command ?? null,
      args: input.args ?? null,
      url: input.url ?? null,
      env: input.env ?? null,
      enabled: input.enabled,
      authType: input.authType,
      bearerTokenEncrypted: input.bearerToken ? encryptApiKey(input.bearerToken) : undefined
    })

    logger.info(created ? 'mcp created' : 'mcp updated', {
      providerId: id,
      transport: row.transportType,
      authType: row.authType,
      enabled: row.enabled
    })

    if (row.enabled) {
      await mcpManager.connect(mcpRowToConfig(row))
    } else {
      await mcpManager.disconnect(row.id)
    }

    return { id, row: toDto(row) }
  },

  async delete(userId: string, id: string): Promise<void> {
    const row = mcpProviderRepo.getOwned(userId, id)
    if (!row) throw new McpError('not_found', 'MCP provider not found')
    await mcpManager.disconnect(id)
    mcpProviderRepo.delete(userId, id)
    // `chat_mcp_providers` is cleaned up by the FK cascade in the schema, but
    // `chat_modes.mcpProviderIds` is a JSON array without FK enforcement —
    // strip the dead id here so a chat created from an affected mode doesn't
    // crash on `chat:set-mcp-providers` with SQLITE_CONSTRAINT_FOREIGNKEY.
    const touchedModes = chatModeRepo.stripMcpProviderId(userId, id)
    logger.info('mcp deleted', { providerId: id, touchedModes })
  },

  async connect(
    userId: string,
    id: string
  ): Promise<{ tools: unknown[]; status: string }> {
    const row = mcpProviderRepo.getOwned(userId, id)
    if (!row) throw new McpError('not_found', 'MCP provider not found')

    const conn = await mcpManager.connect(mcpRowToConfig(row))
    return { tools: conn.tools, status: conn.status }
  },

  async disconnect(userId: string, id: string): Promise<void> {
    const row = mcpProviderRepo.getOwned(userId, id)
    if (!row) throw new McpError('not_found', 'MCP provider not found')
    await mcpManager.disconnect(id)
  },

  listTools(userId: string, id: string): unknown[] {
    const row = mcpProviderRepo.getOwned(userId, id)
    if (!row) throw new McpError('not_found', 'MCP provider not found')
    const conn = mcpManager.getConnection(id)
    return conn?.tools ?? []
  }
}
