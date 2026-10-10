import { userActivation } from '../auth/activation'
import { getSettingsScopeUserId } from '../auth/scope'
import { skillPublishService } from '../services/skillPublishService'
import type {
  SkillPublishInput,
  SkillPublishOutcome,
  SkillPublishPerson,
  SkillPublisherCredential,
  SkillPublishPreviewOutcome
} from '../../shared/skillPublish'
import { ipcHandle } from './_wrap'

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * Sharing a kit agent's own skill to the catalog: preview, then publish.
 * Thin: activation gate, scope, delegate. Folder agents live in the settings
 * scope like every `local-agent:*` channel; the service reads the active Cinna
 * profile itself. Only ids, names and the person's choices cross, and every
 * answer — refusals included — is data (`src/shared/skillPublish.ts`).
 */
export function registerSkillPublishHandlers(): void {
  ipcHandle('skill-publish:preview', (_event, input?: { agentId?: unknown; name?: unknown }): Promise<SkillPublishPreviewOutcome> => {
    userActivation.requireActivated()
    return skillPublishService.preview(getSettingsScopeUserId(), str(input?.agentId), str(input?.name))
  })

  ipcHandle('skill-publish:publish', (_event, input?: Partial<Record<keyof SkillPublishInput, unknown>>): Promise<SkillPublishOutcome> => {
    userActivation.requireActivated()
    return skillPublishService.publish(getSettingsScopeUserId(), {
      agentId: str(input?.agentId),
      name: str(input?.name),
      releaseNotes: str(input?.releaseNotes),
      // Checked field by field in the service.
      people: Array.isArray(input?.people) ? (input.people as SkillPublishPerson[]) : [],
      everyone: input?.everyone === true,
      publisherCredentials: Array.isArray(input?.publisherCredentials) ? (input.publisherCredentials as SkillPublisherCredential[]) : []
    })
  })
}
