/**
 * The `cinna-core` directory provider: what the active profile's Cinna server
 * offers. Signed out or local-only: no entries and no error.
 *
 * **Core's directory (U4).** One read of `GET /api/v1/addons/directory?runs_on=desktop`
 * — the full compact index (catalog skills, marketplace skills and plugins,
 * core's MCP directory) and the account's `policy` — mapped by
 * {@link fromCoreEntry} / {@link fromCorePolicy}. The answer is reused for
 * {@link CORE_DIRECTORY_TTL_MS}; after that, or on the picker's refresh, it is
 * asked again with `If-None-Match`, and a 304 keeps the cached index. The
 * policy goes back to the directory, which stores it for the account.
 *
 * **Older core.** A 404 from that endpoint falls back to the three reads that
 * came before it — the catalog listing's skill packages (`libraryService`),
 * the skills marketplaces (`marketplaceSkillService.discover`) and the
 * plugin marketplaces (`marketplacePluginService.discover`) — and no
 * policy (the account's stored one stands), until the next refresh tries the
 * endpoint again. Both
 * paths produce the same refs, so pins and add / remove do not care which.
 */

import { getProfileScopeUserId } from '../../auth/scope'
import { CinnaReauthRequired } from '../../auth/cinna-oauth'
import { CinnaApiError } from '../../errors'
import { createLogger } from '../../logger/logger'
import { libraryService } from '../libraryService'
import { marketplaceSkillService, snapshotDownloadPath } from '../marketplaceSkillService'
import { skillDownloadPath } from '../catalogSkillService'
import { componentsOf, marketplacePluginService, pluginArchivePath, PLUGIN_TYPES, type MarketplacePluginEntry } from '../marketplacePluginService'
import { cinnaSend } from '../cinna-http'
import { isCatalogPinName } from '../../kit/skills'
import type { CatalogItem } from '../../../shared/catalogItems'
import type { MarketplaceSkillEntry } from '../../../shared/marketplaceSkills'
import {
  DEFAULT_ADDON_POLICY,
  type AddonInstall,
  type AddonKind,
  type AddonMcpConnect,
  type AddonMcpEnvName,
  type AddonPolicy,
  type DirectoryEntry
} from '../../../shared/addons/directory'
import { CATALOG_SOURCE, CORE_MCP_SOURCE, MARKETPLACE_SOURCE, PLUGIN_SOURCE } from './directory'
import type { DirectoryProvider, ProviderEntry, ProviderListing } from './types'

const logger = createLogger('AddonDirectory')

/** The index (or, on an older core, the marketplace list) is read whole; this long it is reused before asking again. */
export const CORE_DIRECTORY_TTL_MS = 60_000

/** Core's unified directory, the whole index for this computer. */
export const CORE_DIRECTORY_PATH = '/api/v1/addons/directory?runs_on=desktop'

export const CORE_SOURCE_TEXT = {
  label: 'Cinna',
  catalogLabel: 'Catalog',
  reauth: 'Your Cinna session expired. Sign in again to see the catalog and marketplace addons.',
  catalogFailed: 'Could not load the catalog.',
  marketplaceFailed: 'Could not load the marketplace skills.',
  pluginsFailed: 'Could not load the marketplace plugins.',
  directoryFailed: 'Could not load the addons from Cinna.',
  needsAuth: 'Needs a sign-in or an access token after adding',
  needsEnv: 'Needs settings filled in after adding'
} as const

/** The first sentence (or line) of a description, for the card. */
export function summaryOf(text: string | null | undefined): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  const end = flat.search(/[.!?](\s|$)/)
  const sentence = end >= 0 ? flat.slice(0, end + 1) : flat
  return sentence.length > 200 ? `${sentence.slice(0, 199)}…` : sentence
}

const digestOf = (hex: string | null | undefined): string | null =>
  typeof hex === 'string' && /^[0-9a-f]{64}$/i.test(hex) ? `sha256:${hex.toLowerCase()}` : null

