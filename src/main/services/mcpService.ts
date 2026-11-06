import { mcpProviderRepo, McpProviderRow } from '../db/mcpProviders'
import { chatModeRepo } from '../db/chatModes'
import { mcpManager } from '../mcp/manager'
import { McpError } from '../errors'
import { mcpRowToConfig } from '../mcp/config'
import { encryptApiKey } from '../security/keystore'
import {
  directoryEnvNames,
  directoryEnvToSeal,
  directorySecrets,
  directorySlotStates,
  encryptManagedSecrets,
  isDirectorySecretRow,
  managedSecrets,
  managedSlotStates,
  missingManagedEnv
} from '../mcp/managed'
import { addonPolicies } from './addonDirectory/policy'
import { pluginTitleOf } from './pluginTree'
import { basename } from 'node:path'
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
  /** A connect is in flight (its `status` reads `disconnected` meanwhile); absent otherwise. */
  connecting?: boolean
  /** A pinned plugin owns it (`plugin:<entry_uuid>@<sha>`): only its env values, credentials and on/off are editable. */
  managedBy?: string
  /** What the plugin that owns it calls itself (its cached manifest's `displayName`, else `name`, else its folder's name). */
  managedByTitle?: string
  /**
   * The settings the user fills in, and whether each has a value — never the
   * value: a managed provider's, and a local connector's made from a
   * directory entry (`registry_ref`). Its `env` then lists the same names,
   * each `''` (an empty value sent back keeps what is stored), and not a
   * plugin's own literals.
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

async function toDto(row: McpProviderRow): Promise<McpProviderDto> {
  // The keystore first: the connection state below is read after it, as it is now.
  const env = row.managedBy ? managedEnvView(row) : isDirectorySecretRow(row) ? await directoryEnvView(row) : ((row.env as Record<string, string> | null) ?? undefined)
  const envSlots = row.managedBy ? await managedSlotStates(row) : isDirectorySecretRow(row) ? await directorySlotStates(row) : undefined
  const conn = mcpManager.getConnection(row.id)
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    transportType: row.transportType,
    command: row.command ?? undefined,
    args: (row.args as string[] | null) ?? undefined,
    url: row.url ?? undefined,
    env,
    enabled: row.enabled,
    createdAt: row.createdAt,
    hasAuth: !!(row.authTokensEncrypted || row.clientInfo || row.bearerTokenEncrypted),
    authType: row.authType ?? 'oauth',
    status: conn?.status ?? 'disconnected',
    tools: conn?.tools ?? [],
    error: conn?.error,
    ...(mcpManager.connecting(row.id) ? { connecting: true } : {}),
    ...(row.managedBy ? { managedBy: row.managedBy, managedByTitle: managedTitleOf(row), envSlots } : {}),
    ...(isDirectorySecretRow(row) ? { envSlots } : {})
  }
}

/** The owning plugin's title, read from its cached folder; the connector's name when there is none. */
function managedTitleOf(row: McpProviderRow): string {
  const root = row.managedSpec?.root
  return (root ? (pluginTitleOf(root) ?? basename(root)) : null) || row.name
}

/** A directory connector's env as the renderer sees it: its setting names, no values. */
async function directoryEnvView(row: McpProviderRow): Promise<Record<string, string> | undefined> {
  const names = await directoryEnvNames(row)
  return names.length > 0 ? Object.fromEntries(names.map((name) => [name, ''])) : undefined
}

/**
 * Move a directory connector's values still in the plain `env` (stored
 * before they were encrypted) into the encrypted column, leaving the names.
 * The row as it is now; unchanged when nothing was plain.
 */
async function sealDirectoryEnv(userId: string, row: McpProviderRow): Promise<McpProviderRow> {
  try {
    const sealed = await directoryEnvToSeal(row)
    if (!sealed) return row
    // Encrypting awaited: a row edited meanwhile is left for the next read, never overwritten.
    const now = mcpProviderRepo.getOwned(userId, row.id)
    if (!now || now.configRevision !== row.configRevision || JSON.stringify(now.env) !== JSON.stringify(row.env)) return now ?? row
    return writeSealed(userId, now, sealed)
  } catch (err) {
    // Tried again on the next read; the renderer's view is names only either way.
    logger.warn('directory connector settings could not be moved to encrypted storage', { providerId: row.id, error: String(err) })
    return row
  }
}

function writeSealed(userId: string, row: McpProviderRow, sealed: NonNullable<Awaited<ReturnType<typeof directoryEnvToSeal>>>): McpProviderRow {
  const { row: next } = mcpProviderRepo.upsert(userId, {
    id: row.id,
    name: row.name,
    transportType: row.transportType as 'stdio' | 'sse' | 'streamable-http',
    command: row.command,
    args: (row.args as string[] | null) ?? null,
    url: row.url,
    env: sealed.env,
    enabled: row.enabled,
    authType: row.authType === 'bearer' ? 'bearer' : 'oauth',
    envSecretEncrypted: sealed.envSecretEncrypted
  })
  logger.info('directory connector settings moved to encrypted storage', { providerId: row.id })
  return next
}

