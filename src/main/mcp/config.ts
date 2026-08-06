import { McpProviderRow } from '../db/mcpProviders'
import { McpProviderConfig } from './types'
import { createLogger } from '../logger/logger'

const logger = createLogger('MCP')

/**
 * Narrow the persisted `auth_type` instead of casting it. A cast would let any
 * unexpected value (hand-edited row, a future enum member) fall through to the
 * OAuth/DCR branch in `manager.ts` — the exact silent downgrade that made
 * bearer-token servers pop a browser auth window on startup.
 */
function toAuthType(value: string | null, providerId: string): 'oauth' | 'bearer' {
  if (value === 'bearer' || value === 'oauth') return value
  if (value !== null) {
    logger.warn('unrecognized auth_type, treating as oauth', { providerId, authType: value })
  }
  return 'oauth'
}

/**
 * Single mapping from a persisted provider row to the config the manager
 * connects with. Every `mcpManager.connect()` caller must go through here —
 * a hand-built literal that forgets `authType`/`bearerTokenEncrypted` silently
 * downgrades a bearer-token server to the OAuth/DCR branch in `manager.ts`,
 * which is how bearer providers ended up popping a browser auth window on
 * startup.
 */
export function mcpRowToConfig(row: McpProviderRow): McpProviderConfig {
  return {
    id: row.id,
    name: row.name,
    transportType: row.transportType as 'stdio' | 'sse' | 'streamable-http',
    command: row.command ?? undefined,
    args: (row.args as string[] | null) ?? undefined,
    url: row.url ?? undefined,
    env: (row.env as Record<string, string> | null) ?? undefined,
    enabled: row.enabled,
    authType: toAuthType(row.authType, row.id),
    authTokensEncrypted: row.authTokensEncrypted ?? undefined,
    clientInfo: (row.clientInfo as Record<string, unknown> | null) ?? undefined,
    bearerTokenEncrypted: row.bearerTokenEncrypted ?? undefined
  }
}
