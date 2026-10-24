/**
 * Marketplace plugins in local agents (unified addons U3): find the claude-
 * and codex-format plugins the marketplaces connected to cinna-core offer,
 * pin one into a kit agent's `marketplace_plugins[]` (contract 1.17.0), move
 * a pin to the entry's current snapshot, turn parts of it off, drop it, and
 * bring every pinned snapshot — and the managed connectors it carries — onto
 * this computer.
 *
 * Built like `marketplaceSkillService.ts`, and sharing its rules:
 *
 * * **Pins, not copies.** The archive core serves (`…/plugins/{id}/archive`)
 *   is downloaded once into the shared read-only cache
 *   (`marketplacePluginCache.ts`); the bytes must equal the server's
 *   `X-Archive-Sha256` **and** the pin's digest before the safe reader
 *   (`kit/skillArchive.ts` `readPluginArchive`) unpacks them.
 * * **Visibility.** A pin whose entry the person cannot see any more is
 *   `unavailable` in {@link marketplacePluginService.status}: no error, and the
 *   cached copy keeps being delivered. Core keeps only the newest snapshot of
 *   a plugin, so a pin left behind is `snapshot_missing` to download but works
 *   from the cache, and reads "Update available".
 * * **Who may change pins** is the catalog's rule (`changeability`).
 * * **Decomposed, not executed blindly.** Skills join the agent's skill
 *   delivery (`pluginSkills.ts`), Claude gets commands / agents / hooks through
 *   a wrapper plugin (`agentPluginWrappers.ts`), OpenCode its commands through
 *   its config, and every MCP server becomes a managed Cinna MCP provider
 *   (`pluginMcpProviders.ts`). A Python server runs through the managed uv,
 *   a Node or Docker one needs that runtime already installed
 *   (`stdioRuntimes.ts`), and core's `policy.stdio_mcp` can forbid them.
 *
 * Every answer is data; nothing a caller can cause is thrown, because a thrown
 * code does not survive IPC. Core service: no Electron, no window.
 */

import { createHash } from 'node:crypto'
import { getProfileScopeUserId, getSettingsScopeUserId } from '../auth/scope'
import { CinnaApiError, KitError } from '../errors'
import { CinnaSessionChanged } from '../auth/cinna-session'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { createLogger } from '../logger/logger'
import { runtimeHost } from '../host/runtimeHost'
import { cinnaFetch, cinnaFetchBytes } from './cinna-http'
import { libraryService } from './libraryService'
import { instanceKey } from './pinnedSkillCache'
import { activeListing } from './catalogSkillUpdates'
import { changeability, locateKit, pinnedKeys, settle, type KitTarget } from './catalogSkillService'
import { manifestPath, readManifest, readWithStamp, writeIfUnchanged } from '../kit/manifestIo'
import { MAX_ARCHIVE_BYTES, readPluginArchive, SkillArchiveError } from '../kit/skillArchive'
import { isCatalogPinName } from '../kit/skills'
import { batchPath, BATCH_MAX_IDS, DISCOVER_PAGE_SIZE } from './marketplaceSkillService'
import {
  archiveDigests,
  marketplacePluginCache,
  marketplacePluginCacheRefOf,
  marketplacePluginRefOf,
  pluginSnapshotKeyOf,
  PLUGIN_TREE_MODIFIED_SENTENCE,
  verifyPluginTree,
  type MarketplacePluginRef
} from './marketplacePluginCache'
import { cachedPlugins, disabledOf, pluginPinsOf, pluginSkillRows } from './pluginSkills'
import { createPluginMcpProviders, type PluginMcpProviders, type ServerOutcome } from './pluginMcpProviders'
import { readPluginTree, type PluginMcpServerSpec } from './pluginTree'
import { runtimeOfCommand, stdioRuntimes, STDIO_RUNTIME_TEXT } from './stdioRuntimes'
import { addonPolicies } from './addonDirectory/policy'
import { agentSkillRows } from '../kit/skills'
import { catalogSkillCache } from './catalogSkillCache'
import { marketplaceSkillCache } from './marketplaceSkillCache'
import { mcpProviderRepo, type McpProviderRow } from '../db/mcpProviders'
import { agentMcpRepo } from '../db/agentMcp'
import { agentMcpService } from './agentMcpService'
import { mcpManager } from '../mcp/manager'
import { collectPluginWork, discardPluginWork, managedLaunchBlock, managedNeedsBearer, missingManagedEnv, pluginManagedBy, snapshotKeyOfManagedBy } from '../mcp/managed'
import { managedUvLayout } from '../localdev/toolchain'
import { effectiveEngine, type AgentEngine } from '../../shared/engine'
import { compatibilityOf, engineSupports, ENGINE_LABELS } from '../../shared/addons/engineSupport'
import type { AddonComponents, AddonMcpServerComponent, AddonNextStep, AddonPolicy } from '../../shared/addons/directory'
import type { CinnaAgentManifest, MarketplacePluginPin } from '../../shared/kit/manifest'
import type {
  PluginActionResult,
  PluginDisabledInput,
  PluginPinStatus,
  PluginRefusal,
  PluginRefused,
  PluginRevealResult,
  PluginServerStatus,
  PluginStatusResult
} from '../../shared/addons/plugins'

const logger = createLogger('marketplace-plugins')

/** The plugin formats a local agent can pin (skills-format entries are marketplace skills). */
export const PLUGIN_TYPES = ['claude', 'codex'] as const
const DISCOVER_MAX_PAGES = 10

export function pluginDiscoverPath(type: string, skip: number, limit: number): string {
  return `/api/v1/llm-plugins/discover?plugin_type=${encodeURIComponent(type)}&skip=${skip}&limit=${limit}`
}

/** One entry's snapshot archive, by digest (every format). */
export function pluginArchivePath(entryUuid: string, sha256: string): string {
  return `/api/v1/llm-plugins/plugins/${encodeURIComponent(entryUuid)}/archive?sha256=${encodeURIComponent(sha256)}`
}

export const MARKETPLACE_PLUGIN_SENTENCES: Record<PluginRefusal, string> = {
  no_account: 'Marketplace plugins need a Cinna account.',
  not_found: 'That agent or plugin is no longer here.',
  not_kit_agent: 'Only an agent with a cinna-agent.json can hold plugins.',
  read_only: 'This agent is shared with you to use. Its plugins change when the team shares a new version.',
  access_unknown: 'This shared agent is not in your catalog listing, so its plugins cannot be changed here.',
  already_added: 'This agent already has this plugin.',
  unsupported: 'This plugin cannot be added: its marketplace has no copy of it to download.',
  preparing: 'Being prepared on the server',
  snapshot_missing: 'The server no longer keeps this version of the plugin.',
  download_failed: 'The plugin could not be downloaded.',
  hash_mismatch: 'The download did not match the marketplace’s copy, so nothing was kept.',
  invalid_archive: 'The plugin’s files could not be unpacked safely.',
  too_large: 'The plugin is larger than 16 MB.',
  manifest_modified: 'cinna-agent.json changed while the plugin was downloading. Try again.',
  write_failed: 'The plugin could not be saved on this computer.',
  reauth_required: 'Sign in to Cinna again to use marketplace plugins.',
  network: 'The marketplaces could not be reached. Try again.',
  blocked: STDIO_RUNTIME_TEXT.policy,
  runtime_failed: STDIO_RUNTIME_TEXT.uvFailed
}

