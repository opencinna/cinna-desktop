import { net } from 'electron'
import type {
  McpRegistryEntry,
  McpRegistryInfo,
  McpRegistrySearchAllResult,
  McpRegistrySearchResult
} from '../../shared/mcpRegistries'
import { McpError, ipcErrorShape } from '../errors'
import { createLogger } from '../logger/logger'

const logger = createLogger('MCP-Registry')

const FETCH_TIMEOUT_MS = 10_000
const MIN_LIMIT = 1
const MAX_LIMIT = 100
const DEFAULT_LIMIT = 50
const CACHE_TTL_MS = 5 * 60 * 1000

interface RegistryAdapter extends McpRegistryInfo {
  search(query: string, limit: number): Promise<McpRegistryEntry[]>
}

interface OfficialServerEntry {
  server?: {
    name?: string
    title?: string
    description?: string
    version?: string
    websiteUrl?: string
    repository?: { url?: string }
    remotes?: Array<{
      type?: string
      url?: string
      headers?: Array<{ isRequired?: boolean }>
    }>
  }
}

interface CinnaOfficialJson {
  version?: number
  servers?: Array<{
    id?: string
    name?: string
    title?: string
    description?: string
    version?: string
    websiteUrl?: string
    remotes?: Array<{
      type?: string
      url?: string
      requiresAuth?: boolean
    }>
  }>
}

