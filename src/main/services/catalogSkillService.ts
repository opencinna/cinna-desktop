/**
 * Catalog skills in local agents (catalog U6, U7, U9, U10): pin a skill from
 * the catalog into a kit agent's `catalog_skills[]`, move a pin to the latest
 * version, drop one, and bring every pinned revision onto this computer.
 *
 * A pin is a reference, never a copy into `skills/`: the archive is
 * downloaded once into the shared read-only cache (`catalogSkillCache.ts`)
 * and every engine is given the cached folder (`agentSkillsPlugin.ts`,
 * `promptAssembly.ts`). The bytes are checked against the server's
 * `X-Content-SHA256` **and** the pin's `archive_sha256` before anything is
 * written, then unpacked by `kit/skillArchive.ts`' safe reader.
 *
 * * **Who may change pins (U9).** Not a bare folder, and not a shared agent
 *   the person may only use: its skills arrive with the team's next version,
 *   and a local pin change would be a change they can never share.
 * * **Who may download (U7).** Anyone who may use an agent may fetch what its
 *   latest version pins; a teammate whose copy is behind gets 404 until they
 *   update. {@link ensurePinned} records that as the row's issue, never as a
 *   failed Get or Update. On an agent no team tracks, the same 404 means the
 *   person's own access went, and the row says that instead.
 * * **Local installs (U10)** are reported in the background after each
 *   change and each fetch, as team sharing does; never awaited, never failing.
 *
 * Every answer is data ({@link CatalogSkillOutcome}); nothing a caller can
 * cause is thrown, because a thrown code does not survive IPC.
 *
 * Core service: no Electron, no window. Paths come from `runtimeHost`
 * through the cache; the token only ever goes to the active profile's own API.
 */

import { createHash } from 'node:crypto'
import { getProfileScopeUserId, getSettingsScopeUserId } from '../auth/scope'
import { agentRepo } from '../db/agents'
import { agentRootRepo } from '../db/agentRoots'
import { publishEvent } from '../host/events'
import { CinnaApiError, KitError, LocalAgentError } from '../errors'
import { CinnaSessionChanged } from '../auth/cinna-session'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { createLogger } from '../logger/logger'
import { cinnaFetchBytes } from './cinna-http'
import { libraryService, type CachedListing } from './libraryService'
import { cacheRefOf, catalogSkillCache, instanceKey, notAvailableSentence, revisionKeyOf } from './catalogSkillCache'
import { catalogLocalInstalls } from './catalogLocalInstalls'
import { localAgentService } from './localAgents/localAgentService'
import { scannerService } from './localAgents/scannerService'
import { activeListing, linkedEntry } from './catalogSkillUpdates'
import { libraryTrust } from './libraryTrust'
import { gitService } from './localAgents/gitService'
import { manifestPath, readManifest, readWithStamp, writeIfUnchanged } from '../kit/manifestIo'
import { MAX_ARCHIVE_BYTES, readSkillArchive, SkillArchiveError } from '../kit/skillArchive'
import {
  catalogPinClashes,
  catalogSkillRefOf,
  isCatalogPinName,
  PLATFORM_SKILL_NAMES,
  scanAgentSkills,
  type CatalogSkillRef
} from '../kit/skills'
import { LOCAL_AGENT_CHANGED_CHANNEL, type LocalAgentDto } from '../../shared/localAgents'
import type { CatalogSkillPin, CinnaAgentManifest } from '../../shared/kit/manifest'
import type { CatalogItem } from '../../shared/catalogItems'
import { SERVICE_CREDENTIALS_CHANGED, type AutoAttachedCredential, type ServiceCredentialsChangedPayload } from '../../shared/serviceCredentials'
import type {
  CatalogSkillEnsureFailure,
  CatalogSkillEnsureResult,
  CatalogSkillOutcome,
  CatalogSkillRefusal
} from '../../shared/catalogSkills'

const logger = createLogger('catalog-skills')

/** One revision's archive, under the profile's API. */
export function skillDownloadPath(packageUuid: string, revisionNumber: number): string {
  return `/api/v1/skills/packages/${encodeURIComponent(packageUuid)}/revisions/${revisionNumber}/download`
}

