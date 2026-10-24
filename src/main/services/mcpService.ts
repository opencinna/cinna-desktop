import { mcpProviderRepo, McpProviderRow } from '../db/mcpProviders'
import { chatModeRepo } from '../db/chatModes'
import { mcpManager } from '../mcp/manager'
import { McpError } from '../errors'
import { mcpRowToConfig } from '../mcp/config'
import { encryptApiKey } from '../security/keystore'
import { encryptManagedSecrets, managedSecrets, managedSlotStates, missingManagedEnv } from '../mcp/managed'
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
  /** A pinned plugin owns it (`plugin:<entry_uuid>@<sha>`): only its env values, credentials and on/off are editable. */
  managedBy?: string
  /**
   * A managed provider's settings the user fills in, and whether each has a
   * value — never the value. Its `env` then lists the same names, each `''`
   * (an empty value sent back keeps what is stored), and not the plugin's own.
   */
  envSlots?: Array<{ name: string; hasValue: boolean }>
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
  /** The addon directory entry it is made from (`registry_ref`); written on insert only, so the directory shows it once. */
  registryRef?: { source: string; id: string } | null
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
    env: row.managedBy ? managedEnvView(row) : ((row.env as Record<string, string> | null) ?? undefined),
    enabled: row.enabled,
    createdAt: row.createdAt,
    hasAuth: !!(row.authTokensEncrypted || row.clientInfo || row.bearerTokenEncrypted),
    authType: row.authType ?? 'oauth',
    status: conn?.status ?? 'disconnected',
    tools: conn?.tools ?? [],
    error: conn?.error,
    ...(row.managedBy ? { managedBy: row.managedBy, envSlots: managedSlotStates(row) } : {})
  }
}

/** A managed provider's env as the renderer sees it: the names the user fills in, no values. */
function managedEnvView(row: McpProviderRow): Record<string, string> | undefined {
  const names = row.managedSpec?.slots ?? []
  return names.length > 0 ? Object.fromEntries(names.map((name) => [name, ''])) : undefined
}

/** The sentence an edit of a managed provider's own fields is refused with. */
export const MANAGED_PROVIDER_EDIT_REFUSED =
  'This connector comes with a plugin. Only its settings values, its sign-in and whether it is on can be changed here.'

/** The sentence a delete of a managed provider is refused with. */
export const MANAGED_PROVIDER_DELETE_REFUSED =
  'This connector comes with a plugin. Remove the plugin from its agents, and the connector goes with it.'

