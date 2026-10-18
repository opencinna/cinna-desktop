/**
 * Marketplace skills in local agents: find the skills the skills-format
 * marketplaces connected to cinna-core offer, pin one into a kit agent's
 * `marketplace_skills[]` (contract 1.15.0), move a pin to the entry's current
 * snapshot, drop one, and bring every pinned snapshot onto this computer.
 *
 * The second kind of pinned skill beside the catalog's (`catalogSkillService.ts`),
 * and built the same way: a pin is a reference, never a copy into `skills/`;
 * the archive is downloaded once into the shared read-only cache
 * (`marketplaceSkillCache.ts`) and every engine is given the cached folder
 * (`agentSkillsPlugin.ts`, `promptAssembly.ts`). The bytes are checked against
 * the server's `X-Archive-Sha256` **and** the pin's `archive_sha256` before
 * anything is written, then unpacked by `kit/skillArchive.ts`' safe reader.
 *
 * * **Content-addressed (M4, M8).** A pin names the entry and the snapshot's
 *   digest. "Update available" is the entry's current digest differing from
 *   the pin's; the desktop never syncs a marketplace, it only reads.
 * * **Visibility (M6, M7).** The person may download a snapshot exactly when
 *   `/discover` shows them its entry. A pin whose entry they cannot see any
 *   more is `unavailable` in {@link marketplaceSkillService.status}: no error,
 *   and the cached copy keeps being delivered.
 * * **Who may change pins** is the catalog's rule (`changeability`): not a bare
 *   folder, and not a shared agent the person may only use.
 *
 * Every answer is data ({@link MarketplaceSkillOutcome}); nothing a caller can
 * cause is thrown, because a thrown code does not survive IPC.
 *
 * Core service: no Electron, no window. The token only ever goes to the active
 * profile's own API.
 */

import { createHash } from 'node:crypto'
import { getProfileScopeUserId } from '../auth/scope'
import { CinnaApiError, KitError } from '../errors'
import { CinnaSessionChanged } from '../auth/cinna-session'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { createLogger } from '../logger/logger'
import { cinnaFetch, cinnaFetchBytes } from './cinna-http'
import { libraryService } from './libraryService'
import { instanceKey } from './pinnedSkillCache'
import { marketplaceCacheRefOf, marketplaceSkillCache, snapshotKeyOf } from './marketplaceSkillCache'
import { activeListing } from './catalogSkillUpdates'
import { changeability, detachUnusedCredentials, locateKit, pinnedKeys, settle, skillCredentials, skillCredentialsInBackground, type KitTarget } from './catalogSkillService'
import { manifestPath, readManifest, readWithStamp, writeIfUnchanged } from '../kit/manifestIo'
import { MAX_ARCHIVE_BYTES, readSkillArchive, SkillArchiveError } from '../kit/skillArchive'
import {
  catalogPinNames,
  isCatalogPinName,
  marketplacePinClashes,
  marketplaceSkillRefOf,
  PLATFORM_SKILL_NAMES,
  scanAgentSkills,
  type MarketplaceSkillRef
} from '../kit/skills'
import type { CinnaAgentManifest, MarketplaceSkillPin } from '../../shared/kit/manifest'
import type {
  MarketplaceSkillDiscoverResult,
  MarketplaceSkillEnsureFailure,
  MarketplaceSkillEnsureResult,
  MarketplaceSkillEntry,
  MarketplaceSkillOutcome,
  MarketplaceSkillPinStatus,
  MarketplaceSkillRefusal,
  MarketplaceSkillRefused,
  MarketplaceSkillStatusResult
} from '../../shared/marketplaceSkills'

const logger = createLogger('marketplace-skills')

/** Most entries one `/discover` page is asked for; core sets no upper bound of its own. */
export const DISCOVER_PAGE_SIZE = 100
/** Pages read before the list is cut: 1000 skills is past anything a picker can show. */
const DISCOVER_MAX_PAGES = 10
/** Core's cap on one batch lookup. */
export const BATCH_MAX_IDS = 100

