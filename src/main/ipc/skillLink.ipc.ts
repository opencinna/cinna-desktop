import { userActivation } from '../auth/activation'
import { getSettingsScopeUserId } from '../auth/scope'
import { skillLinkIntentService } from '../host/desktop/skillLinkIntentService'
import { skillLinkService } from '../services/skillLinkService'
import type { SkillLinkIntent, SkillLinkResolution } from '../../shared/skillLink'
import { ipcHandle } from './_wrap'

/**
 * Skill links: the buffered `cinna://skill/…` deep link, and what a link
 * offers on the composer's agent.
 *
 * `get-pending` and `consume` are ungated, like `connect:*`: they hand back a
 * package id and an origin the user's own click just supplied, and nothing
 * else. `resolve` reads the catalog and the person's agents, so it is behind
 * `userActivation.requireActivated()`, in the settings scope where folder
 * agents live (`catalogSkills.ipc.ts`). Its every answer is data.
 */
export function registerSkillLinkHandlers(): void {
  ipcHandle('skill-link:get-pending', async (): Promise<SkillLinkIntent | null> => skillLinkIntentService.getPending())

  ipcHandle('skill-link:consume', async (_e, receivedAt?: unknown): Promise<{ success: true }> => {
    skillLinkIntentService.consume(typeof receivedAt === 'number' ? receivedAt : undefined)
    return { success: true }
  })

  ipcHandle(
    'skill-link:resolve',
    (_event, input?: { origin?: unknown; packageId?: unknown; agentId?: unknown }): Promise<SkillLinkResolution> => {
      userActivation.requireActivated()
      return skillLinkService.resolve(getSettingsScopeUserId(), {
        origin: typeof input?.origin === 'string' ? input.origin : null,
        packageId: typeof input?.packageId === 'string' ? input.packageId : '',
        agentId: typeof input?.agentId === 'string' && input.agentId !== '' ? input.agentId : null
      })
    }
  )
}