export const PLUGIN_STATUS_TEXT = {
  unavailable: 'No longer available to you',
  update: 'Update available',
  notVisible: 'This plugin is no longer in a marketplace you can see.',
  hooksEngine: (engine: AgentEngine) => `Hooks run on Claude only, not on ${ENGINE_LABELS[engine]}.`,
  hooksPolicy: 'Plugin hooks are turned off by your admin.',
  notCached: 'This plugin is not on this computer yet.'
} as const

/** "This agent already has …": the same entry, or another marketplace's plugin of the same name. */
function alreadyAdded(existing: MarketplacePluginPin, pin: MarketplacePluginPin): PluginRefused {
  if (pinsEntry(existing, pin.entry_uuid)) return refused('already_added')
  const from = typeof existing.marketplace_name === 'string' && existing.marketplace_name.trim() !== '' ? existing.marketplace_name.trim() : 'another marketplace'
  return refused('already_added', `This agent already has a plugin named ${pin.name} from ${from}.`)
}

/** The pin of the agent that a new `pin` collides with: the same entry, or the same name. */
function collision(pins: readonly MarketplacePluginPin[], pin: MarketplacePluginPin): MarketplacePluginPin | null {
  return pins.find((existing) => pinsEntry(existing, pin.entry_uuid)) ?? pins.find((existing) => rec(existing)?.name === pin.name) ?? null
}

function refused(code: PluginRefusal, message?: string): PluginRefused {
  return { ok: false, code, message: message ?? MARKETPLACE_PLUGIN_SENTENCES[code] }
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
const rec = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
const strs = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])

/* ---------------------------------------------------------------- entries */

/** core's `components` (snake_case) as the directory's shape; undefined when absent. */
export function componentsOf(raw: unknown): AddonComponents | undefined {
  const c = rec(raw)
  if (!c) return undefined
  const hooks = rec(c.hooks)
  return {
    skills: (Array.isArray(c.skills) ? c.skills : []).flatMap((s) => {
      const skill = rec(s)
      const name = textOrNull(skill?.name)
      return name ? [{ name, hasScripts: skill?.has_scripts === true }] : []
    }),
    commands: strs(c.commands),
    agents: strs(c.agents),
    hooks: hooks ? { events: strs(hooks.events) } : null,
    mcpServers: (Array.isArray(c.mcp_servers) ? c.mcp_servers : []).flatMap((s): AddonMcpServerComponent[] => {
      const server = rec(s)
      const name = textOrNull(server?.name)
      if (!server || !name) return []
      const transport = server.transport === 'http' || server.transport === 'sse' ? server.transport : 'stdio'
      const runtime = server.runtime === 'node' || server.runtime === 'python' || server.runtime === 'docker' ? server.runtime : null
      const auth = server.auth === 'oauth' || server.auth === 'bearer' || server.auth === 'env' ? server.auth : 'none'
      const env = (Array.isArray(server.env) ? server.env : []).flatMap((e) => {
        const item = rec(e)
        const envName = textOrNull(item?.name)
        return envName ? [{ name: envName, secret: item?.secret === true }] : []
      })
      return [{ name, transport, runtime, auth, env }]
    }),
    lspServers: strs(c.lsp_servers)
  }
}

/** One plugin row of `/discover` or the batch lookup, as core sends it. */
export interface MarketplacePluginEntry {
  entryUuid: string
  name: string
  /** The marketplace's display title, when it sends one. */
  title: string | null
  description: string
  pluginType: string
  marketplaceUuid: string
  marketplaceName: string
  marketplaceOwner: string | null
  author: string | null
  repositoryUrl: string | null
  homepage: string | null
  category: string | null
  version: string | null
  commitHash: string | null
  supported: boolean
  unsupportedReason: string | null
  archiveSha256: string | null
  archiveSize: number | null
  /** `pending` | `ready` | `failed`, or null when core has none for it. */
  snapshotStatus: 'pending' | 'ready' | 'failed' | null
  snapshotReason: string | null
  runsCode: boolean | null
  components: AddonComponents | null
}

export function toPluginEntry(raw: unknown): MarketplacePluginEntry | null {
  const row = rec(raw)
  const entryUuid = textOrNull(row?.id)
  if (!row || !entryUuid) return null
  const digest = textOrNull(row.archive_sha256)
  const size = row.archive_size
  const status = row.snapshot_status === 'pending' || row.snapshot_status === 'ready' || row.snapshot_status === 'failed' ? row.snapshot_status : null
  return {
    entryUuid,
    name: textOrNull(row.name) ?? '',
    title: textOrNull(row.title) ?? textOrNull(row.display_name),
    description: textOrNull(row.description) ?? '',
    pluginType: textOrNull(row.plugin_type) ?? '',
    marketplaceUuid: textOrNull(row.marketplace_id) ?? '',
    marketplaceName: textOrNull(row.marketplace_name) ?? '',
    marketplaceOwner: textOrNull(row.marketplace_owner),
    author: textOrNull(row.author_name),
    repositoryUrl: textOrNull(row.repository_url),
    homepage: textOrNull(row.homepage),
    category: textOrNull(row.category),
    version: textOrNull(row.version),
    commitHash: textOrNull(row.commit_hash) ?? textOrNull(row.source_commit_hash),
    supported: row.supported !== false,
    unsupportedReason: textOrNull(row.unsupported_reason),
    archiveSha256: digest && /^[0-9a-fA-F]{64}$/.test(digest) ? digest.toLowerCase() : null,
    archiveSize: typeof size === 'number' && Number.isFinite(size) ? size : null,
    snapshotStatus: status,
    snapshotReason: textOrNull(row.snapshot_reason),
    runsCode: typeof row.runs_code === 'boolean' ? row.runs_code : null,
    components: componentsOf(row.components) ?? null
  }
}

const isPluginType = (type: string): boolean => (PLUGIN_TYPES as readonly string[]).includes(type)

interface EntryPage {
  data?: unknown
  count?: unknown
}

/** The visible plugin entries among `ids`, by lowercase id. */
async function lookupEntries(profile: string, ids: readonly string[]): Promise<Map<string, MarketplacePluginEntry>> {
  const unique = [...new Set(ids.map((id) => id.trim().toLowerCase()).filter((id) => id !== ''))]
  const found = new Map<string, MarketplacePluginEntry>()
  for (let at = 0; at < unique.length; at += BATCH_MAX_IDS) {
    const page = await cinnaFetch<EntryPage>(profile, batchPath(unique.slice(at, at + BATCH_MAX_IDS)))
    const rows = Array.isArray(page?.data) ? page.data : []
    for (const entry of rows.map(toPluginEntry)) if (entry) found.set(entry.entryUuid.toLowerCase(), entry)
  }
  return found
}