/** A catalog listing's skill package as a directory entry; null for any other kind. */
export function catalogSkillEntry(item: CatalogItem): ProviderEntry | null {
  if (item.kind !== 'skill' || !item.uuid) return null
  const sha = item.skill?.archive_sha256 ?? null
  const latest = item.latest
  const ready = !!latest && Number.isInteger(latest.revision_number) && latest.revision_number >= 1 && digestOf(sha) !== null
  return {
    ref: { source: CATALOG_SOURCE, id: item.uuid },
    kind: 'skill',
    name: item.name,
    title: item.display_name || item.name,
    summary: summaryOf(item.description),
    description: item.description ?? '',
    category: null,
    tags: [],
    iconUrl: null,
    publisher: item.publisher ? { name: item.publisher.display_name, verified: false } : null,
    origin: { label: CORE_SOURCE_TEXT.catalogLabel, kind: 'catalog', repositoryUrl: null, homepage: null },
    version: latest?.version ?? null,
    digest: digestOf(sha),
    requires: { credentials: item.required_credential_specs ?? [] },
    runsCode: null,
    status: ready ? 'ready' : 'unsupported',
    unsupportedReason: ready ? null : 'no_revision',
    install: ready && latest ? { archivePath: skillDownloadPath(item.uuid, latest.revision_number) } : null
  }
}

/** A skills marketplace's entry as a directory entry. */
export function marketplaceSkillEntry(entry: MarketplaceSkillEntry): ProviderEntry {
  const digest = digestOf(entry.archiveSha256)
  const status: DirectoryEntry['status'] = !entry.supported ? 'unsupported' : digest ? 'ready' : 'pending'
  return {
    ref: { source: MARKETPLACE_SOURCE, id: entry.entryUuid },
    kind: 'skill',
    name: entry.name,
    title: entry.name,
    summary: summaryOf(entry.description),
    description: entry.description,
    category: null,
    tags: [],
    iconUrl: null,
    publisher: entry.marketplaceOwner ? { name: entry.marketplaceOwner, verified: false } : null,
    origin: { label: entry.marketplaceName, kind: 'marketplace', repositoryUrl: entry.repositoryUrl, homepage: null },
    version: entry.version,
    digest,
    requires: { credentials: [] },
    runsCode: entry.hasScripts,
    status,
    unsupportedReason: entry.supported ? null : entry.unsupportedReason,
    install: status === 'ready' && entry.archiveSha256
      ? { archivePath: snapshotDownloadPath(entry.entryUuid, entry.archiveSha256.toLowerCase()) }
      : null
  }
}

/**
 * A claude- or codex-format marketplace plugin as a directory entry (U3):
 * `pending` while core is still snapshotting it, `unsupported` (with core's
 * code) when it has no snapshot to pin, else ready to add with its parts.
 */
export function marketplacePluginEntry(entry: MarketplacePluginEntry): ProviderEntry {
  const digest = digestOf(entry.archiveSha256)
  const pinnable = entry.supported && digest !== null && isCatalogPinName(entry.name) && (PLUGIN_TYPES as readonly string[]).includes(entry.pluginType)
  const status: DirectoryEntry['status'] =
    !digest && entry.snapshotStatus === 'pending' && entry.supported ? 'pending' : pinnable ? 'ready' : 'unsupported'
  const publisher = entry.author ?? entry.marketplaceOwner
  return {
    ref: { source: PLUGIN_SOURCE, id: entry.entryUuid },
    kind: 'plugin',
    name: entry.name,
    title: entry.name,
    summary: summaryOf(entry.description),
    description: entry.description,
    category: entry.category,
    tags: [],
    iconUrl: null,
    publisher: publisher ? { name: publisher, verified: false } : null,
    origin: { label: entry.marketplaceName, kind: 'marketplace', repositoryUrl: entry.repositoryUrl, homepage: entry.homepage },
    version: entry.version,
    digest,
    ...(entry.components ? { components: entry.components } : {}),
    requires: { credentials: [] },
    runsCode: entry.runsCode,
    status,
    unsupportedReason: status === 'unsupported' ? (entry.snapshotReason ?? entry.unsupportedReason ?? 'unsupported') : null,
    install: status === 'ready' && entry.archiveSha256 ? { archivePath: pluginArchivePath(entry.entryUuid, entry.archiveSha256) } : null
  }
}

