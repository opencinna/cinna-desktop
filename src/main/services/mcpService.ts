import { mcpProviderRepo, McpProviderRow } from '../db/mcpProviders'
import { mcpManager } from '../mcp/manager'
import { McpError } from '../errors'
import { McpProviderConfig } from '../mcp/types'
import { createLogger } from '../logger/logger'

const logger = createLogger('MCP')

const VALID_TRANSPORTS = new Set(['stdio', 'sse', 'streamable-http'])

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
}

function assertTransport(t: string): asserts t is 'stdio' | 'sse' | 'streamable-http' {
  if (!VALID_TRANSPORTS.has(t)) {
    throw new McpError('invalid_transport', `Unknown transport type: ${t}`)
  }
}

function toConfig(row: McpProviderRow): McpProviderConfig {
  return {
    id: row.id,
    name: row.name,
    transportType: row.transportType as 'stdio' | 'sse' | 'streamable-http',
    command: row.command ?? undefined,
    args: (row.args as string[] | null) ?? undefined,
    url: row.url ?? undefined,
    env: (row.env as Record<string, string> | null) ?? undefined,
    enabled: row.enabled,
    authTokensEncrypted: row.authTokensEncrypted ?? undefined,
    clientInfo: (row.clientInfo as Record<string, unknown> | null) ?? undefined
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
    hasAuth: !!(row.authTokensEncrypted || row.clientInfo),
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

    const { id, created, row } = mcpProviderRepo.upsert(userId, {
      id: input.id,
      name: input.name,
      transportType: input.transportType,
      command: input.command ?? null,
      args: input.args ?? null,
      url: input.url ?? null,
      env: input.env ?? null,
      enabled: input.enabled
    })

    logger.info(created ? 'mcp created' : 'mcp updated', {
      providerId: id,
      transport: row.transportType,
      enabled: row.enabled
    })

    if (row.enabled) {
      await mcpManager.connect(toConfig(row))
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
    logger.info('mcp deleted', { providerId: id })
  },

  async connect(
    userId: string,
    id: string
  ): Promise<{ tools: unknown[]; status: string }> {
    const row = mcpProviderRepo.getOwned(userId, id)
    if (!row) throw new McpError('not_found', 'MCP provider not found')

    const conn = await mcpManager.connect(toConfig(row))
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
