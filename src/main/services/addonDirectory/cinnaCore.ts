/**
 * The `cinna-core` directory provider: what the active profile's Cinna server
 * offers. In U0 it joins two reads that exist already — the catalog listing's
 * skill packages (what the Add skill modal's Catalog view shows, through
 * `libraryService`) and the skills marketplaces' entries
 * (`marketplaceSkillService.discover`). Signed out or local-only: no entries
 * and no error.
 *
 * U4 swaps both reads for core's `GET /api/v1/addons/directory`, which also
 * carries plugins, core MCP entries and the `policy`. That swap is local to
 * this file: {@link fromCoreEntry} and {@link fromCorePolicy} already map
 * core's snake_case shape (README §3.1/§3.2), and nothing outside reads the
 * per-source mappers below.
 */

import { getProfileScopeUserId } from '../../auth/scope'
import { CinnaReauthRequired } from '../../auth/cinna-oauth'
import { CinnaApiError } from '../../errors'
import { createLogger } from '../../logger/logger'
import { libraryService } from '../libraryService'
import { marketplaceSkillService, snapshotDownloadPath } from '../marketplaceSkillService'
import { skillDownloadPath } from '../catalogSkillService'
import type { CatalogItem } from '../../../shared/catalogItems'
import type { MarketplaceSkillEntry } from '../../../shared/marketplaceSkills'
import {
  DEFAULT_ADDON_POLICY,
  type AddonComponents,
  type AddonKind,
  type AddonPolicy,
  type DirectoryEntry
} from '../../../shared/addons/directory'
import { CATALOG_SOURCE, MARKETPLACE_SOURCE } from './directory'
import type { DirectoryProvider, ProviderEntry, ProviderListing } from './types'

const logger = createLogger('AddonDirectory')

/** The marketplace list is read whole; this long it is reused before reading again. */
export const CORE_DIRECTORY_TTL_MS = 60_000

export const CORE_SOURCE_TEXT = {
  label: 'Cinna',
  catalogLabel: 'Catalog',
  reauth: 'Your Cinna session expired. Sign in again to see the catalog and marketplace addons.',
  catalogFailed: 'Could not load the catalog.',
  marketplaceFailed: 'Could not load the marketplace skills.'
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

/* ------------------------------------------------ core's own shape (U4) */

type Wire = Record<string, unknown>
const rec = (value: unknown): Wire | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Wire) : null)
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const strs = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])

function componentsOf(raw: unknown): AddonComponents | undefined {
  const c = rec(raw)
  if (!c) return undefined
  const hooks = rec(c.hooks)
  return {
    skills: (Array.isArray(c.skills) ? c.skills : []).flatMap((s) => {
      const skill = rec(s)
      const name = str(skill?.name)
      return name ? [{ name, hasScripts: skill?.has_scripts === true }] : []
    }),
    commands: strs(c.commands),
    agents: strs(c.agents),
    hooks: hooks ? { events: strs(hooks.events) } : null,
    mcpServers: (Array.isArray(c.mcp_servers) ? c.mcp_servers : []).flatMap((s) => {
      const server = rec(s)
      const name = str(server?.name)
      if (!server || !name) return []
      const transport = server.transport === 'http' || server.transport === 'sse' ? server.transport : 'stdio'
      const runtime = server.runtime === 'node' || server.runtime === 'python' || server.runtime === 'docker' ? server.runtime : null
      const auth = server.auth === 'oauth' || server.auth === 'bearer' || server.auth === 'env' ? server.auth : 'none'
      const env = (Array.isArray(server.env) ? server.env : []).flatMap((e) => {
        const item = rec(e)
        const envName = str(item?.name)
        return envName ? [{ name: envName, secret: item?.secret === true }] : []
      })
      return [{ name, transport, runtime, auth, env }]
    }),
    lspServers: strs(c.lsp_servers)
  }
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
  const status = row.status === 'pending' || row.status === 'unsupported' ? row.status : 'ready'
  const originKind = origin?.kind === 'catalog' || origin?.kind === 'directory' ? origin.kind : 'marketplace'
  return {
    ref: { source, id },
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
    unsupportedReason: str(row.unsupported_reason),
    install: str(install?.archive_path) ? { archivePath: str(install!.archive_path)! } : null
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
  now: () => Date.now()
}

function isReauth(err: unknown): boolean {
  return err instanceof CinnaReauthRequired || (err instanceof CinnaApiError && err.code === 'reauth_required')
}

export function createCinnaCoreProvider(reads: CinnaCoreReads = defaultReads): DirectoryProvider & { invalidate(): void } {
  let marketplaceCache: { key: string; at: number; entries: ProviderEntry[] } | null = null
  const invalidate = (): void => {
    marketplaceCache = null
  }

  type Part = { entries: ProviderEntry[]; error?: string; reauth?: boolean }

  async function marketplace(key: string): Promise<Part> {
    if (marketplaceCache && marketplaceCache.key === key && reads.now() - marketplaceCache.at < CORE_DIRECTORY_TTL_MS) {
      return { entries: marketplaceCache.entries }
    }
    const answer = await reads.marketplaceSkills()
    if (!answer.ok) {
      if (answer.code === 'no_account') return { entries: [] }
      return answer.code === 'reauth_required'
        ? { entries: [], error: CORE_SOURCE_TEXT.reauth, reauth: true }
        : { entries: [], error: CORE_SOURCE_TEXT.marketplaceFailed }
    }
    const entries = answer.entries.map(marketplaceSkillEntry)
    marketplaceCache = { key, at: reads.now(), entries }
    return { entries }
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

  return {
    id: 'cinna-core',
    label: CORE_SOURCE_TEXT.label,
    owns: (ref) => ref.source === CATALOG_SOURCE || ref.source === MARKETPLACE_SOURCE,
    invalidate,
    async list(ctx): Promise<ProviderListing> {
      const profile = reads.profile()
      const host = reads.hostOf(profile)
      // Signed out or local-only: nothing from core, and nothing wrong.
      if (host === null) return { entries: [] }
      // The picker's once-per-opening read: past the marketplace's TTL and the cached catalog listing.
      if (ctx.refresh) invalidate()
      const [fromCatalog, fromMarketplace] = await Promise.all([
        catalog(profile, ctx.refresh === true),
        marketplace(`${profile}\u0000${host}`)
      ])
      const errors = [...new Set([fromCatalog.error, fromMarketplace.error].filter((e): e is string => !!e))]
      return {
        entries: [...fromCatalog.entries, ...fromMarketplace.entries],
        ...(errors.length ? { error: errors.join(' ') } : {}),
        ...(fromCatalog.reauth || fromMarketplace.reauth ? { errorCode: 'reauth' as const } : {})
      }
    }
  }
}