function readRefusal(err: unknown): PluginRefused {
  if (err instanceof CinnaReauthRequired) return refused('reauth_required')
  if (err instanceof CinnaApiError) {
    if (err.code === 'reauth_required') return refused('reauth_required')
    if (err.code === 'not_cinna_user' || err.code === 'missing_server_url') return refused('no_account')
  }
  logger.warn('marketplace plugins could not be read', { error: err instanceof Error ? err.message : String(err) })
  return refused('network')
}

/* ------------------------------------------------------------- downloads */

interface NotAvailable {
  ok: false
  notAvailable: true
}

type FetchOutcome = { ok: true } | PluginRefused | NotAvailable

const inFlight = new Map<string, Promise<FetchOutcome>>()

function detailCode(err: CinnaApiError): string | null {
  try {
    const parsed = JSON.parse(err.detail ?? '') as { detail?: { code?: unknown } }
    return typeof parsed?.detail?.code === 'string' ? parsed.detail.code : null
  } catch {
    return null
  }
}

function downloadRefusal(err: unknown): PluginRefused | NotAvailable {
  if (err instanceof CinnaReauthRequired) return refused('reauth_required')
  if (err instanceof CinnaApiError) {
    if (err.code === 'reauth_required' && err.status === 403) return refused('download_failed', 'The server did not allow this download.')
    if (err.code === 'reauth_required') return refused('reauth_required')
    const code = detailCode(err)
    if (err.status === 404 && code === 'snapshot_missing') return refused('snapshot_missing')
    if (err.status === 404) return { ok: false, notAvailable: true }
    if (err.status === 409 && code === 'snapshot_pending') return refused('preparing')
    if (err.status === 409) return refused('unsupported')
    if (err.code === 'not_cinna_user' || err.code === 'missing_server_url') return refused('no_account')
    return refused('download_failed', `The plugin could not be downloaded: ${err.message}`.slice(0, 300))
  }
  if (err instanceof CinnaSessionChanged) return refused('download_failed', 'The Cinna account changed during the download.')
  if (err instanceof SkillArchiveError) return refused('invalid_archive', err.message)
  return refused('download_failed', `The plugin could not be downloaded: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300))
}

/**
 * Fetch one pinned snapshot into the active instance's cache. The bytes must
 * equal both the server's `X-Archive-Sha256` and the pin's digest before they
 * are unpacked; any failure leaves the cache as it was and is remembered for
 * the plugin's row. One download per snapshot at a time.
 */
function fetchSnapshot(profile: string, host: string, target: MarketplacePluginRef): Promise<FetchOutcome> {
  const instance = instanceKey(host)
  const safe = marketplacePluginCacheRefOf(target)
  if (safe === null) return Promise.resolve(refused('download_failed', 'This pin does not name a marketplace plugin that can be downloaded.'))
  const key = `${instance}/${safe.uuid}/${safe.sha}/${safe.name}`
  const running = inFlight.get(key)
  if (running) return running
  const run = (async (): Promise<FetchOutcome> => {
    if (marketplacePluginCache.has(instance, target)) return { ok: true }
    let outcome: FetchOutcome
    try {
      const answer = await cinnaFetchBytes(profile, pluginArchivePath(safe.uuid, safe.sha), { maxBytes: MAX_ARCHIVE_BYTES })
      if (!answer.ok) {
        outcome = refused('too_large')
      } else {
        const digest = sha256(answer.bytes)
        const declared = (answer.headers.get('x-archive-sha256') ?? '').trim().toLowerCase()
        if (declared === '' || digest !== declared || digest !== safe.sha) {
          logger.warn('marketplace plugin digest mismatch', { name: target.name })
          outcome = refused('hash_mismatch')
        } else {
          const archive = readPluginArchive(answer.bytes, safe.name)
          try {
            // Every file's digest goes in the marker: a launch re-checks the tree against it.
            marketplacePluginCache.install(instance, { ...target, files: archiveDigests(archive) }, archive)
            outcome = { ok: true }
          } catch (err) {
            logger.warn('marketplace plugin could not be cached', { name: target.name, error: String(err) })
            outcome = refused('write_failed')
          }
        }
      }
    } catch (err) {
      outcome = downloadRefusal(err)
    }
    if (outcome.ok) marketplacePluginCache.clearFailure(target)
    else if ('notAvailable' in outcome) marketplacePluginCache.recordNotAvailable(target)
    else marketplacePluginCache.recordFailure(target, outcome.message)
    return outcome
  })().finally(() => inFlight.delete(key))
  inFlight.set(key, run)
  return run
}

function phrased(outcome: FetchOutcome): { ok: true } | PluginRefused {
  if (outcome.ok) return outcome
  if ('notAvailable' in outcome) return refused('not_found', PLUGIN_STATUS_TEXT.notVisible)
  return outcome
}

/* ---------------------------------------------------------------- agents */

function pinsOf(manifest: CinnaAgentManifest): MarketplacePluginPin[] {
  return Array.isArray(manifest.marketplace_plugins) ? manifest.marketplace_plugins : []
}

function pinsEntry(pin: unknown, uuid: string): boolean {
  const value = rec(pin)?.entry_uuid
  return typeof value === 'string' && value.trim().toLowerCase() === uuid.trim().toLowerCase()
}

function locate(userId: string, agentId: string): KitTarget | PluginRefused {
  const kit = locateKit(userId, agentId)
  return 'ok' in kit ? refused(kit.code === 'not_kit_agent' ? 'not_kit_agent' : 'not_found') : kit
}

function writePins(
  dir: string,
  change: (manifest: CinnaAgentManifest, pins: MarketplacePluginPin[]) => MarketplacePluginPin[] | PluginRefused
): { ok: true } | PluginRefused {
  const path = manifestPath(dir)
  try {
    const { manifest, stamp } = readWithStamp(path)
    const next = change(manifest, pinsOf(manifest))
    if (!Array.isArray(next)) return next
    writeIfUnchanged(path, { ...manifest, marketplace_plugins: next }, stamp)
    return { ok: true }
  } catch (err) {
    if (err instanceof KitError && err.code === 'manifest_modified') return refused('manifest_modified')
    if (err instanceof KitError) return refused('write_failed', err.message)
    throw err
  }
}

function account(): { profile: string; host: string } | PluginRefused {
  const profile = getProfileScopeUserId()
  const host = libraryService.hostOf(profile)
  return host === null ? refused('no_account') : { profile, host }
}

/** Why an entry cannot be pinned as it stands, or null. */
function entryRefusal(entry: MarketplacePluginEntry): PluginRefused | null {
  if (!isPluginType(entry.pluginType)) return refused('unsupported')
  if (entry.snapshotStatus === 'pending' && entry.archiveSha256 === null) return refused('preparing')
  if (!entry.supported || entry.archiveSha256 === null || !isCatalogPinName(entry.name)) return refused('unsupported')
  return null
}

function pinOf(entry: MarketplacePluginEntry): MarketplacePluginPin {
  return {
    entry_uuid: entry.entryUuid.toLowerCase(),
    marketplace_uuid: entry.marketplaceUuid,
    marketplace_name: entry.marketplaceName,
    name: entry.name,
    archive_sha256: entry.archiveSha256 ?? '',
    version: entry.version,
    commit_hash: entry.commitHash
  }
}

async function guarded<T extends { ok: boolean }>(verb: string, run: () => Promise<T | PluginRefused>): Promise<T | PluginRefused> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof CinnaReauthRequired || (err instanceof CinnaApiError && err.code === 'reauth_required')) return refused('reauth_required')
    if (err instanceof CinnaApiError) {
      if (err.code === 'not_cinna_user' || err.code === 'missing_server_url') return refused('no_account')
      logger.warn(`marketplace plugin ${verb}: the server could not be read`, { error: err.message })
      return refused('network')
    }
    logger.error(`marketplace plugin ${verb} failed`, { error: err instanceof Error ? err.message : String(err) })
    return refused('write_failed', `Something went wrong: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300))
  }
}

