import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { improvementRequestService } from '../services/improvementRequestService'
import type {
  ImprovementContext,
  ImprovementOutcome,
  ImprovementRequestCreated,
  ImprovementTarget
} from '../../shared/improvementRequests'
import { ipcHandle } from './_wrap'

/**
 * Improvement Request (send a cloud conversation with a bundle agent to its
 * publisher). Thin: activation gate, the active profile, delegate. The
 * renderer names `{chatId, agentId}` only — main finds the core session id
 * itself — and every answer, refusals included, is data
 * (`src/shared/improvementRequests.ts`).
 */
export function registerImprovementRequestHandlers(): void {
  ipcHandle('improvement:targets', (_event, chatId: unknown): ImprovementTarget[] => {
    userActivation.requireActivated()
    return improvementRequestService.listTargets(getProfileScopeUserId(), chatId)
  })

  ipcHandle('improvement:context', (_event, input?: { chatId?: unknown; agentId?: unknown }): Promise<ImprovementOutcome<{ context: ImprovementContext }>> => {
    userActivation.requireActivated()
    return improvementRequestService.context(getProfileScopeUserId(), input?.chatId, input?.agentId)
  })

  ipcHandle('improvement:create', (_event, input?: { chatId?: unknown; agentId?: unknown; comment?: unknown; includeMemory?: unknown }): Promise<ImprovementOutcome<{ request: ImprovementRequestCreated }>> => {
    userActivation.requireActivated()
    return improvementRequestService.create(getProfileScopeUserId(), input?.chatId, input?.agentId, {
      comment: input?.comment,
      includeMemory: input?.includeMemory
    })
  })
}
