/**
 * Skill links (plans README L1–L9): what a pasted or clicked
 * `/get/skill/<package_id>` link means for this person, right now.
 *
 * `resolve` matches the link's server to a Cinna profile, reads the catalog
 * listing **fresh** (a grant lowered since the last poll must win, as Make
 * editable learned in c04d4d7b), finds the skill by its `package_id`, and says
 * whether the composer's agent can take it. Every outcome is data, unexpected
 * errors included, because a thrown code does not survive IPC.
 *
 * It decides nothing that Add does not decide again: `catalogSkillService.addToAgent`
 * stays the install, and its own refusals are the final word — this verdict
 * may be stale by the time of the click. It reuses that service's checks
 * rather than restating them.
 *
 * Core service: no Electron, no window.
 */

import { getProfileScopeUserId } from '../auth/scope'
import { userRepo } from '../db/users'
import { createLogger } from '../logger/logger'
import { manifestPath, readManifest } from '../kit/manifestIo'
import { libraryService, type CachedListing } from './libraryService'
import { localAgentService } from './localAgents/localAgentService'
import { changeability, clashOf, latestPinOf, locateKit, pinsOf, pinsPackage } from './catalogSkillService'
import { normalizeServerOrigin } from '../../shared/serverOrigin'
import { CinnaApiError } from '../errors'
import { knownOriginsOf, webOriginOf } from './cinnaServerOrigins'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { broadcastReauthRequired } from '../auth/reauth-notify'
import type { CatalogItem } from '../../shared/catalogItems'
import type {
  SkillLinkResolution,
  SkillLinkResolveInput,
  SkillLinkSkill,
  SkillLinkTarget
} from '../../shared/skillLink'

const logger = createLogger('skill-link')

/** The IPC channel the reauth prompt names as its source. */
const RESOLVE_CHANNEL = 'skill-link:resolve'

/** The active Cinna session is gone: sign in again, not "offline" (as `improvementRequestService` tells them apart). */
function isReauth(err: unknown): boolean {
  return err instanceof CinnaReauthRequired || (err instanceof CinnaApiError && err.code === 'reauth_required')
}

/** Core's `package_id` alphabet, as the link grammar allows it. */
const PACKAGE_ID = /^(?!\.+$)[A-Za-z0-9._-]{1,255}$/

/** A stored server URL's origin, as `libraryService.hostOf` derives it. */
function originOf(serverUrl: string | null): string | null {
  if (!serverUrl) return null
  try {
    return new URL(serverUrl).origin
  } catch {
    return null
  }
}

