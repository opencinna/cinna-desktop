/**
 * The `mcp-registries` directory provider, over `mcpRegistryService`: the
 * Cinna-curated opencinna index as `list()` (small, read whole and cached
 * there), the official registry (thousands of servers) as `search()` only.
 * Gated by `policy.externalDirectories`. The opencinna index is not listed
 * when core's unified index answered: core's MCP directory is seeded from it,
 * so each of its servers would show twice. A ref of it still resolves
 * (`find`), and the official registry's search is unchanged.
 */

import { mcpRegistryService } from '../mcpRegistryService'
import type { McpRegistryEntry, McpRegistryInfo } from '../../../shared/mcpRegistries'
import { mcpRegistryRef, type AddonRef } from '../../../shared/addons/directory'
import { summaryOf } from './cinnaCore'
import type { DirectoryProvider, ProviderEntry } from './types'

export const REGISTRY_SOURCE_PREFIX = 'mcp-registry:'
/** Listed whole. */
export const LISTED_REGISTRY = 'cinna-official'
/** Searched only. */
export const SEARCHED_REGISTRY = 'official'
/** The opencinna index is a few dozen servers; the service caps a read at 100. */
const LIST_LIMIT = 100
const SEARCH_LIMIT = 50

export const REGISTRY_SOURCE_TEXT = {
  label: 'MCP registries',
  needsAuth: 'Needs a sign-in or an access token after adding'
} as const

export interface RegistryReads {
  registries(): McpRegistryInfo[]
  search(registryId: string, query: string, limit: number): Promise<McpRegistryEntry[]>
}

const defaultReads: RegistryReads = {
  registries: () => mcpRegistryService.list(),
  search: async (registryId, query, limit) => (await mcpRegistryService.search(registryId, query, limit)).entries
}

export function registryRef(registryId: string, id: string): AddonRef {
  return mcpRegistryRef(registryId, id)
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** The first remote this app can connect to; null when there is none (the service already drops non-HTTP ones). */
export function registryEntry(entry: McpRegistryEntry, info: McpRegistryInfo | undefined): ProviderEntry | null {
  const remote = entry.remotes[0]
  if (!remote) return null
  return {
    ref: registryRef(entry.registryId, entry.id),
    kind: 'mcp',
    name: entry.name,
    title: entry.title?.trim() || entry.name,
    // The description's first sentence; with none, the server's host — never the bare URL.
    summary: summaryOf(entry.description) || hostOf(remote.url),
    description: entry.description ?? '',
    category: null,
    tags: [],
    iconUrl: null,
    publisher: null,
    origin: {
      label: info?.label ?? entry.registryId,
      kind: 'directory',
      repositoryUrl: entry.websiteUrl ?? null,
      homepage: info?.homepage ?? null
    },
    version: entry.version ?? null,
    digest: null,
    requires: { credentials: [] },
    runsCode: false,
    status: 'ready',
    unsupportedReason: null,
    install: { mcp: { transport: remote.type, url: remote.url, auth: 'oauth', requiresAuth: remote.requiresAuth } },
    ...(remote.requiresAuth ? { setupReason: REGISTRY_SOURCE_TEXT.needsAuth } : {})
  }
}

export function createMcpRegistriesProvider(reads: RegistryReads = defaultReads): DirectoryProvider {
  const infoOf = (id: string): McpRegistryInfo | undefined => reads.registries().find((r) => r.id === id)
  const entriesOf = (rows: McpRegistryEntry[]): ProviderEntry[] => rows.flatMap((row) => registryEntry(row, infoOf(row.registryId)) ?? [])
  return {
    id: 'mcp-registries',
    label: REGISTRY_SOURCE_TEXT.label,
    gate: 'externalDirectories',
    owns: (ref) => ref.source.startsWith(REGISTRY_SOURCE_PREFIX),
    async list(ctx) {
      // Core's MCP directory is seeded from this index and already answered: one listing, not two.
      if (ctx.coreMcpDirectory) return { entries: [] }
      return { entries: entriesOf(await reads.search(LISTED_REGISTRY, '', LIST_LIMIT)) }
    },
    async search(_ctx, query) {
      if (!query.trim()) return { entries: [] }
      return { entries: entriesOf(await reads.search(SEARCHED_REGISTRY, query, SEARCH_LIMIT)) }
    },
    async find(_ctx, ref) {
      const registryId = ref.source.slice(REGISTRY_SOURCE_PREFIX.length)
      if (!infoOf(registryId)) return null
      const rows = registryId === LISTED_REGISTRY ? await reads.search(registryId, '', LIST_LIMIT) : await reads.search(registryId, ref.id, SEARCH_LIMIT)
      const row = rows.find((r) => r.id === ref.id)
      return row ? registryEntry(row, infoOf(row.registryId)) : null
    }
  }
}