function isHttpUrl(raw: string | undefined): raw is string {
  if (!raw) return false
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

// Shared fetch+parse used by every adapter so transport failures, non-2xx
// responses, and malformed JSON all surface as the same typed `McpError` with
// a registry-specific label in the message.
async function fetchRegistryJson<T>(url: string, label: string): Promise<T> {
  let resp: Response
  try {
    resp = await net.fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
  } catch (err) {
    throw new McpError(
      'registry_unreachable',
      `Could not reach ${label}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (!resp.ok) {
    throw new McpError(
      'registry_unreachable',
      `${label} returned ${resp.status} ${resp.statusText}`
    )
  }
  try {
    return (await resp.json()) as T
  } catch (err) {
    throw new McpError(
      'registry_unreachable',
      `Invalid JSON from ${label}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

const CINNA_OFFICIAL_URL = 'https://opencinna.io/.well-known/mcp_registry/index.json'

let cinnaOfficialCache: { expiresAt: number; entries: McpRegistryEntry[] } | null = null

async function loadCinnaOfficialEntries(): Promise<McpRegistryEntry[]> {
  const now = Date.now()
  if (cinnaOfficialCache && cinnaOfficialCache.expiresAt > now) {
    return cinnaOfficialCache.entries
  }

  const data = await fetchRegistryJson<CinnaOfficialJson>(
    CINNA_OFFICIAL_URL,
    'the Cinna registry'
  )

  const entries: McpRegistryEntry[] = []
  for (const s of data.servers ?? []) {
    if (!s?.id || !s?.name) continue

    const remotes: McpRegistryEntry['remotes'] = []
    for (const r of s.remotes ?? []) {
      if (!isHttpUrl(r?.url)) continue
      if (r.type !== 'streamable-http' && r.type !== 'sse') continue
      remotes.push({ type: r.type, url: r.url, requiresAuth: r.requiresAuth === true })
    }
    if (remotes.length === 0) continue

    entries.push({
      registryId: 'cinna-official',
      id: s.id,
      name: s.name,
      title: s.title,
      description: s.description,
      version: s.version,
      websiteUrl: isHttpUrl(s.websiteUrl) ? s.websiteUrl : undefined,
      remotes
    })
  }

  cinnaOfficialCache = { expiresAt: now + CACHE_TTL_MS, entries }
  return entries
}

const cinnaOfficialAdapter: RegistryAdapter = {
  id: 'cinna-official',
  label: 'Cinna Official',
  name: 'Cinna Official Registry',
  homepage: 'https://opencinna.io/',
  async search(query, limit) {
    const all = await loadCinnaOfficialEntries()
    const q = query.trim().toLowerCase()
    const filtered = q
      ? all.filter(
          (e) =>
            e.name.toLowerCase().includes(q) ||
            (e.title?.toLowerCase().includes(q) ?? false) ||
            (e.description?.toLowerCase().includes(q) ?? false)
        )
      : all
    return filtered.slice(0, limit)
  }
}

const officialAdapter: RegistryAdapter = {
  id: 'official',
  label: 'MCP Official',
  name: 'Official MCP Registry',
  homepage: 'https://registry.modelcontextprotocol.io/',
  async search(query, limit) {
    const url = new URL('https://registry.modelcontextprotocol.io/v0/servers')
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('version', 'latest')
    if (query.trim()) url.searchParams.set('search', query.trim())

    const data = await fetchRegistryJson<{ servers?: OfficialServerEntry[] }>(
      url.toString(),
      'the MCP Official registry'
    )
    const servers = data.servers ?? []

    const entries: McpRegistryEntry[] = []
    for (const item of servers) {
      const s = item.server
      if (!s?.name) continue

      const remotes: McpRegistryEntry['remotes'] = []
      for (const r of s.remotes ?? []) {
        if (!isHttpUrl(r?.url)) continue
        if (r.type !== 'streamable-http' && r.type !== 'sse') continue
        const requiresAuth = (r.headers ?? []).some((h) => h?.isRequired === true)
        remotes.push({ type: r.type, url: r.url, requiresAuth })
      }
      // Only surface servers with at least one HTTP(S) remote — local stdio
      // entries can't be installed from a URL anyway.
      if (remotes.length === 0) continue

      const repoUrl = s.repository?.url
      const websiteUrl = isHttpUrl(s.websiteUrl)
        ? s.websiteUrl
        : isHttpUrl(repoUrl)
          ? repoUrl
          : undefined

      entries.push({
        registryId: 'official',
        id: s.name,
        name: s.name,
        title: s.title,
        description: s.description,
        version: s.version,
        websiteUrl,
        remotes
      })
    }
    return entries
  }
}

// Insertion order determines the merged-result order in `searchAll`; Cinna-
// curated entries appear first.
const adapters: Record<string, RegistryAdapter> = {
  [cinnaOfficialAdapter.id]: cinnaOfficialAdapter,
  [officialAdapter.id]: officialAdapter
}

interface CacheEntry {
  expiresAt: number
  result: McpRegistrySearchResult
}

const cache = new Map<string, CacheEntry>()

function cacheKey(registryId: string, query: string, limit: number): string {
  return `${registryId}::${limit}::${query.trim().toLowerCase()}`
}

function clampLimit(limit: number | undefined): number {
  const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_LIMIT
  return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, n))
}

/**
 * Registry discovery service. Registry adapters are hardcoded — users can't
 * configure new ones from the UI because each registry has its own API shape.
 * Search results are cached in-memory for 5 minutes per (registry, query,
 * limit). The cache is process-local and cleared on app restart.
 */
export const mcpRegistryService = {
  list(): McpRegistryInfo[] {
    return Object.values(adapters).map(({ id, label, name, homepage }) => ({
      id,
      label,
      name,
      homepage
    }))
  },

  async searchAll(query: string, limit?: number): Promise<McpRegistrySearchAllResult> {
    const clamped = clampLimit(limit)
    // Run all registries in parallel; isolated failures must not block the
    // merged result, so we use allSettled and surface per-registry errors.
    const order = Object.values(adapters)
    const started = Date.now()
    const results = await Promise.allSettled(
      order.map((adapter) => this.search(adapter.id, query, clamped))
    )

    const entries: McpRegistryEntry[] = []
    const errors: McpRegistrySearchAllResult['errors'] = []
    results.forEach((res, idx) => {
      const adapter = order[idx]
      if (res.status === 'fulfilled') {
        entries.push(...res.value.entries)
      } else {
        const e = ipcErrorShape(res.reason)
        errors.push({ registryId: adapter.id, code: e.code, error: e.message })
        logger.warn('searchAll:registry-failed', {
          registryId: adapter.id,
          code: e.code,
          error: e.message
        })
      }
    })
    logger.info('searchAll:done', {
      query,
      limit: clamped,
      totalEntries: entries.length,
      failedRegistries: errors.length,
      duration: Date.now() - started
    })
    return { entries, errors }
  },

  async search(
    registryId: string,
    query: string,
    limit?: number
  ): Promise<McpRegistrySearchResult> {
    const adapter = adapters[registryId]
    if (!adapter) {
      throw new McpError('registry_unknown', `Unknown registry: ${registryId}`)
    }

    const clamped = clampLimit(limit)
    const key = cacheKey(registryId, query, clamped)
    const now = Date.now()
    const hit = cache.get(key)
    if (hit && hit.expiresAt > now) {
      logger.debug('search:cache-hit', {
        registryId,
        query,
        limit: clamped,
        count: hit.result.entries.length
      })
      return hit.result
    }

    logger.debug('search:start', { registryId, query, limit: clamped })
    const started = now
    const entries = await adapter.search(query, clamped)
    const result: McpRegistrySearchResult = { entries }
    cache.set(key, { result, expiresAt: now + CACHE_TTL_MS })
    logger.debug('search:done', {
      registryId,
      query,
      limit: clamped,
      count: entries.length,
      duration: Date.now() - started
    })
    return result
  }
}