/* ------------------------------------------------------- managed servers */

const managedProviders: PluginMcpProviders = createPluginMcpProviders({
  rows: (userId) => mcpProviderRepo.list(userId),
  upsert: (userId, input) => mcpProviderRepo.upsert(userId, input),
  remove: async (userId, id) => {
    await mcpManager.disconnect(id).catch(() => undefined)
    mcpProviderRepo.delete(userId, id)
  },
  disconnect: async (id) => {
    await mcpManager.disconnect(id).catch(() => undefined)
  },
  attached: (userId, agentId) => agentMcpRepo.listProviderIds(userId, agentId),
  attach: (_userId, agentId, id) => {
    agentMcpRepo.attach(agentId, id)
  },
  detach: (_userId, agentId, id) => {
    agentMcpRepo.detach(agentId, id)
  },
  agentsUsing: (id) => agentMcpRepo.agentIdsFor(id),
  referenced: () => {
    const pinned = pinnedKeys((manifest) => pinsOf(manifest).map(pluginSnapshotKeyOf))
    return pinned.ok ? pinned.keep : null
  },
  uv: () => managedUvLayout()
})

/**
 * Delete every managed plugin connector of `userId` that no agent uses and no
 * pin anywhere references (`collectUnreferenced`) — after a Remove or an
 * Update, so a connector the user had switched off (detached, never looked at
 * by the agent's sync) goes with the last pin of its snapshot. Skipped when
 * any agent's pins cannot be read. Never throws.
 */