const sameArgs = (a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean => {
  const left = a ?? []
  const right = b ?? []
  return left.length === right.length && left.every((arg, at) => arg === right[at])
}

/**
 * Refuse an upsert that would change what a plugin owns on its provider:
 * the name, the transport, the command and its args (compared element by
 * element, as parsed), the URL and the auth kind. The values of the names the
 * user fills in, a bearer token and `enabled` are the user's; the plugin's
 * own env literals are never taken from the input.
 */
function assertManagedEdit(existing: McpProviderRow, input: UpsertMcpInput): void {
  const unchanged =
    existing.name === input.name &&
    existing.transportType === input.transportType &&
    (existing.command ?? null) === (input.command ?? null) &&
    sameArgs(existing.args as string[] | null, input.args) &&
    (existing.url ?? null) === (input.url ?? null) &&
    (input.authType === undefined || input.authType === existing.authType)
  if (!unchanged) throw new McpError('managed_provider', MANAGED_PROVIDER_EDIT_REFUSED)
}

/**
 * The user's values after an edit of a managed provider: a non-empty value
 * for one of its names replaces the stored one; an empty or absent one keeps
 * it (the renderer never had it). Other names are not the user's and are
 * ignored. Null when nothing changed.
 */
function editedSecrets(existing: McpProviderRow, env: Record<string, string> | undefined): Buffer | null | undefined {
  const values = managedSecrets(existing)
  let changed = false
  for (const name of existing.managedSpec?.slots ?? []) {
    const typed = env?.[name]
    if (typeof typed === 'string' && typed !== '' && typed !== values[name]) {
      values[name] = typed
      changed = true
    }
  }
  return changed ? encryptManagedSecrets(values) : undefined
}

/** A refusal the IPC answers as data (a thrown code does not reach the renderer). */
export interface McpRefusal {
  ok: false
  code: 'managed'
  message: string
}

/** The upsert's refusal of a managed provider's edit, as data; anything else is rethrown. */
export function managedRefusalOf(err: unknown): McpRefusal | null {
  return err instanceof McpError && err.code === 'managed_provider' ? { ok: false, code: 'managed', message: err.message } : null
}

/**
 * An edit of a plugin's provider: only `enabled`, a bearer token and the
 * values of its names change; command, args, URL, the plugin's env and the
 * auth kind stay the plugin's. Connected once it has every value it needs.
 */
async function upsertManaged(userId: string, existing: McpProviderRow, input: UpsertMcpInput): Promise<{ id: string; row: McpProviderDto }> {
  assertManagedEdit(existing, input)
  const secrets = editedSecrets(existing, input.env)
  const { id, row } = mcpProviderRepo.upsert(userId, {
    id: existing.id,
    name: existing.name,
    transportType: existing.transportType as 'stdio' | 'sse' | 'streamable-http',
    command: existing.command,
    args: (existing.args as string[] | null) ?? null,
    url: existing.url,
    env: (existing.env as Record<string, string> | null) ?? null,
    enabled: input.enabled,
    authType: existing.authType === 'bearer' ? 'bearer' : 'oauth',
    bearerTokenEncrypted: input.bearerToken ? encryptApiKey(input.bearerToken) : undefined,
    ...(secrets !== undefined ? { envSecretEncrypted: secrets } : {})
  })
  logger.info('managed mcp updated', { providerId: id, enabled: row.enabled, valuesChanged: secrets !== undefined })
  if (row.enabled && missingManagedEnv(row).length === 0) await mcpManager.connect(mcpRowToConfig(row))
  else await mcpManager.disconnect(row.id)
  return { id, row: toDto(row) }
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
    if (input.id !== undefined) {
      const existing = mcpProviderRepo.getOwned(userId, input.id)
      if (existing?.managedBy) return upsertManaged(userId, existing, input)
    }

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
      bearerTokenEncrypted: input.bearerToken ? encryptApiKey(input.bearerToken) : undefined,
      ...(input.id === undefined && input.registryRef ? { registryRef: input.registryRef } : {})
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

  /**
   * A provider made from an addon directory entry, carrying the entry's ref
   * (`registry_ref`) so the directory shows it once. Unlike {@link upsert},
   * the first connect is non-interactive: it never opens a browser, and an
   * OAuth server that needs the user answers `needsUser` so the picker can
   * offer its own Connect step in place.
   */
  async createFromDirectory(
    userId: string,
    input: {
      name: string
      transportType: 'sse' | 'streamable-http'
      url: string
      authType: 'oauth' | 'bearer'
      registryRef: { source: string; id: string }
      /** Skip the first connect (a bearer server with no token yet). */
      connect: boolean
    }
  ): Promise<{ id: string; status: string; needsUser: boolean; error?: string }> {
    const { id, row } = mcpProviderRepo.upsert(userId, {
      name: input.name,
      transportType: input.transportType,
      url: input.url,
      enabled: true,
      authType: input.authType,
      registryRef: input.registryRef
    })
    logger.info('mcp created from directory', { providerId: id, source: input.registryRef.source, authType: row.authType })
    if (!input.connect) return { id, status: 'disconnected', needsUser: false }
    try {
      const conn = await mcpManager.connect(mcpRowToConfig(row), { interactive: false })
      return { id, status: conn.status, needsUser: mcpManager.needsUser(id), ...(conn.error ? { error: conn.error } : {}) }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      logger.warn('first connect from directory failed', { providerId: id, error })
      return { id, status: 'error', needsUser: mcpManager.needsUser(id), error }
    }
  },

  /** Delete a connector. A plugin's (managed) one is refused, as data: it goes with its plugin. */
  async delete(userId: string, id: string): Promise<{ ok: true } | McpRefusal> {
    const row = mcpProviderRepo.getOwned(userId, id)
    if (!row) throw new McpError('not_found', 'MCP provider not found')
    if (row.managedBy) return { ok: false, code: 'managed', message: MANAGED_PROVIDER_DELETE_REFUSED }
    await mcpManager.disconnect(id)
    mcpProviderRepo.delete(userId, id)
    // `chat_mcp_providers` is cleaned up by the FK cascade in the schema, but
    // `chat_modes.mcpProviderIds` is a JSON array without FK enforcement —
    // strip the dead id here so a chat created from an affected mode doesn't
    // crash on `chat:set-mcp-providers` with SQLITE_CONSTRAINT_FOREIGNKEY.
    const touchedModes = chatModeRepo.stripMcpProviderId(userId, id)
    logger.info('mcp deleted', { providerId: id, touchedModes })
    return { ok: true }
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