/** One page of the skills-format entries visible to the caller. */
export function discoverPath(skip: number, limit: number): string {
  return `/api/v1/llm-plugins/discover?plugin_type=skills&skip=${skip}&limit=${limit}`
}

/** The entries of `ids` the caller can see; the rest are simply absent. */
export function batchPath(ids: readonly string[]): string {
  return `/api/v1/llm-plugins/plugins?ids=${ids.map(encodeURIComponent).join(',')}`
}

/** One entry's snapshot archive, by digest. */
export function snapshotDownloadPath(entryUuid: string, sha256: string): string {
  return `/api/v1/llm-plugins/plugins/${encodeURIComponent(entryUuid)}/skill-archive?sha256=${encodeURIComponent(sha256)}`
}

export const MARKETPLACE_SKILL_SENTENCES: Record<MarketplaceSkillRefusal, string> = {
  no_account: 'Marketplace skills need a Cinna account.',
  not_found: 'That agent or skill is no longer here.',
  not_kit_agent: 'Only an agent with a cinna-agent.json can hold marketplace skills.',
  read_only: 'This agent is shared with you to use. Its skills change when the team shares a new version.',
  access_unknown: 'This shared agent is not in your catalog listing, so its skills cannot be changed here.',
  clash: 'This agent already has a skill with that name.',
  already_added: 'This agent already has this skill.',
  unsupported: 'This skill cannot be added: its marketplace has no copy of it to download.',
  snapshot_missing: 'The server no longer keeps this version of the skill.',
  download_failed: 'The skill could not be downloaded.',
  hash_mismatch: 'The download did not match the marketplace’s copy, so nothing was kept.',
  invalid_archive: 'The skill’s files could not be unpacked safely.',
  too_large: 'The skill is larger than 16 MB.',
  manifest_modified: 'cinna-agent.json changed while the skill was downloading. Try again.',
  write_failed: 'The skill could not be saved on this computer.',
  reauth_required: 'Sign in to Cinna again to use marketplace skills.',
  network: 'The marketplaces could not be reached. Try again.'
}

/** An entry the batch lookup did not return on Add or Update. */
const NOT_VISIBLE_SENTENCE = 'This skill is no longer in a marketplace you can see.'

function refused(code: MarketplaceSkillRefusal, message?: string): MarketplaceSkillRefused {
  return { ok: false, code, message: message ?? MARKETPLACE_SKILL_SENTENCES[code] }
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

/* ---------------------------------------------------------------- entries */

/**
 * An entry as core sends it (`LLMPluginMarketplacePluginPublic`), read
 * defensively; null for one with no id. The name is the skill's folder
 * (`skill_summary.name`, else the entry's own).
 */
export function toEntry(raw: unknown): MarketplaceSkillEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const entryUuid = textOrNull(row.id)
  if (!entryUuid) return null
  const summary = row.skill_summary && typeof row.skill_summary === 'object' ? (row.skill_summary as Record<string, unknown>) : null
  const name = textOrNull(summary?.name) ?? textOrNull(row.name) ?? ''
  const digest = textOrNull(row.skill_archive_sha256)
  const size = row.skill_archive_size
  return {
    entryUuid,
    name,
    description: textOrNull(summary?.description) ?? textOrNull(row.description) ?? '',
    marketplaceUuid: textOrNull(row.marketplace_id) ?? '',
    marketplaceName: textOrNull(row.marketplace_name) ?? '',
    marketplaceOwner: textOrNull(row.marketplace_owner),
    repositoryUrl: textOrNull(row.repository_url),
    supported: row.supported !== false,
    unsupportedReason: textOrNull(row.unsupported_reason),
    archiveSha256: digest && /^[0-9a-fA-F]{64}$/.test(digest) ? digest.toLowerCase() : null,
    archiveSize: typeof size === 'number' && Number.isFinite(size) ? size : null,
    hasScripts: summary?.has_scripts === true,
    commitHash: textOrNull(row.commit_hash),
    version: textOrNull(row.version)
  }
}