/** The host to show for an origin. */
function hostOf(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

/** The listing's skill with this `package_id`, matched exactly. */
function findSkill(listing: CachedListing | null, packageId: string): CatalogItem | null {
  return listing?.items.find((item) => item.kind === 'skill' && item.id === packageId) ?? null
}

function skillOf(item: CatalogItem, revisionNumber: number): SkillLinkSkill {
  const label = typeof item.latest?.version === 'string' && item.latest.version.trim() !== '' ? item.latest.version.trim() : null
  return {
    packageUuid: item.uuid,
    packageId: item.id,
    title: item.display_name || item.name,
    name: item.name,
    revisionNumber,
    versionLabel: label,
    publisher: item.publisher?.display_name || null,
    description: item.description || null,
    requiredCredentialSpecs: Array.isArray(item.required_credential_specs) ? item.required_credential_specs : []
  }
}

/** The agent's display name, when the index knows it. */
function agentNameOf(userId: string, agentId: string): string | null {
  try {
    return localAgentService.get(userId, agentId).name || null
  } catch {
    return null
  }
}

/** Whether the skill can go on `agentId`, decided as Add would decide it. */
async function targetOf(
  userId: string,
  agentId: string | null | undefined,
  item: CatalogItem,
  pinName: string,
  latestRevision: number,
  listing: CachedListing
): Promise<SkillLinkTarget> {
  if (!agentId) return { agentId: null, agentName: null, verdict: 'no_agent' }
  const kit = locateKit(userId, agentId)
  if ('ok' in kit) return { agentId, agentName: agentNameOf(userId, agentId), verdict: 'not_kit_agent' }
  const agentName = agentNameOf(userId, agentId) ?? ''
  const access = await changeability(kit.dir, listing)
  // Pins before changeability: an agent that already has the skill says so,
  // use-only or not. Behind only where Update could run, so a refusal is
  // never offered as an Update.
  const pins = pinsOf(readManifest(manifestPath(kit.dir)))
  const existing = pins.find((pin) => pinsPackage(pin, item.uuid))
  if (existing) {
    const pinnedRevision = typeof existing.revision_number === 'number' ? existing.revision_number : null
    return {
      agentId,
      agentName,
      verdict: 'already_added',
      pinName: typeof existing.name === 'string' ? existing.name : '',
      pinnedRevision,
      // A pin without a readable revision is one Update would move.
      behind: access === 'ok' && (pinnedRevision === null || pinnedRevision < latestRevision)
    }
  }
  if (access !== 'ok') return { agentId, agentName, verdict: access }
  if (clashOf(kit.dir, pins, pinName, null)) return { agentId, agentName, verdict: 'clash' }
  return { agentId, agentName, verdict: 'ok' }
}

type CinnaProfile = ReturnType<typeof userRepo.list>[number]

/** Where a link's origin landed among the person's profiles (`profileOn`). */
type ProfileMatch =
  | { kind: 'match'; other: CinnaProfile | null; origin: string }
  | { kind: 'none' }
  /** No profile matched, but a profile's server could not be asked: answer on `origin` (offline). */
  | { kind: 'unknown'; origin: string }

/**
 * The profile a link's `origin` (not the active profile's stored one) is on,
 * and that profile's stored origin, which the answer names: the server the
 * skill would come from. A profile stored on exactly that origin first, with
 * no network; else one whose server also answers on it (web app vs backend,
 * `knownOriginsOf`). Every profile's discovery runs at once, so the wait is one
 * `DISCOVERY_WAIT_MS` window; the active profile wins, and among the others
 * only a single claimant counts (two claiming one origin is no match, never
 * first-wins). No match while some profile's server could not be asked is
 * `unknown`, not `none`: the person may well be on that server. Only each
 * profile's own discovery is asked, never the link's origin.
 */
async function profileOn(origin: string, active: string, activeOrigin: string | null): Promise<ProfileMatch> {
  const profiles = userRepo.list().filter((user) => user.type === 'cinna_user')
  const others = profiles.filter((user) => user.id !== active)
  const exact = others.find((user) => originOf(user.cinnaServerUrl) === origin)
  if (exact) return { kind: 'match', other: exact, origin }

  const askable = (user: CinnaProfile | undefined): user is CinnaProfile & { cinnaServerUrl: string } =>
    user !== undefined && user.cinnaServerUrl !== null
  const activeUser = activeOrigin !== null ? profiles.find((user) => user.id === active) : undefined
  const ask = (user: CinnaProfile | undefined) => (askable(user) ? knownOriginsOf(user.cinnaServerUrl) : Promise.resolve(null))
  const [activeKnown, ...othersKnown] = await Promise.all([ask(activeUser), ...others.map(ask)])

  if (activeOrigin !== null && activeKnown?.origins.has(origin)) return { kind: 'match', other: null, origin: activeOrigin }
  // The active server could not be asked: the link may well be on it, so no
  // other profile's claim may take it (Try again, not Switch to …).
  if (activeOrigin !== null && activeKnown?.discovered === false) return { kind: 'unknown', origin: activeOrigin }
  const claimants = others.filter((_user, index) => othersKnown[index]?.origins.has(origin))
  const stored = claimants.length === 1 ? originOf(claimants[0].cinnaServerUrl) : null
  if (stored !== null) return { kind: 'match', other: claimants[0], origin: stored }
  if (claimants.length > 1) logger.warn('more than one profile’s server answers on a skill link’s origin; matching none', { origin })

  if (othersKnown.some((known) => known?.discovered === false)) return { kind: 'unknown', origin }
  return { kind: 'none' }
}

async function resolveLink(
  userId: string,
  input: SkillLinkResolveInput,
  reached: (origin: string) => void
): Promise<SkillLinkResolution> {
  const active = getProfileScopeUserId()
  const activeOrigin = libraryService.hostOf(active)

  let origin: string | null = activeOrigin
  if (input.origin !== null && input.origin !== undefined) {
    const normalized = typeof input.origin === 'string' ? normalizeServerOrigin(input.origin) : null
    if (!normalized?.ok) return { state: 'not_connected', host: null, origin: null }
    origin = normalized.origin
  }
  if (origin === null) return { state: 'not_connected', host: null, origin: null }
  reached(origin)

  let other: CinnaProfile | null = null
  if (origin !== activeOrigin) {
    const match = await profileOn(origin, active, activeOrigin)
    if (match.kind === 'none') return { state: 'not_connected', host: hostOf(origin), origin }
    // A server that could not be asked is not one the person is off: Try again, not Connect….
    if (match.kind === 'unknown') return { state: 'offline', host: hostOf(match.origin), origin: match.origin }
    other = match.other
    origin = match.origin
    reached(origin)
  }
  const host = hostOf(origin)

  if (other !== null) {
    // That profile's last listing, for the title only: it never answers access.
    let title: string | null = null
    if (typeof input.packageId === 'string') {
      try {
        const item = findSkill(libraryService.cached(other.id), input.packageId)
        title = item ? item.display_name || item.name : null
      } catch {
        title = null
      }
    }
    return { state: 'other_profile', host, origin, profileId: other.id, profileName: other.displayName, title }
  }

  // No package on any server is called that; nothing to ask.
  if (typeof input.packageId !== 'string' || !PACKAGE_ID.test(input.packageId)) return { state: 'no_access', host, origin }

  let listing: CachedListing | null
  try {
    listing = await libraryService.refresh(active)
  } catch (err) {
    if (isReauth(err)) {
      broadcastReauthRequired(RESOLVE_CHANNEL)
      return { state: 'reauth_required', host, origin }
    }
    logger.warn('catalog listing could not be read for a skill link', { error: err instanceof Error ? err.message : String(err) })
    return { state: 'offline', host, origin }
  }
  if (listing === null) return { state: 'not_connected', host, origin }
  // A listing that stands in as empty (404/403) says nothing, and core does not tell a missing package from a private one.
  if (!listing.available) return { state: 'no_access', host, origin }
  const item = findSkill(listing, input.packageId)
  const latest = item ? latestPinOf(item) : null
  if (!item || !latest) return { state: 'no_access', host, origin }

  const skill = skillOf(item, latest.revision_number)
  const target = await targetOf(userId, input.agentId, item, latest.name, latest.revision_number, listing)
  if (target.verdict === 'already_added') return { state: 'already_added', host, origin, serverGiven: input.origin != null, skill, target }
  return { state: 'ok', host, origin, serverGiven: input.origin != null, skill, target }
}

export const skillLinkService = {
  /**
   * What the link `{origin, packageId}` offers on the composer's agent
   * (README §4). `origin` null: the active profile's server. `userId` is the
   * settings scope, where folder agents live. Never throws: a lost Cinna
   * session is `reauth_required` (and raises the app-wide sign-in prompt), any
   * other unexpected failure `offline` once the server is known, else
   * `not_connected`.
   */
  async resolve(userId: string, input: SkillLinkResolveInput): Promise<SkillLinkResolution> {
    let origin: string | null = null
    try {
      return await resolveLink(userId, input, (reached) => {
        origin = reached
      })
    } catch (err) {
      logger.error('skill link could not be resolved', { error: err instanceof Error ? err.message : String(err) })
      const known = origin as string | null
      if (known !== null && isReauth(err)) {
        broadcastReauthRequired(RESOLVE_CHANNEL)
        return { state: 'reauth_required', host: hostOf(known), origin: known }
      }
      return known === null ? { state: 'not_connected', host: null, origin: null } : { state: 'offline', host: hostOf(known), origin: known }
    }
  },

  /**
   * The origin Copy install link names for the active profile: its server's
   * web app (`web_origin`), where a browser can open `/get/skill/…`, else
   * the stored origin; null with no Cinna profile active. `fromDiscovery`
   * false is a fallback (discovery failed or timed out) the renderer asks
   * again for later. Never throws.
   */
  async installOrigin(): Promise<{ origin: string | null; fromDiscovery: boolean }> {
    try {
      const user = userRepo.list().find((row) => row.id === getProfileScopeUserId())
      if (!user || user.type !== 'cinna_user' || !user.cinnaServerUrl) return { origin: null, fromDiscovery: false }
      return await webOriginOf(user.cinnaServerUrl)
    } catch (err) {
      logger.warn('install link origin could not be read', { error: err instanceof Error ? err.message : String(err) })
      return { origin: null, fromDiscovery: false }
    }
  }
}