const SENTENCES: Record<CatalogSkillRefusal, string> = {
  no_account: 'Catalog skills need a Cinna account.',
  not_found: 'That agent or skill is no longer here.',
  not_kit_agent: 'Only an agent with a cinna-agent.json can hold catalog skills.',
  not_in_catalog: 'This skill is not in the catalog any more.',
  read_only: 'This agent is shared with you to use. Its skills change when the team shares a new version.',
  access_unknown: 'This shared agent is not in your catalog listing, so its skills cannot be changed here.',
  clash: 'This agent already has a skill with that name.',
  already_added: 'This agent already has this skill.',
  download_failed: 'The skill could not be downloaded.',
  hash_mismatch: 'The download did not match the published skill, so nothing was kept.',
  invalid_archive: 'The skill’s files could not be unpacked safely.',
  too_large: 'The skill is larger than 16 MB.',
  manifest_modified: 'cinna-agent.json changed while the skill was downloading. Try again.',
  write_failed: 'The skill could not be saved on this computer.',
  reauth_required: 'Sign in to Cinna again to download this skill.'
}

type Refused = { ok: false; code: CatalogSkillRefusal; message: string }

function refused(code: CatalogSkillRefusal, message?: string): Refused {
  return { ok: false, code, message: message ?? SENTENCES[code] }
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** A pin as the cache and the download see it. */
interface PinTarget extends CatalogSkillRef {
  revisionNumber: number
  packageId: string
}

/* ------------------------------------------------------------- downloads */

/**
 * A download the server answered 404: the revision is not available to this
 * person. Agent-independent — what it means (behind the team's latest, or
 * access withdrawn) depends on the agent asking, and one download serves
 * every agent pinning the revision — so {@link phrased} words it per caller.
 */
interface NotAvailable {
  ok: false
  notAvailable: true
}

type FetchOutcome = { ok: true } | Refused | NotAvailable

const inFlight = new Map<string, Promise<FetchOutcome>>()

/**
 * Why a download failed, as a refusal and the sentence the Skills section
 * shows; a 404 is {@link NotAvailable}, worded later by {@link phrased}.
 */
function downloadRefusal(err: unknown): Refused | NotAvailable {
  if (err instanceof CinnaReauthRequired) return refused('reauth_required')
  if (err instanceof CinnaApiError) {
    if (err.code === 'reauth_required' && err.status === 403) {
      return refused('download_failed', 'The server did not allow this download.')
    }
    if (err.code === 'reauth_required') return refused('reauth_required')
    if (err.status === 404) return { ok: false, notAvailable: true }
    if (err.code === 'not_cinna_user' || err.code === 'missing_server_url') return refused('no_account')
    return refused('download_failed', `The skill could not be downloaded: ${err.message}`.slice(0, 300))
  }
  if (err instanceof CinnaSessionChanged) return refused('download_failed', 'The Cinna account changed during the download.')
  if (err instanceof SkillArchiveError) return refused('invalid_archive', err.message)
  return refused('download_failed', `The skill could not be downloaded: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300))
}

/**
 * Fetch one pinned revision into the active instance's cache. The bytes must
 * equal both the server's `X-Content-SHA256` and the pin's `archive_sha256`
 * before they are unpacked; any failure leaves the cache as it was and is
 * remembered for the Skills section. One download per revision at a time.
 */
function fetchRevision(profile: string, host: string, target: PinTarget): Promise<FetchOutcome> {
  const instance = instanceKey(host)
  // Nothing reaches the request path that is not a UUID, a revision number and a digest.
  const safe = cacheRefOf(target)
  if (safe === null) return Promise.resolve(refused('download_failed', 'This pin does not name a catalog skill version that can be downloaded.'))
  // The digest is part of the key: two pins of one revision with different
  // digests are two checks, and one must never answer for the other.
  const key = `${instance}/${safe.uuid}/${safe.revision}/${safe.sha}`
  const running = inFlight.get(key)
  if (running) return running
  const run = (async (): Promise<FetchOutcome> => {
    if (catalogSkillCache.has(instance, target)) return { ok: true }
    let outcome: FetchOutcome
    try {
      const answer = await cinnaFetchBytes(profile, skillDownloadPath(safe.uuid, Number(safe.revision)), {
        maxBytes: MAX_ARCHIVE_BYTES
      })
      if (!answer.ok) {
        outcome = refused('too_large')
      } else {
        const digest = sha256(answer.bytes)
        const declared = (answer.headers.get('x-content-sha256') ?? '').trim().toLowerCase()
        if (declared === '' || digest !== declared || digest !== target.archiveSha256.trim().toLowerCase()) {
          logger.warn('catalog skill digest mismatch', { name: target.name, revision: target.revisionNumber })
          outcome = refused('hash_mismatch')
        } else {
          const archive = readSkillArchive(answer.bytes, target.name)
          try {
            catalogSkillCache.install(instance, target, archive)
            outcome = { ok: true }
          } catch (err) {
            logger.warn('catalog skill could not be cached', { name: target.name, error: String(err) })
            outcome = refused('write_failed')
          }
        }
      }
    } catch (err) {
      outcome = downloadRefusal(err)
    }
    if (outcome.ok) catalogSkillCache.clearFailure(target)
    else if ('notAvailable' in outcome) catalogSkillCache.recordNotAvailable(target)
    else catalogSkillCache.recordFailure(target, outcome.message)
    return outcome
  })().finally(() => inFlight.delete(key))
  inFlight.set(key, run)
  return run
}

/**
 * A download's outcome for one caller: a {@link NotAvailable} 404 becomes a
 * `download_failed` refusal in that caller's agent's words —
 * {@link notAvailableSentence} of whether a team tracks it.
 */
async function phrased(outcome: FetchOutcome, teamTracked: () => Promise<boolean>): Promise<{ ok: true } | Refused> {
  if (outcome.ok) return outcome
  if ('notAvailable' in outcome) return refused('download_failed', notAvailableSentence(await teamTracked()))
  return outcome
}

/* ---------------------------------------------------------------- agents */

interface KitTarget {
  rootId: string
  dir: string
}

/** The kit agent behind an id, or a refusal. */
function locateKit(userId: string, agentId: string): KitTarget | Refused {
  let agent: LocalAgentDto
  try {
    agent = localAgentService.get(userId, agentId)
  } catch (err) {
    if (err instanceof LocalAgentError) return refused('not_found')
    throw err
  }
  // Only a kit agent's DTO carries `skills` (the scanner leaves it off a bare folder's).
  if (agent.skills === undefined) return refused('not_kit_agent')
  try {
    readManifest(manifestPath(agent.path))
  } catch {
    return refused('not_kit_agent')
  }
  return { rootId: agent.rootId, dir: agent.path }
}

function pinsOf(manifest: CinnaAgentManifest): CatalogSkillPin[] {
  return Array.isArray(manifest.catalog_skills) ? manifest.catalog_skills : []
}

/** Whether a pin (as written, so possibly malformed) names the package `uuid`. */
function pinsPackage(pin: unknown, uuid: string): boolean {
  const value = pin && typeof pin === 'object' ? (pin as Record<string, unknown>).package_uuid : null
  return typeof value === 'string' && value.trim().toLowerCase() === uuid.trim().toLowerCase()
}

function targetOf(pin: Record<string, unknown>): PinTarget | null {
  const ref = catalogSkillRefOf(pin)
  if (ref.revisionNumber === null || !isCatalogPinName(ref.name)) return null
  return {
    ...ref,
    revisionNumber: ref.revisionNumber,
    packageId: typeof pin.package_id === 'string' ? pin.package_id : ''
  }
}

/**
 * The repository id of an `origin` that is a Cinna team agent's, or null for
 * any other remote. Cinna-ness is decided as `sharingService.parseRemote`
 * decides it — `…/git/<repo_id>.git` on a git origin a Cinna instance this
 * machine has a profile for has itself named (`libraryTrust`) — or by the
 * folder's recorded `cinna.server`. The recorded server can only make this
 * stricter (a refusal), never hand out a token, so it is enough here.
 */
function cinnaRepoIdOf(originUrl: string, cinnaServer: string | null): string | null {
  let parsed: URL
  try {
    parsed = new URL(originUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  const match = parsed.pathname.match(/\/git\/([^/]+)\.git\/?$/)
  if (!match) return null
  let repoId: string
  try {
    repoId = decodeURIComponent(match[1])
  } catch {
    return null
  }
  if (cinnaServer !== null) return repoId
  const hosts = libraryService.knownHosts()
  const trusted = [parsed.origin, ...libraryTrust.serversFor(parsed.origin)].some(
    (server) => hosts.has(server) && libraryTrust.trusts(server, parsed.origin)
  )
  return trusted ? repoId : null
}

/**
 * May this person change the agent's pins (U9)? A folder that is not a
 * shared repository may always; a shared one only with `edit` or
 * `maintain` in the catalog listing. Read from the folder's git `origin`,
 * matched to the listing by repository id, with the `shared_remote` link as
 * a second key. When git cannot answer (missing, or the read failed), the
 * link alone decides, as `changeableFromLink` does for the rows.
 */
async function changeability(dir: string, listing: CachedListing | null): Promise<'ok' | 'read_only' | 'access_unknown'> {
  const remote = await gitService.readShareRemote(dir)
  const linked = linkedEntry(dir, listing)
  if (!remote.ownRepo || remote.originUrl === null) {
    if (!linked.linked) return 'ok'
    if (linked.access === null) return 'access_unknown'
    return linked.access === 'use' ? 'read_only' : 'ok'
  }
  const repoId = cinnaRepoIdOf(remote.originUrl, remote.cinnaServer)
  const entry = listing?.agents.find((agent) => agent.cloneUrl === remote.originUrl || (repoId !== null && agent.repoId === repoId))
  const access = entry?.access ?? linked.access
  if (access !== null) return access === 'use' ? 'read_only' : 'ok'
  // Shared through Cinna, and the listing does not say how: refuse rather than guess.
  if (linked.linked || repoId !== null) return 'access_unknown'
  // Any other git remote is the developer's own business.
  return 'ok'
}

/**
 * Whether a team tracks this agent — it was got from, or shared to, a Cinna
 * catalog — so its pins are reached through the team's latest version (U7)
 * rather than the person's own grant. The `shared_remote` link, else a git
 * `origin` that is a Cinna team agent's. When git cannot answer, yes: the
 * sentence for a tracked agent is the hedged one.
 */
function teamTrackedOf(dir: string): () => Promise<boolean> {
  let answer: Promise<boolean> | null = null
  const decide = async (): Promise<boolean> => {
    if (linkedEntry(dir, null).linked) return true
    try {
      const remote = await gitService.readShareRemote(dir)
      if (remote.refusal === 'git_missing') return true
      return remote.ownRepo && remote.originUrl !== null && cinnaRepoIdOf(remote.originUrl, remote.cinnaServer) !== null
    } catch {
      return true
    }
  }
  // Read once per verb, and only when a download was refused with a 404.
  return () => (answer ??= decide())
}

/** The cached listing (refreshed once when it lacks `uuid`) and the skill item, if any. */
async function skillItem(profile: string, uuid: string): Promise<{ listing: CachedListing | null; item: CatalogItem | null }> {
  const find = (listing: CachedListing | null): CatalogItem | null =>
    listing?.items.find((item) => item.kind === 'skill' && item.uuid.toLowerCase() === uuid.toLowerCase()) ?? null
  let listing = activeListing(profile)
  let item = find(listing)
  if (!item) {
    try {
      listing = await libraryService.refresh(profile)
    } catch (err) {
      if (err instanceof CinnaReauthRequired || (err instanceof CinnaApiError && err.code === 'reauth_required')) throw err
      logger.warn('catalog listing could not be refreshed', { error: String(err) })
    }
    item = find(listing)
  }
  return { listing, item }
}

/** The pin fields of a listing item's latest version, or null when it has none to pin. */
function latestPinOf(item: CatalogItem): CatalogSkillPin | null {
  const revision = item.latest?.revision_number
  const digest = item.skill?.archive_sha256
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) return null
  if (typeof digest !== 'string' || !/^[0-9a-fA-F]{64}$/.test(digest)) return null
  if (!isCatalogPinName(item.name)) return null
  const version = typeof item.latest?.version === 'string' && item.latest.version.trim() !== '' ? item.latest.version.trim() : null
  return {
    package_id: item.id,
    package_uuid: item.uuid,
    name: item.name,
    revision_number: revision,
    ...(version ? { version } : {}),
    archive_sha256: digest.toLowerCase()
  }
}

/** Why `name` cannot be pinned beside what the agent already has, or null. `except` is the pin being replaced. */
function clashOf(dir: string, pins: CatalogSkillPin[], name: string, except: number | null): boolean {
  if (PLATFORM_SKILL_NAMES.has(name)) return true
  if (scanAgentSkills(dir).some((skill) => skill.name === name)) return true
  return pins.some((pin, index) => index !== except && pin && typeof pin === 'object' && pin.name === name)
}

/** Tell the scanner and the renderer that what an agent's skills resolve to moved. */
function settle(rootId: string, agentId: string | null): void {
  scannerService.markAllRootsDirty()
  publishEvent(LOCAL_AGENT_CHANGED_CHANNEL, { rootId, agentId, reason: 'rescan' })
}

/**
 * Re-read the manifest and write `change(pins)` through the modified-underneath
 * guard. `change` answers the new list, or a refusal decided on the fresh read.
 */
function writePins(dir: string, change: (pins: CatalogSkillPin[]) => CatalogSkillPin[] | Refused): { ok: true; manifestId: string | null } | Refused {
  const path = manifestPath(dir)
  try {
    const { manifest, stamp } = readWithStamp(path)
    const next = change(pinsOf(manifest))
    if (!Array.isArray(next)) return next
    writeIfUnchanged(path, { ...manifest, catalog_skills: next }, stamp)
    return { ok: true, manifestId: typeof manifest.id === 'string' && manifest.id !== '' ? manifest.id : null }
  } catch (err) {
    if (err instanceof KitError && err.code === 'manifest_modified') return refused('manifest_modified')
    if (err instanceof KitError) return refused('write_failed', err.message)
    throw err
  }
}

function reportInstalled(profile: string, pin: { package_uuid: string; revision_number: number }, hostManifestId: string | null): void {
  if (!hostManifestId) return
  void catalogLocalInstalls.reportSkillInstalled(profile, pin.package_uuid, pin.revision_number, hostManifestId)
}

/** The profile and its server, or a refusal. */
function account(): { profile: string; host: string } | Refused {
  const profile = getProfileScopeUserId()
  const host = libraryService.hostOf(profile)
  return host === null ? refused('no_account') : { profile, host }
}

/**
 * Fill the agent's skill slots exactly one cloud credential fits (U11: `provision-local`, then a
 * strict `(type, service_uri = slot)` match). Loaded on use, like the drivers do, so this module
 * does not pull the credential service in. Never fails the verb it follows, and never holds it up:
 * the verbs start it without waiting (`provision-local` may take its full timeout per revision).
 * What it attached reaches the renderer on `SERVICE_CREDENTIALS_CHANGED` as `autoAttached`, so
 * Finish setup can say "Connected automatically".
 */
async function skillCredentials(agentId: string): Promise<AutoAttachedCredential[]> {
  try {
    const { serviceCredentialService } = await import('./serviceCredentials/service')
    const items = await serviceCredentialService.autoAttachSkills(agentId)
    if (items.length) {
      const payload: ServiceCredentialsChangedPayload = { autoAttached: { agentId, items } }
      publishEvent(SERVICE_CREDENTIALS_CHANGED, payload, 'all')
    }
    return items
  } catch (err) {
    logger.warn('skill credentials could not be attached', { agentId, error: err instanceof Error ? err.message : String(err) })
    return []
  }
}

/**
 * Detach what auto-attach put on the agent for skill slots nothing declares any more (a removed skill,
 * or a version that dropped a provider). Loaded on use like {@link skillCredentials}; in the background,
 * never failing the verb. Runs after `settle`, and the credential service re-reads the agent from its
 * folder, so it sees the pins as just written.
 */
async function detachUnusedCredentials(agentId: string): Promise<void> {
  try {
    const { serviceCredentialService } = await import('./serviceCredentials/service')
    await serviceCredentialService.detachUnusedAutoAttachments(agentId)
  } catch (err) {
    logger.warn('unused skill credentials could not be detached', { agentId, error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * The `uuid/revision` of every pin a registered kit agent holds, or why that cannot be known. Every
 * root is scanned as the agents list scans it (cached), so a folder on disk the index has not seen yet
 * counts too; only a kit agent's DTO carries `skills`, and a bare folder pins nothing. An indexed agent
 * the scan did not reach (its root is not readable: a drive not mounted), or a kit agent whose manifest
 * cannot be read (gone, unparsable), makes the answer unknown.
 */
function pinnedRevisions(): { ok: true; keep: Set<string> } | { ok: false; reason: string } {
  const userId = getSettingsScopeUserId()
  const scanned = agentRootRepo.list(userId).flatMap((root) => scannerService.scanRootCached(userId, root).agents)
  const reached = new Set(scanned.map((agent) => agent.path))
  if (agentRepo.listFolder(userId).some((row) => row.localPath !== null && !reached.has(row.localPath))) {
    return { ok: false, reason: 'an agent folder could not be read' }
  }
  const keep = new Set<string>()
  for (const agent of scanned) {
    if (agent.skills === undefined) continue
    try {
      for (const pin of pinsOf(readManifest(manifestPath(agent.path)))) {
        const key = revisionKeyOf(pin)
        if (key) keep.add(key)
      }
    } catch (err) {
      return { ok: false, reason: `an agent's manifest could not be read: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  return { ok: true, keep }
}

/** Run a verb, turning a lost session into a refusal and logging anything unexpected. */
async function guarded<T extends { ok: boolean }>(verb: string, run: () => Promise<T | Refused>): Promise<T | Refused> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof CinnaReauthRequired || (err instanceof CinnaApiError && err.code === 'reauth_required')) {
      return refused('reauth_required')
    }
    logger.error(`catalog skill ${verb} failed`, { error: err instanceof Error ? err.message : String(err) })
    return refused('write_failed', `Something went wrong: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300))
  }
}

export const catalogSkillService = {
  /**
   * Pin the latest version of the catalog skill `packageUuid` into a kit
   * agent: checks (kit agent, may change it, no clash, not pinned yet),
   * download into the cache, then the pin through the manifest guard, then
   * the local-install report in the background.
   */
  async addToAgent(userId: string, agentId: string, packageUuid: string): Promise<CatalogSkillOutcome> {
    return guarded('add', async () => {
      const who = account()
      if ('ok' in who) return who
      const kit = locateKit(userId, agentId)
      if ('ok' in kit) return kit
      const { listing, item } = await skillItem(who.profile, packageUuid)
      const pin = item ? latestPinOf(item) : null
      if (!pin) return refused('not_in_catalog')
      const access = await changeability(kit.dir, listing)
      if (access !== 'ok') return refused(access)
      const before = pinsOf(readManifest(manifestPath(kit.dir)))
      if (before.some((existing) => pinsPackage(existing, pin.package_uuid))) return refused('already_added')
      if (clashOf(kit.dir, before, pin.name, null)) return refused('clash')

      const target = targetOf(pin)
      if (!target) return refused('not_in_catalog')
      const fetched = await phrased(await fetchRevision(who.profile, who.host, target), teamTrackedOf(kit.dir))
      if (!fetched.ok) return fetched
      // Decided again on the fresh read: the download took time.
      const written = writePins(kit.dir, (pins) => {
        if (pins.some((existing) => pinsPackage(existing, pin.package_uuid))) return refused('already_added')
        if (clashOf(kit.dir, pins, pin.name, null)) return refused('clash')
        return [...pins, pin]
      })
      if (!written.ok) return written
      settle(kit.rootId, agentId)
      reportInstalled(who.profile, pin, written.manifestId)
      logger.info('catalog skill added', { agentId, name: pin.name, revision: pin.revision_number })
      void skillCredentials(agentId)
      return { ok: true as const, name: pin.name, revisionNumber: pin.revision_number }
    })
  },

  /** Move the pin `name` to the package's latest version, fetching it first (U9: only where the person may change the agent). */
  async update(userId: string, agentId: string, name: string): Promise<CatalogSkillOutcome> {
    return guarded('update', async () => {
      const who = account()
      if ('ok' in who) return who
      const kit = locateKit(userId, agentId)
      if ('ok' in kit) return kit
      const current = pinsOf(readManifest(manifestPath(kit.dir))).find((pin) => pin?.name === name)
      if (!current || typeof current.package_uuid !== 'string') return refused('not_found')
      const { listing, item } = await skillItem(who.profile, current.package_uuid)
      const latest = item ? latestPinOf(item) : null
      if (!latest) return refused('not_in_catalog')
      const access = await changeability(kit.dir, listing)
      if (access !== 'ok') return refused(access)
      if (typeof current.revision_number === 'number' && current.revision_number >= latest.revision_number) {
        return { ok: true as const, name, revisionNumber: current.revision_number }
      }
      // The pin keeps its name: the package's folder name is what the engines call it.
      const target = targetOf({ ...latest, name })
      if (!target) return refused('not_in_catalog')
      const fetched = await phrased(await fetchRevision(who.profile, who.host, target), teamTrackedOf(kit.dir))
      if (!fetched.ok) return fetched
      const written = writePins(kit.dir, (pins) => {
        const index = pins.findIndex((pin) => pin?.name === name)
        if (index === -1) return refused('not_found')
        if (clashOf(kit.dir, pins, name, index)) return refused('clash')
        // Unknown keys of the pin survive; the old version label does not.
        const rest: Record<string, unknown> = { ...pins[index] }
        delete rest.version
        const moved: CatalogSkillPin = {
          ...rest,
          package_id: latest.package_id,
          package_uuid: latest.package_uuid,
          name,
          revision_number: latest.revision_number,
          ...(latest.version ? { version: latest.version } : {}),
          archive_sha256: latest.archive_sha256
        }
        return pins.map((pin, at) => (at === index ? moved : pin))
      })
      if (!written.ok) return written
      settle(kit.rootId, agentId)
      reportInstalled(who.profile, latest, written.manifestId)
      logger.info('catalog skill updated', { agentId, name, revision: latest.revision_number })
      // A later version can drop a provider: what was attached for it goes, then the new slots fill.
      void detachUnusedCredentials(agentId).then(() => skillCredentials(agentId))
      return { ok: true as const, name, revisionNumber: latest.revision_number }
    })
  },

  /**
   * Drop the pin `name`, and detach in the background what auto-attach put there for slots no skill
   * declares any more. The cached revision stays: a running turn may still read it, and the next
   * app start's {@link collectGarbage} removes it if nothing pins it.
   */
  async remove(userId: string, agentId: string, name: string): Promise<CatalogSkillOutcome> {
    return guarded('remove', async () => {
      const kit = locateKit(userId, agentId)
      if ('ok' in kit) return kit
      const profile = getProfileScopeUserId()
      const access = await changeability(kit.dir, activeListing(profile))
      if (access !== 'ok') return refused(access)
      let dropped: CatalogSkillPin | null = null
      const written = writePins(kit.dir, (pins) => {
        const index = pins.findIndex((pin) => pin?.name === name)
        if (index === -1) return refused('not_found')
        dropped = pins[index]
        return pins.filter((_, at) => at !== index)
      })
      if (!written.ok) return written
      settle(kit.rootId, agentId)
      const pin = dropped as CatalogSkillPin | null
      if (pin && typeof pin.package_uuid === 'string' && written.manifestId && libraryService.hostOf(profile) !== null) {
        void catalogLocalInstalls.reportSkillRemoved(profile, pin.package_uuid, written.manifestId)
      }
      logger.info('catalog skill removed', { agentId, name })
      void detachUnusedCredentials(agentId)
      return { ok: true as const, name, revisionNumber: typeof pin?.revision_number === 'number' ? pin.revision_number : 0 }
    })
  },

  /**
   * Bring every revision the agent pins onto this computer (U7: the agent's
   * access authorises it). Pins already cached, unusable pins and pins whose
   * name clashes are skipped; each failure is recorded for the Skills section
   * and listed. Called after Get, Update and Use the team's version, and for
   * a "Try again". **Never throws.**
   */
  async ensurePinned(userId: string, agentId: string): Promise<CatalogSkillEnsureResult> {
    try {
      const kit = locateKit(userId, agentId)
      if ('ok' in kit) return kit
      const manifest = readManifest(manifestPath(kit.dir))
      const pins = pinsOf(manifest)
      if (pins.length === 0) return { ok: true, fetched: [], failed: [] }
      const clashes = catalogPinClashes(pins, new Set(scanAgentSkills(kit.dir).map((skill) => skill.name)))
      const wanted: PinTarget[] = []
      pins.forEach((pin, index) => {
        if (clashes.has(index) || !pin || typeof pin !== 'object') return
        const target = targetOf(pin as Record<string, unknown>)
        if (target && catalogSkillCache.resolve(target).state !== 'ready') wanted.push(target)
      })
      if (wanted.length === 0) return { ok: true, fetched: [], failed: [] }
      const who = account()
      if ('ok' in who) {
        for (const target of wanted) catalogSkillCache.recordFailure(target, who.message)
        settle(kit.rootId, agentId)
        return { ok: true, fetched: [], failed: wanted.map((target) => ({ name: target.name, code: who.code, message: who.message })) }
      }
      const fetched: string[] = []
      const failed: CatalogSkillEnsureFailure[] = []
      const hostManifestId = typeof manifest.id === 'string' && manifest.id !== '' ? manifest.id : null
      const teamTracked = teamTrackedOf(kit.dir)
      for (const target of wanted) {
        const outcome = await phrased(await fetchRevision(who.profile, who.host, target), teamTracked)
        if (outcome.ok) {
          fetched.push(target.name)
          reportInstalled(who.profile, { package_uuid: target.packageUuid, revision_number: target.revisionNumber }, hostManifestId)
        } else {
          failed.push({ name: target.name, code: outcome.code, message: outcome.message })
        }
      }
      settle(kit.rootId, agentId)
      if (failed.length > 0) logger.info('some pinned catalog skills are not on this computer', { agentId, failed: failed.length })
      return { ok: true, fetched, failed }
    } catch (err) {
      logger.warn('pinned catalog skills could not be checked', { agentId, error: err instanceof Error ? err.message : String(err) })
      return refused('write_failed', 'The pinned skills could not be checked.')
    }
  },

  /**
   * {@link ensurePinned} for the sharing verbs: in the background, never
   * awaited and never failing the verb it follows. Then the skill slots of
   * what is now on this computer get their credentials where one fits
   * without doubt (U11) — after the fetch, because a catalog skill's slots
   * are read from its cached SKILL.md.
   */
  ensurePinnedInBackground(userId: string, agentId: string): void {
    void catalogSkillService.ensurePinned(userId, agentId).then(() => skillCredentials(agentId)).catch(() => undefined)
  },

  /**
   * Remove every cached revision no registered kit agent pins (the profiles share one agents list,
   * so one keep set covers them all). Skipped, and logged, when any agent's pins cannot be read:
   * deleting a revision someone still pins is worse than keeping a stale one. Run once per app
   * start, before any turn can hold a path into the cache; synchronous. **Never throws.**
   */
  collectGarbage(): { ok: true; removed: number } | { ok: false; reason: string } {
    try {
      // Nothing cached: no reason to read every agent's pins on the way to the window.
      if (catalogSkillCache.isEmpty()) return { ok: true, removed: 0 }
      const pinned = pinnedRevisions()
      if (!pinned.ok) {
        logger.warn('catalog skill cache not cleaned: some agent pins could not be read', { reason: pinned.reason })
        return pinned
      }
      return { ok: true, ...catalogSkillCache.collectGarbage(pinned.keep) }
    } catch (err) {
      logger.warn('catalog skill cache could not be cleaned', { error: err instanceof Error ? err.message : String(err) })
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  },

  /** Tests: forget downloads in flight. */
  _reset(): void {
    inFlight.clear()
  }
}