interface EntryPage {
  data?: unknown
  count?: unknown
}

function entriesOf(page: EntryPage): MarketplaceSkillEntry[] {
  return Array.isArray(page?.data) ? page.data.map(toEntry).filter((entry): entry is MarketplaceSkillEntry => entry !== null) : []
}

/** The visible entries among `ids`, by lowercase id, through as many batch lookups as it takes. */
async function lookupEntries(profile: string, ids: readonly string[]): Promise<Map<string, MarketplaceSkillEntry>> {
  const unique = [...new Set(ids.map((id) => id.trim().toLowerCase()).filter((id) => id !== ''))]
  const found = new Map<string, MarketplaceSkillEntry>()
  for (let at = 0; at < unique.length; at += BATCH_MAX_IDS) {
    const page = await cinnaFetch<EntryPage>(profile, batchPath(unique.slice(at, at + BATCH_MAX_IDS)))
    for (const entry of entriesOf(page)) found.set(entry.entryUuid.toLowerCase(), entry)
  }
  return found
}

/** Why a read of the marketplace list failed, as data. */
function readRefusal(err: unknown): MarketplaceSkillRefused {
  if (err instanceof CinnaReauthRequired) return refused('reauth_required')
  if (err instanceof CinnaApiError) {
    if (err.code === 'reauth_required') return refused('reauth_required')
    if (err.code === 'not_cinna_user' || err.code === 'missing_server_url') return refused('no_account')
  }
  logger.warn('marketplace skills could not be read', { error: err instanceof Error ? err.message : String(err) })
  return refused('network')
}

/* ------------------------------------------------------------- downloads */

/** A pin as the cache and the download see it, with what the manifest keeps beside. */
interface PinTarget extends MarketplaceSkillRef {
  archiveSha256: string
}

/** A download the server answered 404 `not_found`: the entry is gone or not visible (M6). */
interface NotAvailable {
  ok: false
  notAvailable: true
}

type FetchOutcome = { ok: true } | MarketplaceSkillRefused | NotAvailable

const inFlight = new Map<string, Promise<FetchOutcome>>()

/** `detail.code` of a coded core refusal (`{detail: {code}}`), carried in the error's detail text. */
function detailCode(err: CinnaApiError): string | null {
  try {
    const parsed = JSON.parse(err.detail ?? '') as { detail?: { code?: unknown } }
    return typeof parsed?.detail?.code === 'string' ? parsed.detail.code : null
  } catch {
    return null
  }
}

