import { ipcMain } from 'electron'
import { messageRepo } from '../db/messages'
import { chatRepo } from '../db/chats'
import { a2aSessionRepo } from '../db/agents'
import { type ProtocolResolution } from '../agents/a2a-client'
import { agentService } from '../services/agentService'
import { messageRoutingService } from '../services/messageRoutingService'
import { a2aStreamingService } from '../services/a2aStreamingService'
import { userActivation } from '../auth/activation'
import { getProfileScopeUserId, getSettingsScopeUserId } from '../auth/scope'
import { AgentError, ipcErrorShape } from '../errors'
import { createLogger } from '../logger/logger'
import { ipcHandle } from './_wrap'
import type { CliCommand } from '../../shared/cliCommands'
import type { AgentSendPayload } from '../../shared/ipcPayloads'

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

  // Stream a message to an A2A agent via MessagePort. Thin controller: extract
  // params, auth/ownership/endpoint resolution, then hand off to the routing
  // service (persistence + cursor advance) and the streaming service (A2A pump).
  ipcMain.on(
    'agent:send-message',
    async (event, payload: AgentSendPayload) => {
      const {
        agentId,
        chatId,
        content: userContent,
        catchupPacket = '',
        rewrittenText = null,
        originalText = null
      } = payload
      const port = event.ports?.[0]
      if (!port) return

      if (!userActivation.isActivated()) {
        logger.error('send-message rejected: session not activated', { agentId, chatId })
        port.start()
        port.postMessage({ type: 'error', error: 'Session not activated — user must authenticate first' })
        port.close()
        return
      }

      port.start()

      const profileUserId = getProfileScopeUserId()

      if (!chatRepo.getOwned(profileUserId, chatId)) {
        const err = 'Chat not found'
        logger.error(err, { agentId, chatId })
        port.postMessage({ type: 'error', error: err })
        port.close()
        return
      }

      const located = agentService.findAgent(getSettingsScopeUserId(), profileUserId, agentId)
      const agent = located?.row
      if (!located || !agent || !agent.cardUrl) {
        const err = 'Agent not found or not configured'
        logger.error(err, { agentId, chatId, hasAgent: !!agent, cardUrl: agent?.cardUrl })
        port.postMessage({ type: 'error', error: err })
        messageRepo.saveError({ chatId, short: err })
        port.close()
        return
      }
      const agentOwnerId = located.userId

      let endpointUrl: string
      try {
        endpointUrl = await agentService.resolveEndpointIfNeeded(agentOwnerId, agent)
      } catch (err) {
        const errMsg =
          err instanceof AgentError
            ? err.message
            : `Failed to resolve agent endpoint: ${String(err)}`
        logger.error(errMsg, { agentId, cardUrl: agent.cardUrl })
        port.postMessage({ type: 'error', error: errMsg })
        messageRepo.saveError({ chatId, short: errMsg })
        port.close()
        return
      }

      // Persist user message + advance catch-up cursor + assemble wire content
      // in one place. Service throws ChatError on ownership mismatch (already
      // re-checked above; this is defense-in-depth).
      const { wireContent } = messageRoutingService.prepareAgentSend({
        userId: profileUserId,
        chatId,
        agentId,
        userContent,
        rewrittenText,
        originalText,
        catchupPacket
      })

      let accessToken: string | undefined
      try {
        accessToken = await agentService.resolveAccessToken(agentOwnerId, agent)
      } catch (err) {
        const errMsg = `Failed to resolve agent access token: ${String(err)}`
        logger.error(errMsg, { agentId })
        port.postMessage({ type: 'error', error: errMsg })
        messageRepo.saveError({ chatId, short: errMsg })
        port.close()
        return
      }

      await a2aStreamingService.streamToAgent({
        chatId,
        agentId,
        agentName: agent.name,
        endpointUrl,
        cardUrl: agent.cardUrl,
        accessToken,
        wireContent,
        port
      })
    }
  )

  ipcHandle('agent:cancel-message', async (_event, requestId: string) => {
    a2aStreamingService.cancel(requestId)
    return { success: true }
  })
}
