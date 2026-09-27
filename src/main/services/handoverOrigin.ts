import { delegationRepo } from '../db/delegations'
import { chatOwnerFor } from '../auth/chatScope'
import { chatAnswersToAgent } from './chatRouting'
import { DEFAULT_USER_ID } from '../../shared/userIds'
import type { HandoverBrief } from '../../shared/handovers'

/**
 * The profile a found handover belongs to, or null when its origin does not
 * validate. A folder is visible to every profile, so only this profile may
 * take it in and pay for it.
 *
 * The origin chat's owner is the answer, except for a chat the default
 * profile shares with the active one (`auth/chatScope.ts`): that handover is
 * the active profile's, like a task or delegation started from a shared chat,
 * so its rows are keyed to the profile and it is not dropped as foreign.
 */
export function handoverOriginProfile(brief: HandoverBrief, activeProfile: string): string | null {
  const chatId = brief.origin?.chatId
  let profile = delegationRepo.originProfile(chatId, brief.origin?.taskId)
  if (!profile) return null
  if (chatId && profile === DEFAULT_USER_ID && activeProfile !== DEFAULT_USER_ID &&
    chatOwnerFor(activeProfile, chatId) === DEFAULT_USER_ID) profile = activeProfile
  if (chatId && brief.origin?.agentId && chatAnswersToAgent(profile, chatId, brief.origin.agentId) === null) return profile
  if (!chatId && brief.origin?.taskId) return profile
  return null
}
