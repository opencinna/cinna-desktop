/**
 * The `this-computer` directory provider: the settings scope's own MCP
 * providers (`mcp_providers`), as kind `mcp` with origin "On this computer".
 * A provider made from a directory entry carries that entry's ref
 * (`registry_ref`), so the directory shows it once, with the entry's metadata.
 */

import { mcpProviderRepo, type McpProviderRow } from '../../db/mcpProviders'
import { mcpManager } from '../../mcp/manager'
import { missingManagedEnv } from '../../mcp/managed'
import type { AddonNextStep, AddonRef } from '../../../shared/addons/directory'
import { LOCAL_SOURCE, type McpSetup } from './directory'
import type { DirectoryProvider, ProviderEntry } from './types'

export const LOCAL_SOURCE_TEXT = {
  label: 'On this computer',
  oauth: 'Needs you to sign in',
  bearer: 'Needs an access token',
  env: 'Needs settings filled in',
  connect: 'Could not connect',
  enable: 'Turned off'
} as const

export interface LocalMcpFacts {
  rows(userId: string): McpProviderRow[]
  status(id: string): string
  needsUser(id: string): boolean
  /** Why its last connect failed, when it did. */
  error(id: string): string | undefined
}

const defaultFacts: LocalMcpFacts = {
  rows: (userId) => mcpProviderRepo.list(userId),
  status: (id) => mcpManager.getConnection(id)?.status ?? 'disconnected',
  needsUser: (id) => mcpManager.needsUser(id),
  error: (id) => mcpManager.getConnection(id)?.error
}

/**
 * What a provider still needs before it connects unattended: a bearer server
 * with no token, or an OAuth server that has said it needs the user and holds
 * no tokens. An OAuth row with no tokens that never asked may be a server with
 * no auth at all, so it needs nothing. A provider whose connect failed for any
 * other reason needs a Connect (`connect`) — never "ready". One turned off on
 * this computer needs turning on first (`enable`): it never connects.
 */
export function setupOf(row: McpProviderRow, status: string, needsUser: boolean): AddonNextStep | null {
  if (row.enabled === false) return 'enable'
  if (status === 'connected') return null
  // A plugin's server with a setting it needs still empty.
  if (missingManagedEnv(row).length > 0) return 'env'
  if (row.transportType !== 'stdio') {
    if (row.authType === 'bearer' && !row.bearerTokenEncrypted) return 'bearer'
    if (row.authType !== 'bearer' && !row.authTokensEncrypted && (needsUser || status === 'awaiting-auth')) return 'oauth'
  }
  return status === 'error' ? 'connect' : null
}

/** A tile's one line: the command it runs, or the server's host (the full URL is the card's, not the tile's). */
function summaryOf(row: McpProviderRow): string {
  if (row.transportType === 'stdio') return [row.command, ...(row.args ?? [])].filter(Boolean).join(' ')
  if (!row.url) return ''
  try {
    return new URL(row.url).host
  } catch {
    return row.url
  }
}

function registryRefOf(row: McpProviderRow): AddonRef | null {
  const ref = row.registryRef
  return ref && typeof ref.source === 'string' && typeof ref.id === 'string' ? { source: ref.source, id: ref.id } : null
}

export function localProviderEntry(row: McpProviderRow, setup: AddonNextStep | null): ProviderEntry {
  return {
    ref: { source: LOCAL_SOURCE, id: row.id },
    kind: 'mcp',
    name: row.name,
    title: row.name,
    summary: summaryOf(row),
    description: '',
    category: null,
    tags: [],
    iconUrl: null,
    publisher: null,
    origin: { label: LOCAL_SOURCE_TEXT.label, kind: 'local', repositoryUrl: null, homepage: null },
    version: null,
    digest: null,
    requires: { credentials: [] },
    runsCode: row.transportType === 'stdio',
    status: 'ready',
    unsupportedReason: null,
    install: null,
    mcpProviderId: row.id,
    registryRef: registryRefOf(row),
    ...(setup ? { setupReason: LOCAL_SOURCE_TEXT[setup], setupStep: setup } : {})
  }
}

export function createThisComputerProvider(facts: LocalMcpFacts = defaultFacts): DirectoryProvider & {
  setup(userId: string, id: string): McpSetup | null
} {
  const setupFor = (row: McpProviderRow): AddonNextStep | null => setupOf(row, facts.status(row.id), facts.needsUser(row.id))
  return {
    id: LOCAL_SOURCE,
    label: LOCAL_SOURCE_TEXT.label,
    owns: (ref) => ref.source === LOCAL_SOURCE,
    async list(ctx) {
      // A plugin's own servers show inside the plugin's row, never as connectors of their own.
      return {
        entries: facts
          .rows(ctx.settingsUserId)
          .filter((row) => !row.managedBy)
          .map((row) => localProviderEntry(row, setupFor(row)))
      }
    },
    setup(userId, id) {
      const row = facts.rows(userId).find((r) => r.id === id)
      const next = row ? setupFor(row) : null
      if (!next) return null
      const message = next === 'connect' ? facts.error(id) : undefined
      return { next, ...(message ? { message } : {}) }
    }
  }
}
