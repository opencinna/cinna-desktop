import { chatRepo } from '../db/chats'
import { inboxService } from '../services/inboxService'
import { a2aSessionRepo } from '../db/agents'
import { type ProtocolResolution } from '../agents/a2a-client'
import { agentService } from '../services/agentService'
import { a2aStreamingService } from '../services/a2aStreamingService'
import { pendingRequests } from '../agents/drivers/pendingRequests'
import { parseAnswerPayload } from '../services/askDelivery'
import type { AskAnswerPayload, InboxAnswerResult } from '../../shared/inbox'
import { userActivation } from '../auth/activation'
import { getProfileScopeUserId, getSettingsScopeUserId } from '../auth/scope'
import { AgentError, ipcErrorShape } from '../errors'
import { createLogger } from '../logger/logger'
import { ipcHandle } from './_wrap'
import type { CliCommand } from '../../shared/cliCommands'

const logger = createLogger('A2A')

export function registerA2AHandlers(): void {
  // Fetch agent card from URL (for testing / adding a new agent)
  ipcHandle(
    'agent:fetch-card',
    async (
      _event,
      data: { cardUrl: string; accessToken?: string }
    ): Promise<{
      success: boolean
      card?: Record<string, unknown>
      protocol?: ProtocolResolution
      error?: string
    }> => {
      userActivation.requireActivated()
      logger.debug(`Fetching card from ${data.cardUrl}`)
      try {
        const { card, protocol } = await agentService.fetchCardPreview(data)
        logger.info(`Card fetched, protocol ${protocol.version} at ${protocol.url}`)
        return { success: true, card: card as unknown as Record<string, unknown>, protocol }
      } catch (err) {
        logger.error(`Card fetch failed for ${data.cardUrl}`, {
          error: String(err),
          stack: err instanceof Error ? err.stack : undefined
        })
        return { success: false, error: String(err) }
      }
    }
  )

  // Test connection to a saved agent
  ipcHandle(
    'agent:test',
    async (
      _event,
      agentId: string
    ): Promise<{
      success: boolean
      card?: Record<string, unknown>
      error?: string
    }> => {
      userActivation.requireActivated()
      try {
        const located = agentService.findAgent(
          getSettingsScopeUserId(),
          getProfileScopeUserId(),
          agentId
        )
        if (!located) throw new AgentError('not_found', 'Agent not found')
        const { card } = await agentService.testAgent(located.userId, agentId)
        return { success: true, card: card as unknown as Record<string, unknown> }
      } catch (err) {
        const e = ipcErrorShape(err)
        logger.error(`Test failed for agent ${agentId}`, {
          error: e.message,
          stack: err instanceof Error ? err.stack : undefined
        })
        return { success: false, error: e.message }
      }
    }
  )

  // Fetch CLI commands exposed by a saved agent (cinna.run.* skills)
  ipcHandle(
    'agent:list-cli-commands',
    async (
      _event,
      agentId: string
    ): Promise<{ success: boolean; commands: CliCommand[]; error?: string }> => {
      userActivation.requireActivated()
      try {
        const located = agentService.findAgent(
          getSettingsScopeUserId(),
          getProfileScopeUserId(),
          agentId
        )
        if (!located) throw new AgentError('not_found', 'Agent not found')
        const commands = await agentService.listCliCommands(located.userId, agentId)
        return { success: true, commands }
      } catch (err) {
        const e = ipcErrorShape(err)
        // Network-family errors on this low-stakes fetch are expected during
        // brief backend outages; keep them at debug so the logger overlay
        // doesn't flood. Domain errors (ownership, session) stay at warn.
        const isTransient =
          /ECONN(REFUSED|RESET)|ENOTFOUND|ETIMEDOUT|terminated|socket hang up|Could not reach|timed out|closed/i.test(
            e.message
          )
        const log = isTransient ? logger.debug : logger.warn
        log(`CLI commands fetch failed for agent ${agentId}`, { error: e.message })
        return { success: false, commands: [], error: e.message }
      }
    }
  )

  // Look up the A2A session for a chat (used by renderer to detect agent chats)
  ipcHandle('agent:get-session', async (_event, chatId: string) => {
    userActivation.requireActivated()
    if (!chatRepo.getOwned(getProfileScopeUserId(), chatId)) return null
    return a2aSessionRepo.getByChat(chatId) ?? null
  })

  ipcHandle('agent:cancel-message', async (_event, requestId: string) => {
    a2aStreamingService.cancel(requestId)
    return { success: true }
  })

  /**
   * Answer a permission or question a local agent is parked on.
   *
   * These arrive **out of band** rather than down the turn's MessagePort. The
   * turn is still streaming when the answer is needed, and the port belongs to
   * a direct chat — a driver's `run` is port-free by design and orchestrated
   * mode has no port at all — so routing the answer through a registry keyed by
   * the engine's own request id is what lets both modes use one path.
   *
   * The result is returned **as data, never thrown**: `ipcMain.handle`
   * serialises a rejection to message + stack and `contextBridge` re-clones it,
   * so a renderer guard testing `err.code` silently never fires (see
   * `src/main/ipc/_wrap.ts`).
   */
  ipcHandle(
    'agent:answer-request',
    async (
      _event,
      data: AskAnswerPayload
    ): Promise<InboxAnswerResult> => {
      userActivation.requireActivated()

      const parsed = parseAnswerPayload(data)
      if (!parsed) {
        logger.warn('an answer was rejected as malformed', { requestId: data.requestId })
        return { ok: false, reason: 'Malformed answer', code: 'malformed' }
      }

      // Ownership, the kind check and the driver call live in `askDelivery`,
      // because the inbox answers the same ask with the chat closed and the two
      // must not drift — above all on what *Always allow* means.
      const userId = getProfileScopeUserId()
      return inboxService.answerFromTranscript(userId, data.requestId, parsed)
    }
  )

  /** What a chat is currently blocked on, so a reload can re-open the prompt. */
  ipcHandle('agent:pending-requests', async (_event, chatId: string) => {
    userActivation.requireActivated()
    if (!chatRepo.getOwned(getProfileScopeUserId(), chatId)) return []
    return pendingRequests.listForChat(chatId)
  })
}