async function releaseUnreferenced(userId: string): Promise<void> {
  try {
    const pinned = pinnedKeys((manifest) => pinsOf(manifest).map(pluginSnapshotKeyOf))
    if (!pinned.ok) return
    const removed = await managedProviders.collectUnreferenced(userId, pinned.keep)
    if (removed > 0) logger.info('unreferenced plugin connectors removed', { removed })
  } catch (err) {
    logger.warn('unreferenced plugin connectors could not be removed', { error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * Remove the writable working copies (`plugin-work/<entry>/<sha>`) of every
 * snapshot no pin anywhere references and no managed connector still runs
 * (after an Update or a Remove). Skipped when any agent's pins cannot be
 * read. Never throws.
 */
function pruneWorkCopies(): void {
  try {
    const pinned = pinnedKeys((manifest) => pinsOf(manifest).map(pluginSnapshotKeyOf))
    if (!pinned.ok) return
    const keep = new Set(pinned.keep)
    for (const row of mcpProviderRepo.listAllManaged()) {
      const key = snapshotKeyOfManagedBy(row.managedBy)
      if (key !== null) keep.add(key)
    }
    const removed = collectPluginWork(keep)
    if (removed > 0) logger.info('plugin working copies removed', { removed })
  } catch (err) {
    logger.warn('plugin working copies could not be pruned', { error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * One chain of pin writes and syncs per agent: an add, update, remove,
 * set-disabled or background ensure runs only once the one before it on the
 * same agent has settled, so a slow ensure can never sync from a manifest a
 * remove already changed.
 */
const agentChains = new Map<string, Promise<unknown>>()

function serialized<T>(agentId: string, run: () => Promise<T>): Promise<T> {
  const before = agentChains.get(agentId) ?? Promise.resolve()
  const next = before.then(run, run)
  const settled = next.then(
    () => undefined,
    () => undefined
  )
  agentChains.set(agentId, settled)
  void settled.then(() => {
    if (agentChains.get(agentId) === settled) agentChains.delete(agentId)
  })
  return next
}

/** Live sessions of the agent re-list their tools after its connectors moved. */
function refreshAgentTools(agentId: string): void {
  void import('./conductorBridge')
    .then(({ conductorBridge }) => conductorBridge.refreshAgent(agentId))
    .catch((error) => logger.warn('Could not refresh agent tools', { agentId, error: String(error) }))
}

/**
 * Why a server cannot be installed here — the policy, a missing Node or
 * Docker — synchronously from this session's probes (`known`), which the
 * async callers settle first.
 */
function serverBlock(policy: AddonPolicy, known: { node: boolean; docker: boolean }) {
  return (spec: { transport: string; command: string | null }): string | null => {
    if (spec.transport !== 'stdio') return null
    if (!policy.stdioMcp) return STDIO_RUNTIME_TEXT.policy
    const runtime = runtimeOfCommand(spec.command)
    if (runtime === 'node' && !known.node) return STDIO_RUNTIME_TEXT.node
    if (runtime === 'docker' && !known.docker) return STDIO_RUNTIME_TEXT.docker
    return null
  }
}

/** This session's answer for Node and Docker, asked only when some server is a local one (each probe runs once a session). */
async function knownRuntimes(servers: readonly Pick<PluginMcpServerSpec, 'transport'>[]): Promise<{ node: boolean; docker: boolean }> {
  if (!servers.some((spec) => spec.transport === 'stdio')) return { node: true, docker: true }
  const [node, docker] = await Promise.all([stdioRuntimes.available('node'), stdioRuntimes.available('docker')])
  return { node, docker }
}

/**
 * Reconcile the agent's managed connectors with its plugins as they are on
 * disk now. The runtimes are settled first, then the manifest is read: the
 * sync works from what is pinned after the last await, never from a copy
 * read before one.
 */
async function syncServers(userId: string, agentId: string, dir: string): Promise<ServerOutcome[]> {
  const known = await knownRuntimes(cachedPlugins(readManifest(manifestPath(dir))).flatMap((plugin) => plugin.tree?.mcpServers ?? []))
  const plugins = cachedPlugins(readManifest(manifestPath(dir)))
  const block = serverBlock(addonPolicies.get(userId), known)
  const before = agentMcpRepo.listProviderIds(userId, agentId).join(',')
  const outcomes = await managedProviders.sync(
    userId,
    agentId,
    plugins.map((plugin) => ({
      entryUuid: plugin.pin.entry_uuid,
      sha: plugin.pin.archive_sha256,
      dir: plugin.dir,
      servers: plugin.tree?.mcpServers ?? [],
      disabled: disabledOf(plugin.pin).mcpServers
    })),
    block
  )
  if (agentMcpRepo.listProviderIds(userId, agentId).join(',') !== before) refreshAgentTools(agentId)
  return outcomes
}

/** The plugin's connectors that need nothing more of the user: what its Add starts at once. */
function readyToStart(outcomes: readonly ServerOutcome[], entryUuid: string): string[] {
  const uuid = entryUuid.toLowerCase()
  return outcomes.flatMap((outcome) =>
    outcome.entryUuid.toLowerCase() === uuid && outcome.mcpProviderId && !outcome.blocked && outcome.missingEnv.length === 0 && !outcome.needsBearer
      ? [outcome.mcpProviderId]
      : []
  )
}

/** The add's next step: settings values, or an access token, one of the plugin's new connectors still needs. */
function nextOf(outcomes: readonly ServerOutcome[], entryUuid: string): AddonNextStep | null {
  const uuid = entryUuid.toLowerCase()
  const mine = outcomes.filter((outcome) => outcome.entryUuid.toLowerCase() === uuid)
  if (mine.some((outcome) => outcome.missingEnv.length > 0)) return 'env'
  if (mine.some((outcome) => outcome.needsBearer)) return 'bearer'
  return null
}

/**
 * The downloaded snapshot `target` as it will run: its tree, why its servers
 * cannot be delivered here (the policy, a missing Node or Docker — judged by
 * the real commands in its `.mcp.json`, not core's description), and the
 * managed uv when one is Python. Answers a refusal, or the tree's servers.
 */
async function readyToPin(userId: string, target: MarketplacePluginRef): Promise<PluginRefused | { ok: true }> {
  const state = marketplacePluginCache.resolve(target)
  if (state.state !== 'ready') return refused('write_failed')
  if (!verifyPluginTree(state.dir)) return refused('invalid_archive', PLUGIN_TREE_MODIFIED_SENTENCE)
  const servers = readPluginTree(state.dir).mcpServers
  const block = serverBlock(addonPolicies.get(userId), await knownRuntimes(servers))
  const blocked = servers.map(block).find((reason) => reason !== null)
  if (blocked) return refused('blocked', blocked)
  if (servers.some((spec) => spec.transport === 'stdio' && runtimeOfCommand(spec.command) === 'python')) {
    try {
      await stdioRuntimes.ensureUv()
    } catch (err) {
      logger.warn('the managed uv could not be installed for a plugin', { error: err instanceof Error ? err.message : String(err) })
      return refused('runtime_failed')
    }
  }
  return { ok: true }
}

/** The engine the agent runs on: its manifest's, else this machine's Default Runtime (loaded on use). */
async function agentEngine(manifest: CinnaAgentManifest): Promise<AgentEngine> {
  let fallback: AgentEngine = 'opencode'
  try {
    const { defaultEngineService } = await import('./localAgents/defaultEngineService')
    fallback = defaultEngineService.current()
  } catch {
    /* the historical default */
  }
  return effectiveEngine(manifest.runtime ?? null, fallback)
}

/** {@link marketplacePluginService.ensurePinned}'s work, inside the agent's chain. */
async function ensurePinnedNow(
  userId: string,
  agentId: string
): Promise<{ ok: true; fetched: string[]; failed: Array<{ name: string; code: PluginRefusal; message: string }> } | PluginRefused> {
  try {
    const kit = locate(userId, agentId)
    if ('ok' in kit) return kit
    const pins = pluginPinsOf(readManifest(manifestPath(kit.dir)))
    if (pins.length === 0) {
      // No pins left: the sync releases whatever managed connectors the agent still holds.
      await syncServers(userId, agentId, kit.dir)
      return { ok: true, fetched: [], failed: [] }
    }
    const wanted = pins.map(marketplacePluginRefOf).filter((target) => marketplacePluginCache.resolve(target).state !== 'ready')
    const fetched: string[] = []
    const failed: Array<{ name: string; code: PluginRefusal; message: string }> = []
    if (wanted.length > 0) {
      const who = account()
      if ('ok' in who) {
        for (const target of wanted) {
          marketplacePluginCache.recordFailure(target, who.message)
          failed.push({ name: target.name, code: who.code, message: who.message })
        }
      } else {
        for (const target of wanted) {
          const outcome = phrased(await fetchSnapshot(who.profile, who.host, target))
          if (outcome.ok) fetched.push(target.name)
          else failed.push({ name: target.name, code: outcome.code, message: outcome.message })
        }
      }
    }
    const python = cachedPlugins(readManifest(manifestPath(kit.dir))).some((plugin) =>
      (plugin.tree?.mcpServers ?? []).some((spec) => spec.transport === 'stdio' && runtimeOfCommand(spec.command) === 'python')
    )
    if (python) await stdioRuntimes.ensureUv().catch((err) => logger.warn('the managed uv could not be installed', { error: String(err) }))
    // Read again inside the sync: the downloads and uv took time, and the pins are what they are now.
    await syncServers(userId, agentId, kit.dir)
    settle(kit.rootId, agentId)
    return { ok: true, fetched, failed }
  } catch (err) {
    logger.warn('pinned marketplace plugins could not be checked', { agentId, error: err instanceof Error ? err.message : String(err) })
    return refused('write_failed', 'The pinned plugins could not be checked.')
  }
}

export const marketplacePluginService = {
  /**
   * Every claude- and codex-format plugin entry this person can see
   * (`/discover`), page by page, so the picker filters locally.
   */
  async discover(): Promise<{ ok: true; entries: MarketplacePluginEntry[] } | PluginRefused> {
    const who = account()
    if ('ok' in who) return who
    try {
      const entries: MarketplacePluginEntry[] = []
      for (const type of PLUGIN_TYPES) {
        for (let page = 0; page < DISCOVER_MAX_PAGES; page++) {
          const answer = await cinnaFetch<EntryPage>(who.profile, pluginDiscoverPath(type, page * DISCOVER_PAGE_SIZE, DISCOVER_PAGE_SIZE))
          const rows = Array.isArray(answer?.data) ? answer.data : []
          for (const entry of rows.map(toPluginEntry)) if (entry && isPluginType(entry.pluginType || type)) entries.push({ ...entry, pluginType: entry.pluginType || type })
          const count = typeof answer?.count === 'number' ? answer.count : 0
          if (rows.length < DISCOVER_PAGE_SIZE || (page + 1) * DISCOVER_PAGE_SIZE >= count) break
        }
      }
      return { ok: true, entries }
    } catch (err) {
      return readRefusal(err)
    }
  },

  /**
   * Pin the current snapshot of the plugin `entryUuid` into a kit agent:
   * checks (kit agent, may change it, a ready snapshot, not pinned yet, the
   * servers' runtimes and the policy), the managed uv for a Python server,
   * the download into the cache, the pin through the manifest guard, then the
   * managed connectors. `next: 'env'` when a connector needs settings filled in.
   */
  async addToAgent(userId: string, agentId: string, entryUuid: string): Promise<PluginActionResult> {
    return serialized(agentId, () => guarded('add', async () => {
      const who = account()
      if ('ok' in who) return who
      const kit = locate(userId, agentId)
      if ('ok' in kit) return kit
      if (entryUuid.trim() === '') return refused('not_found', PLUGIN_STATUS_TEXT.notVisible)
      const entry = (await lookupEntries(who.profile, [entryUuid])).get(entryUuid.trim().toLowerCase())
      if (!entry) return refused('not_found', PLUGIN_STATUS_TEXT.notVisible)
      const notPinnable = entryRefusal(entry)
      if (notPinnable) return notPinnable
      const pin = pinOf(entry)
      const access = await changeability(kit.dir, activeListing(who.profile))
      if (access !== 'ok') return refused(access)
      const taken = collision(pinsOf(readManifest(manifestPath(kit.dir))), pin)
      if (taken) return alreadyAdded(taken, pin)

      const target = marketplacePluginRefOf(pin)
      const fetched = phrased(await fetchSnapshot(who.profile, who.host, target))
      if (!fetched.ok) return fetched
      // What the snapshot really runs decides, before anything is pinned or attached.
      const ready = await readyToPin(userId, target)
      if (!ready.ok) return ready
      const written = writePins(kit.dir, (_fresh, pins) => {
        const clash = collision(pins, pin)
        return clash ? alreadyAdded(clash, pin) : [...pins, pin]
      })
      if (!written.ok) return written
      settle(kit.rootId, agentId)
      logger.info('marketplace plugin added', { agentId, name: pin.name })
      const outcomes = await syncServers(userId, agentId, kit.dir)
      // Its connectors start now, not at the first turn: a cold `npx -y` download outlasts a turn's wait.
      const starting = agentMcpService.connectAfterAdd(userId, agentId, readyToStart(outcomes, pin.entry_uuid))
      return {
        ok: true as const,
        name: pin.name,
        archiveSha256: pin.archive_sha256,
        next: nextOf(outcomes, pin.entry_uuid),
        ...(starting.length > 0 ? { starting } : {})
      }
    }))
  },

  /** Move the pin `name` to its entry's current snapshot (only where the person may change the agent). */
  async update(userId: string, agentId: string, name: string): Promise<PluginActionResult> {
    return serialized(agentId, () => guarded('update', async () => {
      const who = account()
      if ('ok' in who) return who
      const kit = locate(userId, agentId)
      if ('ok' in kit) return kit
      const current = pinsOf(readManifest(manifestPath(kit.dir))).find((pin) => pin?.name === name)
      if (!current || typeof current.entry_uuid !== 'string') return refused('not_found')
      const entry = (await lookupEntries(who.profile, [current.entry_uuid])).get(current.entry_uuid.trim().toLowerCase())
      if (!entry) return refused('not_found', PLUGIN_STATUS_TEXT.notVisible)
      const notPinnable = entryRefusal(entry)
      if (notPinnable) return notPinnable
      const access = await changeability(kit.dir, activeListing(who.profile))
      if (access !== 'ok') return refused(access)
      const latest = entry.archiveSha256 ?? ''
      // The pin keeps its name: it is what the wrapper and the commands are called.
      const target: MarketplacePluginRef = { entryUuid: entry.entryUuid, name, archiveSha256: latest }
      if (typeof current.archive_sha256 === 'string' && current.archive_sha256.toLowerCase() === latest) {
        // Already current — unless the cached copy was changed on disk: then it is downloaded again.
        const state = marketplacePluginCache.resolve(target)
        if (state.state !== 'ready' || verifyPluginTree(state.dir)) return { ok: true as const, name, archiveSha256: latest, next: null }
        logger.warn('a cached marketplace plugin was changed on disk; downloading it again', { agentId, name })
        marketplacePluginCache.discard(target)
        // Its working copy was made from the changed tree: copied again from the restored one at the next launch.
        discardPluginWork(pluginManagedBy(target.entryUuid, latest))
        const restored = phrased(await fetchSnapshot(who.profile, who.host, target))
        if (!restored.ok) return restored
        settle(kit.rootId, agentId)
        const outcomes = await syncServers(userId, agentId, kit.dir)
        return { ok: true as const, name, archiveSha256: latest, next: nextOf(outcomes, current.entry_uuid) }
      }
      const fetched = phrased(await fetchSnapshot(who.profile, who.host, target))
      if (!fetched.ok) return fetched
      const ready = await readyToPin(userId, target)
      if (!ready.ok) return ready
      const written = writePins(kit.dir, (_fresh, pins) => {
        const index = pins.findIndex((pin) => pin?.name === name)
        if (index === -1) return refused('not_found')
        const moved: MarketplacePluginPin = { ...pins[index], archive_sha256: latest, commit_hash: entry.commitHash, version: entry.version }
        return pins.map((pin, at) => (at === index ? moved : pin))
      })
      if (!written.ok) return written
      settle(kit.rootId, agentId)
      logger.info('marketplace plugin updated', { agentId, name })
      const outcomes = await syncServers(userId, agentId, kit.dir)
      await releaseUnreferenced(userId)
      pruneWorkCopies()
      return { ok: true as const, name, archiveSha256: latest, next: nextOf(outcomes, current.entry_uuid) }
    }))
  },

  /**
   * Drop the pin `name` and its managed connectors from the agent (a
   * connector another agent's pin still uses stays for that agent). The
   * cached snapshot stays until the next app start's {@link collectGarbage}.
   */
  async remove(userId: string, agentId: string, name: string): Promise<PluginActionResult> {
    return serialized(agentId, () => guarded('remove', async () => {
      const kit = locate(userId, agentId)
      if ('ok' in kit) return kit
      const access = await changeability(kit.dir, activeListing(getProfileScopeUserId()))
      if (access !== 'ok') return refused(access)
      let dropped: MarketplacePluginPin | null = null
      const written = writePins(kit.dir, (_fresh, pins) => {
        const index = pins.findIndex((pin) => pin?.name === name)
        if (index === -1) return refused('not_found')
        dropped = pins[index]
        return pins.filter((_, at) => at !== index)
      })
      if (!written.ok) return written
      settle(kit.rootId, agentId)
      const pin = dropped as MarketplacePluginPin | null
      // The sync releases what no remaining pin wants (and deletes a row no pin anywhere references);
      // a row switched off earlier is detached already, so the sync never sees it: collected here.
      await syncServers(userId, agentId, kit.dir)
      await releaseUnreferenced(userId)
      pruneWorkCopies()
      logger.info('marketplace plugin removed', { agentId, name })
      return { ok: true as const, name, archiveSha256: typeof pin?.archive_sha256 === 'string' ? pin.archive_sha256 : '', next: null }
    }))
  },

  /**
   * Turn parts of the pinned plugin `name` off or back on: each key given
   * replaces the pin's own (`disabled.hooks`, `disabled.mcp_servers`,
   * `disabled.skills`); an empty `disabled` is dropped from the pin. The
   * managed connectors follow at once; skills, commands and hooks on the
   * agent's next session.
   */
  async setDisabled(userId: string, agentId: string, name: string, disabled: PluginDisabledInput): Promise<PluginActionResult> {
    return serialized(agentId, () => guarded('set-disabled', async () => {
      const kit = locate(userId, agentId)
      if ('ok' in kit) return kit
      const access = await changeability(kit.dir, activeListing(getProfileScopeUserId()))
      if (access !== 'ok') return refused(access)
      let sha = ''
      let entryUuid = ''
      const names = (value: unknown): string[] | undefined =>
        Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string' && v.trim() !== ''))].sort() : undefined
      const written = writePins(kit.dir, (_fresh, pins) => {
        const index = pins.findIndex((pin) => pin?.name === name)
        if (index === -1) return refused('not_found')
        const pin = pins[index]
        sha = typeof pin.archive_sha256 === 'string' ? pin.archive_sha256 : ''
        entryUuid = typeof pin.entry_uuid === 'string' ? pin.entry_uuid : ''
        const before = rec(pin.disabled) ?? {}
        const next: Record<string, unknown> = { ...before }
        if (typeof disabled.hooks === 'boolean') next.hooks = disabled.hooks
        const servers = names(disabled.mcpServers)
        if (servers) next.mcp_servers = servers
        const skills = names(disabled.skills)
        if (skills) next.skills = skills
        if (next.hooks === false) delete next.hooks
        if (Array.isArray(next.mcp_servers) && next.mcp_servers.length === 0) delete next.mcp_servers
        if (Array.isArray(next.skills) && next.skills.length === 0) delete next.skills
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { disabled: _old, ...rest } = pin
        const moved: MarketplacePluginPin = Object.keys(next).length > 0 ? { ...rest, disabled: next } : (rest as MarketplacePluginPin)
        return pins.map((p, at) => (at === index ? moved : p))
      })
      if (!written.ok) return written
      settle(kit.rootId, agentId)
      const outcomes = await syncServers(userId, agentId, kit.dir)
      return { ok: true as const, name, archiveSha256: sha, next: nextOf(outcomes, entryUuid) }
    }))
  },

  /**
   * Bring every snapshot the agent pins onto this computer, then reconcile
   * its managed connectors (and the managed uv for a Python server). Called
   * when a session is built for the agent, after it arrives by sharing, and
   * for a "Try again". **Never throws.**
   */
  async ensurePinned(userId: string, agentId: string): Promise<{ ok: true; fetched: string[]; failed: Array<{ name: string; code: PluginRefusal; message: string }> } | PluginRefused> {
    return serialized(agentId, () => ensurePinnedNow(userId, agentId))
  },

  /**
   * Whether a plugin's (managed) connector may be started at app start with
   * nobody asking: attached to some agent, every value it needs given, not
   * forbidden by the policy, its cached files unchanged, and its Node or
   * Docker on this computer. Agents connect the rest on use, or never.
   */
  async startsUnattended(row: McpProviderRow): Promise<boolean> {
    if (!row.managedBy) return true
    if (agentMcpRepo.agentIdsFor(row.id).length === 0) return false
    if (missingManagedEnv(row).length > 0 || managedNeedsBearer(row)) return false
    if (managedLaunchBlock(row) !== null) return false
    if (row.transportType !== 'stdio') return true
    const runtime = runtimeOfCommand(row.command)
    return runtime === 'node' || runtime === 'docker' ? stdioRuntimes.available(runtime) : true
  },

  /** {@link ensurePinned} in the background, never awaited and never failing the caller. */
  ensurePinnedInBackground(userId: string, agentId: string): void {
    void marketplacePluginService.ensurePinned(userId, agentId).catch(() => undefined)
  },

  /**
   * Every pinned plugin of the agent as its row shows it: against its
   * marketplace (one batch lookup — `unavailable` reads "No longer available
   * to you"; a failed lookup is `unknown`, never an error), on this computer,
   * against the agent's engine, and part by part (skills delivered or why
   * not, hooks, each managed connector and the step it needs).
   */
  async status(userId: string, agentId: string): Promise<PluginStatusResult> {
    try {
      const kit = locate(userId, agentId)
      if ('ok' in kit) return kit
      const manifest = readManifest(manifestPath(kit.dir))
      const plugins = cachedPlugins(manifest)
      if (plugins.length === 0) return { ok: true, plugins: [] }
      let found: Map<string, MarketplacePluginEntry> | null = null
      const who = account()
      if (!('ok' in who)) {
        try {
          found = await lookupEntries(who.profile, plugins.map((plugin) => plugin.pin.entry_uuid))
        } catch (err) {
          logger.info('plugin status: the marketplaces could not be asked', { error: err instanceof Error ? err.message : String(err) })
        }
      }
      const engine = await agentEngine(manifest)
      const policy = addonPolicies.get(userId)
      const own = agentSkillRows(kit.dir, manifest, catalogSkillCache.resolve, marketplaceSkillCache.resolve)
      const { rows, skipped } = pluginSkillRows(plugins, new Set(own.map((row) => row.name)))
      const known = await knownRuntimes(plugins.flatMap((plugin) => plugin.tree?.mcpServers ?? []))
      const block = serverBlock(policy, known)
      const attached = new Set(agentMcpRepo.listProviderIds(userId, agentId))
      const providerRows = mcpProviderRepo.list(userId)
      return {
        ok: true,
        plugins: plugins.map((plugin): PluginPinStatus => {
          const pin = plugin.pin
          const off = disabledOf(pin)
          const entry = found ? (found.get(pin.entry_uuid.trim().toLowerCase()) ?? null) : undefined
          const pinnedSha = pin.archive_sha256.toLowerCase()
          const availability: PluginPinStatus['availability'] =
            entry === undefined ? 'unknown' : entry === null ? 'unavailable' : entry.archiveSha256 && entry.archiveSha256 !== pinnedSha ? 'update_available' : 'current'
          const tree = plugin.tree
          const components: AddonComponents = {
            skills: (tree?.skills ?? []).map((skill) => ({ name: skill, hasScripts: false })),
            commands: (tree?.commands ?? []).map((command) => command.name),
            agents: tree?.hasAgents ? (tree.agents.length > 0 ? tree.agents : ['agents']) : [],
            hooks: tree?.hasHooks ? { events: tree.hookEvents.length > 0 ? tree.hookEvents : ['hooks'] } : null,
            mcpServers: (tree?.mcpServers ?? []).map((spec) => ({ name: spec.name, transport: spec.transport, runtime: null, auth: 'none', env: [] })),
            lspServers: []
          }
          const managedBy = pluginManagedBy(pin.entry_uuid, pin.archive_sha256)
          const servers = (tree?.mcpServers ?? []).map((spec): PluginServerStatus => {
            const disabled = off.mcpServers.includes(spec.name)
            const row = providerRows.find((candidate) => candidate.managedBy === managedBy && candidate.name === spec.name && attached.has(candidate.id))
            const blocked = disabled ? null : block(spec)
            const missing = row ? missingManagedEnv(row) : []
            const setup = row && !row.enabled ? 'enable' : missing.length > 0 ? 'env' : row && managedNeedsBearer(row) ? 'bearer' : undefined
            return {
              name: spec.name,
              transport: spec.transport,
              disabled,
              ...(row ? { mcpProviderId: row.id } : {}),
              ...(blocked ? { blocked } : {}),
              ...(setup ? { setup } : {}),
              ...(missing.length > 0 ? { missingEnv: missing } : {})
            }
          })
          const hooksOn = !!tree?.hasHooks && !off.hooks
          const hooksReason = !hooksOn ? undefined : !policy.pluginHooks ? PLUGIN_STATUS_TEXT.hooksPolicy : !engineSupports(engine, 'hooks') ? PLUGIN_STATUS_TEXT.hooksEngine(engine) : undefined
          const resolved = marketplacePluginCache.resolve(marketplacePluginRefOf(pin))
          // A copy changed on disk is not delivered: it reads failed, and Update downloads it again.
          const state = plugin.modified ? { state: 'failed' as const, message: PLUGIN_TREE_MODIFIED_SENTENCE } : resolved
          return {
            name: pin.name,
            title: entry?.title ?? pin.name,
            entryUuid: pin.entry_uuid,
            marketplaceName: typeof pin.marketplace_name === 'string' ? pin.marketplace_name : '',
            version: typeof pin.version === 'string' ? pin.version : null,
            archiveSha256: pinnedSha,
            availability,
            ...(availability === 'update_available' && entry ? { latestSha256: entry.archiveSha256 ?? undefined, latestVersion: entry.version } : {}),
            availabilityText: availability === 'unavailable' ? PLUGIN_STATUS_TEXT.unavailable : availability === 'update_available' ? PLUGIN_STATUS_TEXT.update : null,
            cache: state.state,
            ...(state.state === 'failed' ? { cacheMessage: state.message } : {}),
            engine,
            compatibility: compatibilityOf(components, { hooks: off.hooks, mcpServers: off.mcpServers, skills: off.skills }, engine),
            skills: (tree?.skills ?? []).map((skill) => {
              const disabled = off.skills.includes(skill)
              const delivered = rows.some((row) => row.pluginName === pin.name && row.name === skill && row.deliverable)
              const skip = skipped.find((item) => item.plugin === pin.name && item.skill === skill)
              const unsupported = !engineSupports(engine, 'skills')
              return {
                name: skill,
                disabled,
                delivered: !disabled && delivered && !unsupported,
                ...(skip && !disabled ? { reason: skip.reason } : {})
              }
            }),
            commands: (tree?.commands ?? []).map((command) => command.name),
            hasAgents: !!tree?.hasAgents,
            agents: tree?.agents ?? [],
            hasHooks: !!tree?.hasHooks,
            hookEvents: tree?.hookEvents ?? [],
            hooksDisabled: off.hooks,
            hooksDelivered: hooksOn && !hooksReason,
            ...(hooksReason ? { hooksReason } : {}),
            hooksBlockedByPolicy: hooksOn && !policy.pluginHooks,
            mcpServers: servers
          }
        })
      }
    } catch (err) {
      logger.warn('marketplace plugin status could not be read', { agentId, error: err instanceof Error ? err.message : String(err) })
      return refused('write_failed', 'The pinned plugins could not be checked.')
    }
  },

  /**
   * Show the pinned plugin `name`'s cached folder in the file manager,
   * through the host. Refused as data when the agent has no such pin or the
   * snapshot is not (validly) on this computer.
   */
  reveal(userId: string, agentId: string, name: string): PluginRevealResult {
    try {
      const kit = locate(userId, agentId)
      if ('ok' in kit) return kit
      const pin = pluginPinsOf(readManifest(manifestPath(kit.dir))).find((candidate) => candidate.name === name)
      if (!pin) return refused('not_found')
      const state = marketplacePluginCache.resolve(marketplacePluginRefOf(pin))
      if (state.state !== 'ready') return refused('not_found', PLUGIN_STATUS_TEXT.notCached)
      runtimeHost.shell.showItemInFolder(state.dir)
      return { ok: true }
    } catch (err) {
      logger.warn('a pinned plugin could not be revealed', { agentId, error: err instanceof Error ? err.message : String(err) })
      return refused('write_failed', 'The plugin’s folder could not be shown.')
    }
  },

  /**
   * Remove every cached snapshot no registered kit agent pins. Skipped when
   * any agent's pins cannot be read. Run once per app start, beside the
   * skills caches'. **Never throws.**
   */
  collectGarbage(): { ok: true; removed: number } | { ok: false; reason: string } {
    try {
      const managed = mcpProviderRepo.listAllManaged()
      if (marketplacePluginCache.isEmpty() && managed.length === 0) {
        // No snapshot is cached and no connector runs one: no working copy is of any use.
        collectPluginWork(new Set())
        return { ok: true, removed: 0 }
      }
      const pinned = pinnedKeys((manifest) => pinsOf(manifest).map(pluginSnapshotKeyOf))
      if (!pinned.ok) return pinned
      // A managed connector no pin references and no agent uses goes first; one still standing keeps its folder.
      const keep = new Set(pinned.keep)
      const scope = getSettingsScopeUserId()
      for (const row of managed) {
        const key = snapshotKeyOfManagedBy(row.managedBy)
        if (key !== null && pinned.keep.has(key)) continue
        // The pins read are this settings scope's agents': another scope's connector is not judged by them.
        if (row.userId !== scope) {
          if (key !== null) keep.add(key)
          continue
        }
        if (agentMcpRepo.agentIdsFor(row.id).length === 0) {
          void mcpManager.disconnect(row.id).catch(() => undefined)
          mcpProviderRepo.delete(row.userId, row.id)
          logger.info('unreferenced plugin connector removed', { providerId: row.id })
          continue
        }
        if (key !== null) keep.add(key)
      }
      // A working copy goes with its snapshot: kept exactly where the cached folder is.
      const work = collectPluginWork(keep)
      if (work > 0) logger.info('unreferenced plugin working copies removed', { removed: work })
      return { ok: true, ...marketplacePluginCache.collectGarbage(keep) }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  },

  /** Tests: forget downloads in flight and the agents' chains. */
  _reset(): void {
    inFlight.clear()
    agentChains.clear()
  }
}