/* ------------------------------------------------ core's own shape (U4) */

type Wire = Record<string, unknown>
const rec = (value: unknown): Wire | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Wire) : null)
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const strs = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** core's `install.mcp.env` items: the names a server needs, never a value. */
function envNamesOf(raw: unknown): AddonMcpEnvName[] {
  const seen = new Set<string>()
  return (Array.isArray(raw) ? raw : []).flatMap((item): AddonMcpEnvName[] => {
    const env = rec(item)
    const name = str(env?.name)
    if (!env || !name || !ENV_NAME.test(name) || seen.has(name)) return []
    seen.add(name)
    return [{ name, secret: env.secret !== false, description: str(env.description) }]
  })
}

/**
 * core's MCP connect descriptor (`install.mcp`: transport, url or package,
 * auth, env names) as the desktop's; null when it cannot be run here (no
 * URL, no package, a registry this build does not know).
 */
export function fromCoreMcpConnect(raw: unknown): AddonMcpConnect | null {
  const mcp = rec(raw)
  if (!mcp) return null
  const env = envNamesOf(mcp.env)
  const auth = mcp.auth === 'oauth' || mcp.auth === 'bearer' || mcp.auth === 'env' ? mcp.auth : 'none'
  if (mcp.transport === 'http' || mcp.transport === 'sse') {
    const url = str(mcp.url)
    if (!url || !/^https?:\/\//i.test(url)) return null
    // A remote server's `env` names have nowhere to go on this computer: its auth is a sign-in or a token.
    return { transport: mcp.transport === 'sse' ? 'sse' : 'streamable-http', url, auth: auth === 'bearer' ? 'bearer' : 'oauth', requiresAuth: auth !== 'none' }
  }
  if (mcp.transport !== 'stdio') return null
  const pkg = rec(mcp.package)
  const registry = pkg?.registry
  const name = str(pkg?.name)?.trim()
  if (!pkg || !name || (registry !== 'npm' && registry !== 'pypi' && registry !== 'oci')) return null
  return {
    transport: 'stdio',
    package: { registry, name, version: str(pkg.version)?.trim() || null, args: strs(pkg.args) },
    auth: env.length > 0 || auth === 'env' ? 'env' : 'none',
    requiresAuth: env.length > 0,
    env
  }
}

/** The step after an add that core's connect descriptor implies, as the card's sentence. */
function mcpSetupReason(connect: AddonMcpConnect | null): string | undefined {
  if (!connect) return undefined
  if (connect.transport === 'stdio') return connect.env.length > 0 ? CORE_SOURCE_TEXT.needsEnv : undefined
  return connect.requiresAuth ? CORE_SOURCE_TEXT.needsAuth : undefined
}

/** Which kinds each core source lists; a row of another kind is not one the desktop can add. */
const KINDS_OF_SOURCE: Record<string, readonly AddonKind[]> = {
  [CATALOG_SOURCE]: ['skill'],
  [MARKETPLACE_SOURCE]: ['skill', 'plugin'],
  [CORE_MCP_SOURCE]: ['mcp']
}

/** One row of core's `/addons/directory` (snake_case) as a directory entry; null when it is not one. */
export function fromCoreEntry(raw: unknown): ProviderEntry | null {
  const row = rec(raw)
  const ref = rec(row?.ref)
  const source = str(ref?.source)
  const id = str(ref?.id)
  const kind = row?.kind
  const name = str(row?.name)
  if (!row || !source || !id || !name || (kind !== 'skill' && kind !== 'plugin' && kind !== 'mcp')) return null
  const origin = rec(row.origin)
  const publisher = rec(row.publisher)
  const install = rec(row.install)
  const allowedKinds = KINDS_OF_SOURCE[source]
  if (allowedKinds && !allowedKinds.includes(kind)) return null
  const connect = kind === 'mcp' ? fromCoreMcpConnect(install?.mcp) : null
  // An MCP row with no connect descriptor this build can run is listed, but cannot be added.
  const status = row.status === 'pending' || row.status === 'unsupported' ? row.status : kind === 'mcp' && !connect ? 'unsupported' : 'ready'
  const originKind = origin?.kind === 'catalog' || origin?.kind === 'directory' ? origin.kind : 'marketplace'
  const archivePath = str(install?.archive_path)
  const installOf: AddonInstall = connect ? { mcp: connect } : archivePath ? { archivePath } : null
  const setupReason = status === 'ready' ? mcpSetupReason(connect) : undefined
  return {
    // A plugin of a marketplace is pinned through its own service, not as a skill.
    ref: { source: kind === 'plugin' && source === MARKETPLACE_SOURCE ? PLUGIN_SOURCE : source, id },
    kind: kind as AddonKind,
    name,
    title: str(row.title) ?? name,
    summary: str(row.summary) ?? '',
    description: str(row.description) ?? '',
    category: str(row.category),
    tags: strs(row.tags),
    iconUrl: str(row.icon_url),
    publisher: publisher && str(publisher.name) ? { name: str(publisher.name)!, verified: publisher.verified === true } : null,
    origin: {
      label: str(origin?.label) ?? CORE_SOURCE_TEXT.label,
      kind: originKind,
      repositoryUrl: str(origin?.repository_url),
      homepage: str(origin?.homepage)
    },
    version: str(row.version),
    digest: str(row.digest),
    ...(componentsOf(row.components) ? { components: componentsOf(row.components) } : {}),
    requires: { credentials: (Array.isArray(rec(row.requires)?.credentials) ? (rec(row.requires)!.credentials as unknown[]) : []).flatMap((c) => (rec(c) ? [rec(c)!] : [])) },
    runsCode: typeof row.runs_code === 'boolean' ? row.runs_code : null,
    status,
    unsupportedReason: status === 'unsupported' ? (str(row.unsupported_reason) ?? (kind === 'mcp' && !connect ? 'unknown_source' : null)) : null,
    install: installOf,
    ...(setupReason ? { setupReason } : {})
  }
}

/** Core's `policy` (snake_case); a missing or malformed flag keeps today's behaviour (allowed). */
export function fromCorePolicy(raw: unknown): AddonPolicy {
  const p = rec(raw)
  const flag = (key: string, fallback: boolean): boolean => (typeof p?.[key] === 'boolean' ? (p[key] as boolean) : fallback)
  return {
    externalDirectories: flag('external_directories', DEFAULT_ADDON_POLICY.externalDirectories),
    customMcp: flag('custom_mcp', DEFAULT_ADDON_POLICY.customMcp),
    pluginHooks: flag('plugin_hooks', DEFAULT_ADDON_POLICY.pluginHooks),
    stdioMcp: flag('stdio_mcp', DEFAULT_ADDON_POLICY.stdioMcp)
  }
}

/* ------------------------------------------------------------ provider */

export interface CinnaCoreReads {
  profile(): string
  /** Null: not a Cinna profile. */
  hostOf(profile: string): string | null
  /** `refresh`: read the server, not the cached listing. */
  catalogItems(profile: string, refresh: boolean): Promise<CatalogItem[] | null>
  marketplaceSkills(): ReturnType<typeof marketplaceSkillService.discover>
  marketplacePlugins(): ReturnType<typeof marketplacePluginService.discover>
  /**
   * Core's `/addons/directory`, conditional on `etag` when given: the status
   * and the parsed body. Absent: this core has no unified directory (the
   * three reads above are the index). Throws as `cinnaSend` does (a 401).
   */
  directory?(profile: string, etag: string | null): Promise<{ status: number; body: unknown }>
  now(): number
}

const defaultReads: CinnaCoreReads = {
  profile: getProfileScopeUserId,
  hostOf: (profile) => libraryService.hostOf(profile),
  catalogItems: async (profile, refresh) => {
    const listing = await libraryService.items(profile, refresh)
    return listing ? listing.items : null
  },
  marketplaceSkills: () => marketplaceSkillService.discover(),
  marketplacePlugins: () => marketplacePluginService.discover(),
  directory: async (profile, etag) => {
    const answer = await cinnaSend(profile, CORE_DIRECTORY_PATH, { method: 'GET', ...(etag ? { headers: { 'If-None-Match': etag } } : {}) })
    return { status: answer.status, body: answer.body }
  },
  now: () => Date.now()
}

function isReauth(err: unknown): boolean {
  return err instanceof CinnaReauthRequired || (err instanceof CinnaApiError && err.code === 'reauth_required')
}

export function createCinnaCoreProvider(reads: CinnaCoreReads = defaultReads): DirectoryProvider & { invalidate(): void } {
  let marketplaceCache: { key: string; at: number; entries: ProviderEntry[] } | null = null
  /** Core's last whole index answer, per account; its ETag asks whether it changed. */
  let indexCache: { key: string; at: number; etag: string | null; entries: ProviderEntry[]; policy: AddonPolicy } | null = null
  /** Accounts whose core answered 404: the older reads until the next refresh. */
  const legacy = new Set<string>()
  const invalidate = (): void => {
    marketplaceCache = null
    legacy.clear()
    // The index is kept for its ETag: the next read asks the server, and a 304 reuses it.
    if (indexCache) indexCache = { ...indexCache, at: Number.NEGATIVE_INFINITY }
  }

  type Part = { entries: ProviderEntry[]; error?: string; reauth?: boolean }

  async function marketplace(key: string): Promise<Part> {
    if (marketplaceCache && marketplaceCache.key === key && reads.now() - marketplaceCache.at < CORE_DIRECTORY_TTL_MS) {
      return { entries: marketplaceCache.entries }
    }
    const [skills, plugins] = await Promise.all([reads.marketplaceSkills(), reads.marketplacePlugins()])
    const failed = (answer: { ok: false; code: string }, sentence: string): Part =>
      answer.code === 'no_account'
        ? { entries: [] }
        : answer.code === 'reauth_required'
          ? { entries: [], error: CORE_SOURCE_TEXT.reauth, reauth: true }
          : { entries: [], error: sentence }
    const fromSkills: Part = skills.ok ? { entries: skills.entries.map(marketplaceSkillEntry) } : failed(skills, CORE_SOURCE_TEXT.marketplaceFailed)
    const fromPlugins: Part = plugins.ok ? { entries: plugins.entries.map(marketplacePluginEntry) } : failed(plugins, CORE_SOURCE_TEXT.pluginsFailed)
    const entries = [...fromSkills.entries, ...fromPlugins.entries]
    const errors = [...new Set([fromSkills.error, fromPlugins.error].filter((e): e is string => !!e))]
    // Only a whole answer is reused; a part that failed is asked again next time.
    if (errors.length === 0) marketplaceCache = { key, at: reads.now(), entries }
    return {
      entries,
      ...(errors.length ? { error: errors.join(' ') } : {}),
      ...(fromSkills.reauth || fromPlugins.reauth ? { reauth: true } : {})
    }
  }

  async function catalog(profile: string, refresh: boolean): Promise<Part> {
    try {
      const items = await reads.catalogItems(profile, refresh)
      return { entries: (items ?? []).flatMap((item) => catalogSkillEntry(item) ?? []) }
    } catch (err) {
      logger.warn('catalog skills could not be read for the directory', { error: err instanceof Error ? err.message : String(err) })
      return isReauth(err) ? { entries: [], error: CORE_SOURCE_TEXT.reauth, reauth: true } : { entries: [], error: CORE_SOURCE_TEXT.catalogFailed }
    }
  }

  /**
   * The entries, flagged as holding core's MCP directory only when they do: an
   * index with no `core-mcp-directory` entry (none seeded, or none this account
   * may see) leaves the opencinna list to the MCP registries provider.
   */
  const withMcpFlag = (entries: ProviderEntry[]): Pick<ProviderListing, 'entries' | 'mcpDirectory'> =>
    entries.some((entry) => entry.ref.source === CORE_MCP_SOURCE) ? { entries, mcpDirectory: true } : { entries }

  /** What the cached index still offers when a read failed: its entries (no policy — the stored one stands). */
  const staleListing = (key: string): Pick<ProviderListing, 'entries' | 'mcpDirectory'> =>
    indexCache && indexCache.key === key ? withMcpFlag(indexCache.entries) : { entries: [] }

  /** core's unified index, or `legacy` when this core has none (404). */
  async function unified(profile: string, key: string, read: NonNullable<CinnaCoreReads['directory']>): Promise<ProviderListing | 'legacy'> {
    if (indexCache && indexCache.key === key && reads.now() - indexCache.at < CORE_DIRECTORY_TTL_MS) {
      return { ...withMcpFlag(indexCache.entries), policy: indexCache.policy }
    }
    const etag = indexCache && indexCache.key === key ? indexCache.etag : null
    let answer: { status: number; body: unknown }
    try {
      answer = await read(profile, etag)
    } catch (err) {
      logger.warn('the Cinna addon directory could not be read', { error: err instanceof Error ? err.message : String(err) })
      return isReauth(err)
        ? { entries: [], error: CORE_SOURCE_TEXT.reauth, errorCode: 'reauth' }
        : { ...staleListing(key), error: CORE_SOURCE_TEXT.directoryFailed }
    }
    if (answer.status === 404) return 'legacy'
    if (answer.status === 304 && indexCache && indexCache.key === key) {
      indexCache = { ...indexCache, at: reads.now() }
      return { ...withMcpFlag(indexCache.entries), policy: indexCache.policy }
    }
    if (answer.status === 401 || answer.status === 403) return { entries: [], error: CORE_SOURCE_TEXT.reauth, errorCode: 'reauth' }
    const body = rec(answer.body)
    if (answer.status !== 200 || !body || !Array.isArray(body.data)) {
      logger.warn('the Cinna addon directory answered something else', { status: answer.status })
      return { ...staleListing(key), error: CORE_SOURCE_TEXT.directoryFailed }
    }
    const entries = body.data.flatMap((row) => fromCoreEntry(row) ?? [])
    const policy = fromCorePolicy(body.policy)
    indexCache = { key, at: reads.now(), etag: str(body.etag), entries, policy }
    return { ...withMcpFlag(entries), policy }
  }

  /** The reads an older core answers: catalog skills and the marketplaces, and no policy. */
  async function older(profile: string, key: string, refresh: boolean): Promise<ProviderListing> {
    const [fromCatalog, fromMarketplace] = await Promise.all([catalog(profile, refresh), marketplace(key)])
    const errors = [...new Set([fromCatalog.error, fromMarketplace.error].filter((e): e is string => !!e))]
    return {
      entries: [...fromCatalog.entries, ...fromMarketplace.entries],
      ...(errors.length ? { error: errors.join(' ') } : {}),
      ...(fromCatalog.reauth || fromMarketplace.reauth ? { errorCode: 'reauth' as const } : {})
      // No policy: this core sends none, so the one stored for the account (or the default) stands.
    }
  }

  return {
    id: 'cinna-core',
    label: CORE_SOURCE_TEXT.label,
    owns: (ref) => ref.source === CATALOG_SOURCE || ref.source === MARKETPLACE_SOURCE || ref.source === PLUGIN_SOURCE || ref.source === CORE_MCP_SOURCE,
    invalidate,
    async list(ctx): Promise<ProviderListing> {
      const profile = reads.profile()
      const host = reads.hostOf(profile)
      // Signed out or local-only: nothing from core, and nothing wrong.
      if (host === null) return { entries: [] }
      // The picker's once-per-opening read: past the TTLs and the cached catalog listing.
      if (ctx.refresh) invalidate()
      const key = `${profile}\u0000${host}`
      if (reads.directory && !legacy.has(key)) {
        const answer = await unified(profile, key, reads.directory)
        if (answer !== 'legacy') return answer
        logger.info('this Cinna server has no addon directory; reading the catalog and marketplaces')
        legacy.add(key)
      }
      return older(profile, key, ctx.refresh === true)
    }
  }
}