/** Why a download failed, as a refusal; a 404 `not_found` is {@link NotAvailable}. */
function downloadRefusal(err: unknown): MarketplaceSkillRefused | NotAvailable {
  if (err instanceof CinnaReauthRequired) return refused('reauth_required')
  if (err instanceof CinnaApiError) {
    if (err.code === 'reauth_required' && err.status === 403) {
      return refused('download_failed', 'The server did not allow this download.')
    }
    if (err.code === 'reauth_required') return refused('reauth_required')
    const code = detailCode(err)
    if (err.status === 404 && code === 'snapshot_missing') return refused('snapshot_missing')
    if (err.status === 404) return { ok: false, notAvailable: true }
    if (err.status === 409) return refused('unsupported')
    if (err.code === 'not_cinna_user' || err.code === 'missing_server_url') return refused('no_account')
    return refused('download_failed', `The skill could not be downloaded: ${err.message}`.slice(0, 300))
  }
  if (err instanceof CinnaSessionChanged) return refused('download_failed', 'The Cinna account changed during the download.')
  if (err instanceof SkillArchiveError) return refused('invalid_archive', err.message)
  return refused('download_failed', `The skill could not be downloaded: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300))
}

/**
 * Fetch one pinned snapshot into the active instance's cache. The bytes must
 * equal both the server's `X-Archive-Sha256` and the pin's `archive_sha256`
 * before they are unpacked; any failure leaves the cache as it was and is
 * remembered for the Skills section. One download per snapshot at a time.
 */
function fetchSnapshot(profile: string, host: string, target: PinTarget): Promise<FetchOutcome> {
  const instance = instanceKey(host)
  // Nothing reaches the request path that is not a UUID and a digest.
  const safe = marketplaceCacheRefOf(target)
  if (safe === null) return Promise.resolve(refused('download_failed', 'This pin does not name a marketplace skill that can be downloaded.'))
  const key = `${instance}/${safe.uuid}/${safe.sha}/${safe.name}`
  const running = inFlight.get(key)
  if (running) return running
  const run = (async (): Promise<FetchOutcome> => {
    if (marketplaceSkillCache.has(instance, target)) return { ok: true }
    let outcome: FetchOutcome
    try {
      const answer = await cinnaFetchBytes(profile, snapshotDownloadPath(safe.uuid, safe.sha), { maxBytes: MAX_ARCHIVE_BYTES })
      if (!answer.ok) {
        outcome = refused('too_large')
      } else {
        const digest = sha256(answer.bytes)
        const declared = (answer.headers.get('x-archive-sha256') ?? '').trim().toLowerCase()
        if (declared === '' || digest !== declared || digest !== safe.sha) {
          logger.warn('marketplace skill digest mismatch', { name: target.name })
          outcome = refused('hash_mismatch')
        } else {
          const archive = readSkillArchive(answer.bytes, safe.name)
          try {
            marketplaceSkillCache.install(instance, target, archive)
            outcome = { ok: true }
          } catch (err) {
            logger.warn('marketplace skill could not be cached', { name: target.name, error: String(err) })
            outcome = refused('write_failed')
          }
        }
      }
    } catch (err) {
      outcome = downloadRefusal(err)
    }
    if (outcome.ok) marketplaceSkillCache.clearFailure(target)
    else if ('notAvailable' in outcome) marketplaceSkillCache.recordNotAvailable(target)
    else marketplaceSkillCache.recordFailure(target, outcome.message)
    return outcome
  })().finally(() => inFlight.delete(key))
  inFlight.set(key, run)
  return run
}

/** A download's outcome for a verb: the 404 becomes `not_found` in the marketplace's words. */
function phrased(outcome: FetchOutcome): { ok: true } | MarketplaceSkillRefused {
  if (outcome.ok) return outcome
  if ('notAvailable' in outcome) return refused('not_found', NOT_VISIBLE_SENTENCE)
  return outcome
}

/* ---------------------------------------------------------------- agents */

function pinsOf(manifest: CinnaAgentManifest): MarketplaceSkillPin[] {
  return Array.isArray(manifest.marketplace_skills) ? manifest.marketplace_skills : []
}

/** Whether a pin (as written, so possibly malformed) names the entry `uuid`. */
function pinsEntry(pin: unknown, uuid: string): boolean {
  const value = pin && typeof pin === 'object' ? (pin as Record<string, unknown>).entry_uuid : null
  return typeof value === 'string' && value.trim().toLowerCase() === uuid.trim().toLowerCase()
}

function targetOf(pin: Record<string, unknown>): PinTarget | null {
  const ref = marketplaceSkillRefOf(pin)
  return marketplaceCacheRefOf(ref) === null ? null : ref
}

/** The kit agent behind an id, or a refusal in this kind's words. */
function locate(userId: string, agentId: string): KitTarget | MarketplaceSkillRefused {
  const kit = locateKit(userId, agentId)
  return 'ok' in kit ? refused(kit.code === 'not_kit_agent' ? 'not_kit_agent' : 'not_found') : kit
}

/** Whether `name` cannot be pinned beside what the agent already has. `except` is the pin being replaced. */
function clashOf(dir: string, manifest: CinnaAgentManifest, pins: MarketplaceSkillPin[], name: string, except: number | null): boolean {
  if (PLATFORM_SKILL_NAMES.has(name)) return true
  if (catalogPinNames(manifest.catalog_skills).has(name)) return true
  if (scanAgentSkills(dir).some((skill) => skill.name === name)) return true
  return pins.some((pin, index) => index !== except && pin && typeof pin === 'object' && pin.name === name)
}

/**
 * Re-read the manifest and write `change(manifest, pins)` through the
 * modified-underneath guard. `change` answers the new list, or a refusal
 * decided on the fresh read.
 */
function writePins(
  dir: string,
  change: (manifest: CinnaAgentManifest, pins: MarketplaceSkillPin[]) => MarketplaceSkillPin[] | MarketplaceSkillRefused
): { ok: true } | MarketplaceSkillRefused {
  const path = manifestPath(dir)
  try {
    const { manifest, stamp } = readWithStamp(path)
    const next = change(manifest, pinsOf(manifest))
    if (!Array.isArray(next)) return next
    writeIfUnchanged(path, { ...manifest, marketplace_skills: next }, stamp)
    return { ok: true }
  } catch (err) {
    if (err instanceof KitError && err.code === 'manifest_modified') return refused('manifest_modified')
    if (err instanceof KitError) return refused('write_failed', err.message)
    throw err
  }
}

/** The profile and its server, or a refusal. */
function account(): { profile: string; host: string } | MarketplaceSkillRefused {
  const profile = getProfileScopeUserId()
  const host = libraryService.hostOf(profile)
  return host === null ? refused('no_account') : { profile, host }
}

/** The pin an entry's current snapshot makes, or null when it has none to pin. */
function pinOf(entry: MarketplaceSkillEntry): MarketplaceSkillPin | null {
  if (!entry.supported || entry.archiveSha256 === null || !isCatalogPinName(entry.name)) return null
  return {
    entry_uuid: entry.entryUuid.toLowerCase(),
    marketplace_uuid: entry.marketplaceUuid,
    marketplace_name: entry.marketplaceName,
    name: entry.name,
    archive_sha256: entry.archiveSha256,
    commit_hash: entry.commitHash,
    version: entry.version
  }
}

/** Run a verb, turning a lost session into a refusal and logging anything unexpected. */
async function guarded<T extends { ok: boolean }>(verb: string, run: () => Promise<T | MarketplaceSkillRefused>): Promise<T | MarketplaceSkillRefused> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof CinnaReauthRequired || (err instanceof CinnaApiError && err.code === 'reauth_required')) {
      return refused('reauth_required')
    }
    if (err instanceof CinnaApiError) {
      if (err.code === 'not_cinna_user' || err.code === 'missing_server_url') return refused('no_account')
      logger.warn(`marketplace skill ${verb}: the server could not be read`, { error: err.message })
      return refused('network')
    }
    logger.error(`marketplace skill ${verb} failed`, { error: err instanceof Error ? err.message : String(err) })
    return refused('write_failed', `Something went wrong: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300))
  }
}

