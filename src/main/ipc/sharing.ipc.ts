import { userActivation } from '../auth/activation'
import { acpProcessPool } from '../agents/drivers'
import { getSettingsScopeUserId } from '../auth/scope'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { DomainError } from '../errors'
import { createLogger } from '../logger/logger'
import { sharingService } from '../services/localAgents/sharingService'
import { REAUTH_REQUIRED_CODE } from '../../shared/cinnaErrors'
import type { SharingOutcome } from '../../shared/agentSharing'
import { ipcHandle } from './_wrap'

const logger = createLogger('sharing-ipc')

/**
 * Run a sharing call and answer a {@link SharingOutcome}.
 *
 * Refusals already travel inside `value`. What lands here is what the surface
 * cannot show as a state: an expired Cinna session — raw, or normalised by
 * `cinnaFetch` into a `CinnaApiError('reauth_required')` — which `_wrap` turns
 * into the app-wide re-auth prompt, and a coded `DomainError` such as
 * `not_found` for an agent that is gone. Anything else still throws, so
 * `_wrap` logs it as the unexpected error it is. The `catalog.ipc.ts` pattern.
 */
async function outcome<T>(channel: string, run: () => Promise<T> | T): Promise<SharingOutcome<T>> {
  try {
    return { success: true, value: await run() }
  } catch (err) {
    if (err instanceof CinnaReauthRequired) {
      logger.warn(`${channel} needs re-authentication`)
      return { success: false, code: REAUTH_REQUIRED_CODE, message: err.message }
    }
    if (err instanceof DomainError) {
      logger.warn(`${channel} failed`, { code: err.code, message: err.message })
      return { success: false, code: err.code, message: err.message }
    }
    throw err
  }
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * Team sharing of folder agents. Thin: activation gate, scope, delegate.
 *
 * Folder agents live in the settings scope like every other `local-agent:*`
 * channel; the Cinna profile whose token and library are used is the active
 * one, which the service reads itself. Only ids cross — the service resolves
 * every folder through the agent index.
 */
export function registerSharingHandlers(): void {
  ipcHandle('sharing:statuses', () => {
    userActivation.requireActivated()
    return outcome('sharing:statuses', () => sharingService.statuses(getSettingsScopeUserId()))
  })

  ipcHandle('sharing:status', (_event, input?: { agentId?: unknown; fetch?: unknown }) => {
    userActivation.requireActivated()
    return outcome('sharing:status', () =>
      sharingService.status(getSettingsScopeUserId(), str(input?.agentId), input?.fetch === true)
    )
  })

  ipcHandle('sharing:draft-message', (_event, input?: { agentId?: unknown }) => {
    userActivation.requireActivated()
    return outcome('sharing:draft-message', () =>
      sharingService.draftMessage(getSettingsScopeUserId(), str(input?.agentId))
    )
  })

  ipcHandle('sharing:share-changes', (_event, input?: { agentId?: unknown; message?: unknown }) => {
    userActivation.requireActivated()
    return outcome('sharing:share-changes', () =>
      sharingService.shareChanges(getSettingsScopeUserId(), str(input?.agentId), str(input?.message))
    )
  })

  ipcHandle('sharing:update', (_event, input?: { agentId?: unknown }) => {
    userActivation.requireActivated()
    return outcome('sharing:update', () =>
      sharingService.update(getSettingsScopeUserId(), str(input?.agentId))
    )
  })

  ipcHandle('sharing:use-team-version', async (_event, input?: { agentId?: unknown }) => {
    userActivation.requireActivated()
    const agentId = str(input?.agentId)
    const answer = await outcome('sharing:use-team-version', () =>
      sharingService.useTeamVersion(getSettingsScopeUserId(), agentId)
    )
    /**
     * A warm process for this agent has its working directory in the folder
     * that was just renamed to `<slug>-mine` — it would answer the next turn
     * from the kept copy, not the team version now at the agent's path.
     * Retired like `local-agent:delete` does, so a streaming turn finishes
     * first. `sharing:update` does not: like `local-agent:git-update` it
     * changes files in place, and every turn reads them afresh.
     */
    if (answer.success && answer.value.done) acpProcessPool.retire(agentId)
    return answer
  })

  ipcHandle('sharing:share-with-team-draft', (_event, input?: { agentId?: unknown }) => {
    userActivation.requireActivated()
    return outcome('sharing:share-with-team-draft', () =>
      sharingService.shareWithTeamDraft(getSettingsScopeUserId(), str(input?.agentId))
    )
  })

  ipcHandle(
    'sharing:share-with-team',
    (_event, input?: { agentId?: unknown; name?: unknown; people?: unknown }) => {
      userActivation.requireActivated()
      return outcome('sharing:share-with-team', () =>
        sharingService.shareWithTeam(getSettingsScopeUserId(), str(input?.agentId), {
          name: input?.name,
          people: input?.people
        })
      )
    }
  )

  ipcHandle('sharing:people', (_event, input?: { agentId?: unknown }) => {
    userActivation.requireActivated()
    return outcome('sharing:people', () => sharingService.people(getSettingsScopeUserId(), str(input?.agentId)))
  })

  ipcHandle('sharing:set-people', (_event, input?: { agentId?: unknown; people?: unknown }) => {
    userActivation.requireActivated()
    return outcome('sharing:set-people', () =>
      sharingService.setPeople(getSettingsScopeUserId(), str(input?.agentId), input?.people)
    )
  })

  ipcHandle('sharing:search-people', (_event, input?: { query?: unknown }) => {
    userActivation.requireActivated()
    return outcome('sharing:search-people', () => sharingService.searchPeople(input?.query))
  })

  ipcHandle('sharing:history', (_event, input?: { agentId?: unknown }) => {
    userActivation.requireActivated()
    return outcome('sharing:history', () => sharingService.history(getSettingsScopeUserId(), str(input?.agentId)))
  })

  ipcHandle('sharing:unshare', (_event, input?: { agentId?: unknown; deleteFromLibrary?: unknown }) => {
    userActivation.requireActivated()
    return outcome('sharing:unshare', () =>
      sharingService.unshare(getSettingsScopeUserId(), str(input?.agentId), input?.deleteFromLibrary === true)
    )
  })

  ipcHandle('sharing:library', (_event, input?: { refresh?: unknown }) => {
    userActivation.requireActivated()
    return outcome('sharing:library', () =>
      sharingService.library(getSettingsScopeUserId(), input?.refresh === true)
    )
  })

  ipcHandle('sharing:get', (_event, input?: { repoId?: unknown }) => {
    userActivation.requireActivated()
    return outcome('sharing:get', () => sharingService.get(getSettingsScopeUserId(), str(input?.repoId)))
  })
}
