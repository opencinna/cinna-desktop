/**
 * Pinned skills that are not on this computer yet — a catalog or marketplace
 * pin copied into `cinna-agent.json` by hand, a restored folder, a pull from
 * outside Cinna — are fetched in the background without anyone clicking
 * Try again: when an agent's skills are built for a session (the skills
 * plugin, or the prompt's skill listing) and whenever a profile becomes ready.
 *
 * **One attempt per pin per profile activation.** A pin is keyed by agent,
 * kind and what it pins (catalog `uuid/revision/name`, marketplace
 * `entry/sha/name`); once tried, a turn never asks again, and a turn only
 * asks for a pin that is `not_downloaded`, so a pin that fails
 * (`download_failed`) is not retried on every turn. When a profile becomes
 * ready (a sign-in, a profile switch, renewed credentials) the guard is
 * forgotten and that sweep ({@link pinnedSkillAutoFetch.retryAllMissing})
 * also retries the pins whose last download failed — a `reauth_required`
 * failure is fixed by exactly that. The row's Try again goes straight to the
 * service's `ensurePinned` and always runs. Nothing is tried, and nothing is
 * marked tried, without a Cinna account: a later sign-in still fetches.
 *
 * The services' `ensurePinnedInBackground` does the work, with their own
 * in-flight dedupe, and tells the scanner and the renderer when it is done
 * (`settle`), so the row updates. Never awaited, never throws.
 *
 * Core: no Electron. The services are loaded on use: they import the agent
 * index, which imports what builds the plugin that calls this.
 */

import { getProfileScopeUserId, getSettingsScopeUserId } from '../auth/scope'
import { createLogger } from '../logger/logger'
import { libraryService } from './libraryService'
import type { LocalAgentSkill } from '../../shared/localAgents'

const logger = createLogger('pinned-skill-auto-fetch')

/** Pins already tried this app session. */
const tried = new Set<string>()

/** What a missing pin names, as the guard keys it; null for a row that is not a pin. */
function pinKey(agentId: string, skill: LocalAgentSkill): string | null {
  if (skill.source === 'catalog') {
    return `${agentId}|catalog|${(skill.packageUuid ?? '').toLowerCase()}/${skill.revisionNumber ?? ''}/${skill.name}`
  }
  if (skill.source === 'marketplace') {
    return `${agentId}|marketplace|${(skill.entryUuid ?? '').toLowerCase()}/${(skill.archiveSha256 ?? '').toLowerCase()}/${skill.name}`
  }
  return null
}

/**
 * A pin row whose copy is simply not here yet; with `retryFailed`, also one
 * whose last download failed this session.
 */
function missing(skill: LocalAgentSkill, retryFailed: boolean): boolean {
  return skill.issues.some((issue) => issue.code === 'not_downloaded' || (retryFailed && issue.code === 'download_failed'))
}

/** Whether the active profile is a Cinna account: without one, nothing is tried or marked. */
function hasAccount(): boolean {
  try {
    return libraryService.hostOf(getProfileScopeUserId()) !== null
  } catch {
    return false
  }
}

export const pinnedSkillAutoFetch = {
  /**
   * Fetch, in the background, the agent's pinned skills that are not on this
   * computer and were not tried yet this session. `skills` are the agent's
   * skill rows as resolved against the caches (`agentSkillRows`). Only
   * `not_downloaded` rows, unless `retryFailed` (the profile-ready sweep).
   * Answers which kinds were started, for tests.
   */
  fetchMissing(
    agentId: string,
    skills: readonly LocalAgentSkill[] | undefined,
    retryFailed = false
  ): { catalog: boolean; marketplace: boolean } {
    const started = { catalog: false, marketplace: false }
    try {
      const fresh = (skills ?? []).filter((skill) => {
        if (!missing(skill, retryFailed)) return false
        const key = pinKey(agentId, skill)
        return key !== null && !tried.has(key)
      })
      if (fresh.length === 0 || !hasAccount()) return started
      for (const skill of fresh) tried.add(pinKey(agentId, skill)!)
      started.catalog = fresh.some((skill) => skill.source === 'catalog')
      started.marketplace = fresh.some((skill) => skill.source === 'marketplace')
      const userId = getSettingsScopeUserId()
      logger.info('fetching pinned skills not on this computer', { agentId, count: fresh.length })
      if (started.catalog) {
        void import('./catalogSkillService')
          .then(({ catalogSkillService }) => catalogSkillService.ensurePinnedInBackground(userId, agentId))
          .catch((err) => logger.warn('catalog skills could not be fetched', { agentId, error: String(err) }))
      }
      if (started.marketplace) {
        void import('./marketplaceSkillService')
          .then(({ marketplaceSkillService }) => marketplaceSkillService.ensurePinnedInBackground(userId, agentId))
          .catch((err) => logger.warn('marketplace skills could not be fetched', { agentId, error: String(err) }))
      }
    } catch (err) {
      logger.warn('missing pinned skills could not be checked', { agentId, error: err instanceof Error ? err.message : String(err) })
    }
    return started
  },

  /**
   * {@link fetchMissing} for every kit agent the agents list scans (cached),
   * through {@link retryAllMissing} when a profile becomes ready. Background only.
   */
  fetchAllMissing(retryFailed = false): void {
    if (!hasAccount()) return
    void (async () => {
      const [{ agentRootRepo }, { scannerService }] = await Promise.all([
        import('../db/agentRoots'),
        import('./localAgents/scannerService')
      ])
      const userId = getSettingsScopeUserId()
      for (const root of agentRootRepo.list(userId)) {
        for (const agent of scannerService.scanRootCached(userId, root).agents) {
          if (agent.skills) pinnedSkillAutoFetch.fetchMissing(agent.id, agent.skills, retryFailed)
        }
      }
    })().catch((err) => logger.warn('missing pinned skills could not be listed', { error: String(err) }))
  },

  /**
   * When a profile becomes ready: forget what was tried, then sweep every
   * agent again, this time including the pins whose last download failed —
   * a failure for a lapsed sign-in (`reauth_required`) is what a renewed
   * session fixes. Background only.
   */
  retryAllMissing(): void {
    tried.clear()
    pinnedSkillAutoFetch.fetchAllMissing(true)
  },

  /** Tests: forget what was tried. */
  _reset(): void {
    tried.clear()
  }
}