export const marketplaceSkillService = {
  /**
   * Every skill entry of the skills-format marketplaces this person can see
   * (`/discover`, M6), supported ones first as core orders them. Read whole,
   * page by page, so the picker filters locally and never asks per keystroke.
   */
  async discover(): Promise<MarketplaceSkillDiscoverResult> {
    const who = account()
    if ('ok' in who) return who
    try {
      const entries: MarketplaceSkillEntry[] = []
      for (let page = 0; page < DISCOVER_MAX_PAGES; page++) {
        const answer = await cinnaFetch<EntryPage>(who.profile, discoverPath(page * DISCOVER_PAGE_SIZE, DISCOVER_PAGE_SIZE))
        const rows = Array.isArray(answer?.data) ? answer.data : []
        entries.push(...entriesOf(answer))
        const count = typeof answer?.count === 'number' ? answer.count : 0
        if (rows.length < DISCOVER_PAGE_SIZE || (page + 1) * DISCOVER_PAGE_SIZE >= count) break
      }
      return { ok: true, entries }
    } catch (err) {
      return readRefusal(err)
    }
  },

  /**
   * Pin the current snapshot of the entry `entryUuid` into a kit agent:
   * checks (kit agent, may change it, a snapshot to pin, no clash, not pinned
   * yet), download into the cache, then the pin through the manifest guard.
   */
  async addToAgent(userId: string, agentId: string, entryUuid: string): Promise<MarketplaceSkillOutcome> {
    return guarded('add', async () => {
      const who = account()
      if ('ok' in who) return who
      const kit = locate(userId, agentId)
      if ('ok' in kit) return kit
      if (entryUuid.trim() === '') return refused('not_found', NOT_VISIBLE_SENTENCE)
      const entry = (await lookupEntries(who.profile, [entryUuid])).get(entryUuid.trim().toLowerCase())
      if (!entry) return refused('not_found', NOT_VISIBLE_SENTENCE)
      const pin = pinOf(entry)
      if (!pin) return refused('unsupported')
      const access = await changeability(kit.dir, activeListing(who.profile))
      if (access !== 'ok') return refused(access)
      const manifest = readManifest(manifestPath(kit.dir))
      const before = pinsOf(manifest)
      if (before.some((existing) => pinsEntry(existing, pin.entry_uuid))) return refused('already_added')
      if (clashOf(kit.dir, manifest, before, pin.name, null)) return refused('clash')

      const target = targetOf(pin)
      if (!target) return refused('unsupported')
      const fetched = phrased(await fetchSnapshot(who.profile, who.host, target))
      if (!fetched.ok) return fetched
      // Decided again on the fresh read: the download took time.
      const written = writePins(kit.dir, (fresh, pins) => {
        if (pins.some((existing) => pinsEntry(existing, pin.entry_uuid))) return refused('already_added')
        if (clashOf(kit.dir, fresh, pins, pin.name, null)) return refused('clash')
        return [...pins, pin]
      })
      if (!written.ok) return written
      settle(kit.rootId, agentId)
      logger.info('marketplace skill added', { agentId, name: pin.name })
      void skillCredentials(agentId)
      return { ok: true as const, name: pin.name, archiveSha256: pin.archive_sha256 }
    })
  },

  /** Move the pin `name` to its entry's current snapshot, fetching it first (only where the person may change the agent). */
  async update(userId: string, agentId: string, name: string): Promise<MarketplaceSkillOutcome> {
    return guarded('update', async () => {
      const who = account()
      if ('ok' in who) return who
      const kit = locate(userId, agentId)
      if ('ok' in kit) return kit
      const current = pinsOf(readManifest(manifestPath(kit.dir))).find((pin) => pin?.name === name)
      if (!current || typeof current.entry_uuid !== 'string') return refused('not_found')
      const entry = (await lookupEntries(who.profile, [current.entry_uuid])).get(current.entry_uuid.trim().toLowerCase())
      if (!entry) return refused('not_found', NOT_VISIBLE_SENTENCE)
      const latest = pinOf(entry)
      if (!latest) return refused('unsupported')
      const access = await changeability(kit.dir, activeListing(who.profile))
      if (access !== 'ok') return refused(access)
      if (typeof current.archive_sha256 === 'string' && current.archive_sha256.toLowerCase() === latest.archive_sha256) {
        return { ok: true as const, name, archiveSha256: latest.archive_sha256 }
      }
      // The pin keeps its name: the folder name is what the engines call it.
      const target = targetOf({ ...latest, name })
      if (!target) return refused('unsupported')
      const fetched = phrased(await fetchSnapshot(who.profile, who.host, target))
      if (!fetched.ok) return fetched
      const written = writePins(kit.dir, (fresh, pins) => {
        const index = pins.findIndex((pin) => pin?.name === name)
        if (index === -1) return refused('not_found')
        if (clashOf(kit.dir, fresh, pins, name, index)) return refused('clash')
        // Unknown keys of the pin survive, and so does the marketplace name it was installed under.
        const moved: MarketplaceSkillPin = {
          ...pins[index],
          name,
          archive_sha256: latest.archive_sha256,
          commit_hash: latest.commit_hash,
          version: latest.version
        }
        return pins.map((pin, at) => (at === index ? moved : pin))
      })
      if (!written.ok) return written
      settle(kit.rootId, agentId)
      logger.info('marketplace skill updated', { agentId, name })
      // A later snapshot can drop a provider: what was attached for it goes, then the new slots fill.
      void detachUnusedCredentials(agentId).then(() => skillCredentials(agentId))
      return { ok: true as const, name, archiveSha256: latest.archive_sha256 }
    })
  },

  /**
   * Drop the pin `name`, and detach in the background what auto-attach put
   * there for slots no skill declares any more. The cached snapshot stays: a
   * running turn may still read it, and the next app start's
   * {@link collectGarbage} removes it if nothing pins it.
   */
  async remove(userId: string, agentId: string, name: string): Promise<MarketplaceSkillOutcome> {
    return guarded('remove', async () => {
      const kit = locate(userId, agentId)
      if ('ok' in kit) return kit
      const access = await changeability(kit.dir, activeListing(getProfileScopeUserId()))
      if (access !== 'ok') return refused(access)
      let dropped: MarketplaceSkillPin | null = null
      const written = writePins(kit.dir, (_fresh, pins) => {
        const index = pins.findIndex((pin) => pin?.name === name)
        if (index === -1) return refused('not_found')
        dropped = pins[index]
        return pins.filter((_, at) => at !== index)
      })
      if (!written.ok) return written
      settle(kit.rootId, agentId)
      logger.info('marketplace skill removed', { agentId, name })
      void detachUnusedCredentials(agentId)
      const pin = dropped as MarketplaceSkillPin | null
      return { ok: true as const, name, archiveSha256: typeof pin?.archive_sha256 === 'string' ? pin.archive_sha256 : '' }
    })
  },

  /**
   * Bring every snapshot the agent pins onto this computer. Pins already
   * cached, unusable pins and pins whose name clashes are skipped; each
   * failure is recorded for the Skills section and listed. Called after an
   * agent arrives or moves by sharing, and for a "Try again". **Never throws.**
   */
  async ensurePinned(userId: string, agentId: string): Promise<MarketplaceSkillEnsureResult> {
    try {
      const kit = locate(userId, agentId)
      if ('ok' in kit) return kit
      const manifest = readManifest(manifestPath(kit.dir))
      const pins = pinsOf(manifest)
      if (pins.length === 0) return { ok: true, fetched: [], failed: [] }
      const clashes = marketplacePinClashes(
        pins,
        catalogPinNames(manifest.catalog_skills),
        new Set(scanAgentSkills(kit.dir).map((skill) => skill.name))
      )
      const wanted: PinTarget[] = []
      pins.forEach((pin, index) => {
        if (clashes.has(index) || !pin || typeof pin !== 'object') return
        const target = targetOf(pin as Record<string, unknown>)
        if (target && marketplaceSkillCache.resolve(target).state !== 'ready') wanted.push(target)
      })
      if (wanted.length === 0) return { ok: true, fetched: [], failed: [] }
      const who = account()
      if ('ok' in who) {
        for (const target of wanted) marketplaceSkillCache.recordFailure(target, who.message)
        settle(kit.rootId, agentId)
        return { ok: true, fetched: [], failed: wanted.map((target) => ({ name: target.name, code: who.code, message: who.message })) }
      }
      const fetched: string[] = []
      const failed: MarketplaceSkillEnsureFailure[] = []
      for (const target of wanted) {
        const outcome = phrased(await fetchSnapshot(who.profile, who.host, target))
        if (outcome.ok) fetched.push(target.name)
        else failed.push({ name: target.name, code: outcome.code, message: outcome.message })
      }
      settle(kit.rootId, agentId)
      if (failed.length > 0) logger.info('some pinned marketplace skills are not on this computer', { agentId, failed: failed.length })
      return { ok: true, fetched, failed }
    } catch (err) {
      logger.warn('pinned marketplace skills could not be checked', { agentId, error: err instanceof Error ? err.message : String(err) })
      return refused('write_failed', 'The pinned skills could not be checked.')
    }
  },

  /**
   * {@link ensurePinned} for the sharing verbs: in the background, never
   * awaited and never failing the verb it follows. Then the skill slots of
   * what is now on this computer get their credentials where one fits without
   * doubt — after the fetch, because a marketplace skill's slots are read from
   * its cached SKILL.md.
   */
  ensurePinnedInBackground(userId: string, agentId: string): void {
    void marketplaceSkillService.ensurePinned(userId, agentId).then(() => skillCredentialsInBackground(agentId)).catch(() => undefined)
  },

  /**
   * Where each of the agent's pins stands against its marketplace, from one
   * batch lookup (M7, M8): `current`, `update_available` (the entry's current
   * digest differs) or `unavailable` (the entry is absent: removed, or not
   * visible to this person). An entry still visible but with no snapshot to
   * move to is `current`: there is nothing to update to. A refusal is data.
   */
  async status(userId: string, agentId: string): Promise<MarketplaceSkillStatusResult> {
    try {
      const kit = locate(userId, agentId)
      if ('ok' in kit) return kit
      const pins = pinsOf(readManifest(manifestPath(kit.dir))).filter(
        (pin): pin is MarketplaceSkillPin => !!pin && typeof pin === 'object' && isCatalogPinName(pin.name) && typeof pin.entry_uuid === 'string'
      )
      if (pins.length === 0) return { ok: true, pins: [] }
      const who = account()
      if ('ok' in who) return who
      let found: Map<string, MarketplaceSkillEntry>
      try {
        found = await lookupEntries(who.profile, pins.map((pin) => pin.entry_uuid))
      } catch (err) {
        return readRefusal(err)
      }
      return { ok: true, pins: pins.map((pin) => pinStatus(pin, found.get(pin.entry_uuid.trim().toLowerCase()) ?? null)) }
    } catch (err) {
      logger.warn('marketplace skill status could not be read', { agentId, error: err instanceof Error ? err.message : String(err) })
      return refused('write_failed', 'The pinned skills could not be checked.')
    }
  },

  /**
   * Remove every cached snapshot no registered kit agent pins. Skipped, and
   * logged, when any agent's pins cannot be read. Run once per app start,
   * beside the catalog's, before any turn can hold a path into the cache;
   * synchronous. **Never throws.**
   */
  collectGarbage(): { ok: true; removed: number } | { ok: false; reason: string } {
    try {
      if (marketplaceSkillCache.isEmpty()) return { ok: true, removed: 0 }
      const pinned = pinnedKeys((manifest) => pinsOf(manifest).map(snapshotKeyOf))
      if (!pinned.ok) {
        logger.warn('marketplace skill cache not cleaned: some agent pins could not be read', { reason: pinned.reason })
        return pinned
      }
      return { ok: true, ...marketplaceSkillCache.collectGarbage(pinned.keep) }
    } catch (err) {
      logger.warn('marketplace skill cache could not be cleaned', { error: err instanceof Error ? err.message : String(err) })
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  },

  /** Tests: forget downloads in flight. */
  _reset(): void {
    inFlight.clear()
  }
}

/** One pin against the entry the batch lookup returned for it (null: absent). */
export function pinStatus(pin: MarketplaceSkillPin, entry: MarketplaceSkillEntry | null): MarketplaceSkillPinStatus {
  const base = { name: pin.name, entryUuid: pin.entry_uuid, ...(entry?.repositoryUrl ? { repositoryUrl: entry.repositoryUrl } : {}) }
  if (!entry) return { ...base, state: 'unavailable' }
  const pinned = typeof pin.archive_sha256 === 'string' ? pin.archive_sha256.toLowerCase() : ''
  if (entry.archiveSha256 === null || entry.archiveSha256 === pinned) return { ...base, state: 'current' }
  return { ...base, state: 'update_available', latestSha256: entry.archiveSha256, latestVersion: entry.version }
}