/**
 * A directory connector's settings after an edit: the names sent (all of
 * them kept when no `env` is sent), a non-empty value replacing the stored
 * one, an empty one keeping it. Values are encrypted; the plain `env` keeps
 * the names, each `''`.
 */
async function directoryEnvEdit(existing: Pick<McpProviderRow, 'env' | 'envSecretEncrypted' | 'managedBy' | 'registryRef' | 'transportType'>, env: Record<string, string> | undefined): Promise<{
  env: Record<string, string> | null
  envSecretEncrypted: Buffer | null
}> {
  const stored = await directorySecrets(existing)
  const names = env ? Object.keys(env) : await directoryEnvNames(existing)
  const values: Record<string, string> = {}
  for (const name of names) {
    const typed = env?.[name]
    const value = typeof typed === 'string' && typed !== '' ? typed : stored[name]
    if (typeof value === 'string' && value !== '') values[name] = value
  }
  return { env: names.length > 0 ? Object.fromEntries(names.map((name) => [name, ''])) : null, envSecretEncrypted: await encryptManagedSecrets(values) }
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
async function editedSecrets(existing: McpProviderRow, env: Record<string, string> | undefined): Promise<Buffer | null | undefined> {
  const values = await managedSecrets(existing)
  let changed = false
  for (const name of existing.managedSpec?.slots ?? []) {
    const typed = env?.[name]
    if (typeof typed === 'string' && typed !== '' && typed !== values[name]) {
      values[name] = typed
      changed = true
    }
  }
  return changed ? await encryptManagedSecrets(values) : undefined
}

/** A refusal the IPC answers as data (a thrown code does not reach the renderer). */
export interface McpRefusal {
  ok: false
  /** `managed`: a plugin owns it; `policy`: the account's admin does not allow the user's own connectors. */
  code: 'managed' | 'policy'
  message: string
}

/** The sentence a new connector of the user's own is refused with while the admin forbids them (`policy.custom_mcp`). */
export const CUSTOM_MCP_REFUSED = 'Your admin does not allow adding your own connectors.'

/** The sentence a new connector from a public MCP registry is refused with while the admin turns them off (`policy.external_directories`). */
export const EXTERNAL_DIRECTORY_REFUSED = 'Your admin does not allow connectors from public MCP registries.'

/** The sentence a new local (stdio) connector is refused with while the admin forbids local servers (`policy.stdio_mcp`). */
export const STDIO_MCP_REFUSED = 'Your admin does not allow adding local MCP servers.'

/** `CORE_MCP_SOURCE` and `REGISTRY_SOURCE_PREFIX` of `addonDirectory/`, spelled here: this service sits below the directory. */
const CORE_MCP_DIRECTORY_SOURCE = 'core-mcp-directory'
const PUBLIC_REGISTRY_PREFIX = 'mcp-registry:'

/**
 * The admin's policy on a connector being created (or turned into a local
 * one): a public registry's (`mcp-registry:*`) needs `externalDirectories`,
 * core's MCP directory's is allowed, anything else is the user's own and
 * needs `customMcp`; a local (stdio) one also needs `stdioMcp`. A local
 * connector that already exists is never refused here — `stdioMcp` gates
 * creating one, not keeping or editing a hand-made one.
 */
function assertCreateAllowed(userId: string, input: UpsertMcpInput, registryRef: { source: string; id: string } | null, existing: McpProviderRow | undefined): void {
  const policy = addonPolicies.get(userId)
  if (input.id === undefined) {
    if (registryRef?.source.startsWith(PUBLIC_REGISTRY_PREFIX)) {
      if (!policy.externalDirectories) throw new McpError('mcp_policy_forbidden', EXTERNAL_DIRECTORY_REFUSED)
    } else if (registryRef?.source !== CORE_MCP_DIRECTORY_SOURCE && !policy.customMcp) {
      throw new McpError('custom_mcp_forbidden', CUSTOM_MCP_REFUSED)
    }
  }
  const becomesStdio = input.transportType === 'stdio' && (input.id === undefined || (existing !== undefined && existing.transportType !== 'stdio'))
  if (becomesStdio && !policy.stdioMcp) throw new McpError('mcp_policy_forbidden', STDIO_MCP_REFUSED)
}

/** The upsert's refusal of a managed provider's edit or of a connector the policy forbids, as data; anything else is rethrown. */
export function managedRefusalOf(err: unknown): McpRefusal | null {
  if (!(err instanceof McpError)) return null
  if (err.code === 'managed_provider') return { ok: false, code: 'managed', message: err.message }
  if (err.code === 'custom_mcp_forbidden' || err.code === 'mcp_policy_forbidden') return { ok: false, code: 'policy', message: err.message }
  return null
}

/**
 * An edit of a plugin's provider: only `enabled`, a bearer token and the
 * values of its names change; command, args, URL, the plugin's env and the
 * auth kind stay the plugin's. Connected once it has every value it needs.
 */
async function upsertManaged(userId: string, existing: McpProviderRow, input: UpsertMcpInput): Promise<{ id: string; row: McpProviderDto }> {
  assertManagedEdit(existing, input)
  const secrets = await editedSecrets(existing, input.env)
  const bearerTokenEncrypted = input.bearerToken ? await encryptApiKey(input.bearerToken) : undefined
  // The values were merged with the stored ones before the keystore awaits: refuse if the row moved meanwhile.
  assertUnchanged(existing, mcpProviderRepo.getOwned(userId, existing.id))
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
    bearerTokenEncrypted,
    ...(secrets !== undefined ? { envSecretEncrypted: secrets } : {})
  })
  logger.info('managed mcp updated', { providerId: id, enabled: row.enabled, valuesChanged: secrets !== undefined })
  if (row.enabled && (await missingManagedEnv(row)).length === 0) await mcpManager.connect(await mcpRowToConfig(row))
  else await mcpManager.disconnect(row.id)
  return { id, row: await toDto(row) }
}

/** The sentence an edit is refused with when its connector changed while the edit's values were encrypted. */
const CHANGED_WHILE_SAVING = 'The connector changed while it was being saved. Try again.'

function assertUnchanged(before: McpProviderRow, now: McpProviderRow | undefined): void {
  if (!now || now.configRevision !== before.configRevision || (now.managedBy ?? null) !== (before.managedBy ?? null)) throw new Error(CHANGED_WHILE_SAVING)
}

export const mcpService = {
  async list(userId: string): Promise<McpProviderDto[]> {
    return Promise.all(mcpProviderRepo.list(userId).map(async (row) => toDto(await sealDirectoryEnv(userId, row))))
  },

  async upsert(
    userId: string,
    input: UpsertMcpInput
  ): Promise<{ id: string; row: McpProviderDto }> {
    assertTransport(input.transportType)
    if (input.authType !== undefined) assertAuthType(input.authType)
    const existing = input.id !== undefined ? mcpProviderRepo.getOwned(userId, input.id) : undefined
    if (existing?.managedBy) return upsertManaged(userId, existing, input)
    const registryRef = input.id === undefined && input.registryRef ? input.registryRef : null
    assertCreateAllowed(userId, input, registryRef, existing)
    // A local connector made from a directory entry keeps its values encrypted, as a plugin's.
    const secretEnv =
      input.transportType === 'stdio' && (existing ? isDirectorySecretRow(existing) : !!registryRef)
        ? await directoryEnvEdit(existing ?? { env: null, envSecretEncrypted: null, managedBy: null, registryRef, transportType: 'stdio' }, input.env)
        : null
    const bearerTokenEncrypted = input.bearerToken ? await encryptApiKey(input.bearerToken) : undefined
    // Re-checked after the keystore awaits: the row, and the policy, as they are now.
    if (existing) assertUnchanged(existing, mcpProviderRepo.getOwned(userId, existing.id))
    assertCreateAllowed(userId, input, registryRef, existing)

    const { id, created, row } = mcpProviderRepo.upsert(userId, {
      id: input.id,
      name: input.name,
      transportType: input.transportType,
      command: input.command ?? null,
      args: input.args ?? null,
      url: input.url ?? null,
      env: secretEnv ? secretEnv.env : (input.env ?? null),
      ...(secretEnv ? { envSecretEncrypted: secretEnv.envSecretEncrypted } : existing && isDirectorySecretRow(existing) ? { envSecretEncrypted: null } : {}),
      enabled: input.enabled,
      authType: input.authType,
      bearerTokenEncrypted,
      ...(registryRef ? { registryRef } : {})
    })

    logger.info(created ? 'mcp created' : 'mcp updated', {
      providerId: id,
      transport: row.transportType,
      authType: row.authType,
      enabled: row.enabled
    })

    if (row.enabled) {
      await mcpManager.connect(await mcpRowToConfig(row))
    } else {
      await mcpManager.disconnect(row.id)
    }

    return { id, row: await toDto(row) }
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
    input: (
      | { transportType: 'sse' | 'streamable-http'; url: string; authType: 'oauth' | 'bearer' }
      /** A local server of core's MCP directory: its command, and the setting names it needs (stored empty). */
      | { transportType: 'stdio'; command: string; args: string[]; env: Record<string, string> }
    ) & {
      name: string
      registryRef: { source: string; id: string }
      /** Skip the first connect (a bearer server with no token yet, a local one with settings to fill in). */
      connect: boolean
    }
  ): Promise<{ id: string; status: string; needsUser: boolean; error?: string }> {
    const { id, row } = mcpProviderRepo.upsert(userId, {
      name: input.name,
      ...(input.transportType === 'stdio'
        ? { transportType: 'stdio' as const, command: input.command, args: input.args, env: Object.keys(input.env).length > 0 ? input.env : null, authType: 'oauth' as const }
        : { transportType: input.transportType, url: input.url, authType: input.authType }),
      enabled: true,
      registryRef: input.registryRef
    })
    logger.info('mcp created from directory', { providerId: id, source: input.registryRef.source, authType: row.authType })
    if (!input.connect) return { id, status: 'disconnected', needsUser: false }
    try {
      const conn = await mcpManager.connect(await mcpRowToConfig(row), { interactive: false })
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

    const conn = await mcpManager.connect(await mcpRowToConfig(row))
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
