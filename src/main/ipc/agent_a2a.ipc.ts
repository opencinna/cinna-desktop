import { ipcMain } from 'electron'
import { nanoid } from 'nanoid'
import { messageRepo } from '../db/messages'
import { chatRepo } from '../db/chats'
import { a2aSessionRepo, agentRepo } from '../db/agents'
import {
  createA2AClient,
  buildSendParams,
  extractTextFromResult,
  type ProtocolResolution
} from '../agents/a2a-client'
import { agentService } from '../services/agentService'
import { userActivation } from '../auth/activation'
import { getCurrentUserId } from '../auth/session'
import { AgentError, ipcErrorShape } from '../errors'
import { createLogger } from '../logger/logger'
import { ipcHandle } from './_wrap'

const logger = createLogger('A2A')

const activeAbortControllers = new Map<string, AbortController>()

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
      const userId = getCurrentUserId()
      try {
        const { card } = await agentService.testAgent(userId, agentId)
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

  // Look up the A2A session for a chat (used by renderer to detect agent chats)
  ipcHandle('agent:get-session', async (_event, chatId: string) => {
    userActivation.requireActivated()
    const userId = getCurrentUserId()
    if (!chatRepo.getOwned(userId, chatId)) return null
    return a2aSessionRepo.getByChat(chatId) ?? null
  })

  // Stream a message to an A2A agent via MessagePort
  ipcMain.on('agent:send-message', async (event, message: [string, string, string]) => {
    const [agentId, chatId, userContent] = message
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

    const userId = getCurrentUserId()

    if (!chatRepo.getOwned(userId, chatId)) {
      const err = 'Chat not found'
      logger.error(err, { agentId, chatId })
      port.postMessage({ type: 'error', error: err })
      port.close()
      return
    }

    const agent = agentRepo.getOwned(userId, agentId)
    if (!agent || !agent.cardUrl) {
      const err = 'Agent not found or not configured'
      logger.error(err, { agentId, chatId, hasAgent: !!agent, cardUrl: agent?.cardUrl })
      port.postMessage({ type: 'error', error: err })
      messageRepo.saveError({ chatId, short: err })
      port.close()
      return
    }

    let endpointUrl: string
    try {
      endpointUrl = await agentService.resolveEndpointIfNeeded(userId, agent)
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

    const abortController = new AbortController()
    const requestId = nanoid()
    activeAbortControllers.set(requestId, abortController)
    port.postMessage({ type: 'request-id', requestId })

    messageRepo.saveUser({ chatId, content: userContent })

    try {
      const accessToken = await agentService.resolveAccessToken(userId, agent)

      const client = await createA2AClient(endpointUrl, agent.cardUrl, accessToken)
      const card = await client.getAgentCard()
      const supportsStreaming = card.capabilities?.streaming === true

      logger.info(`Agent "${agent.name}" | endpoint: ${endpointUrl}`, {
        streaming: supportsStreaming
      })

      const session = a2aSessionRepo.getByChatAndAgent(chatId, agentId)
      const sessionContextId = session?.contextId ?? undefined
      const sessionTaskId = session?.taskId ?? undefined

      logger.debug(
        session ? 'Resumed session' : 'New session',
        session ? { contextId: sessionContextId, taskId: sessionTaskId } : undefined
      )

      let latestContextId = sessionContextId
      let latestTaskId = sessionTaskId
      let latestTaskState: string | undefined

      if (supportsStreaming) {
        const params = buildSendParams(userContent, sessionContextId, sessionTaskId)
        logger.debug('Sending streaming message', params)
        let fullText = ''

        for await (const event of client.sendMessageStream(params)) {
          if (abortController.signal.aborted) break

          const text = extractTextFromResult(event)
          if (text) {
            const delta = text.slice(fullText.length)
            if (delta) {
              fullText = text
              port.postMessage({ type: 'delta', text: delta })
            }
          }

          if ('kind' in event) {
            if (event.kind === 'status-update') {
              const su = event as { status: { state: string }; taskId: string; contextId: string }
              latestContextId = su.contextId
              latestTaskId = su.taskId
              latestTaskState = su.status.state
              port.postMessage({
                type: 'status',
                state: su.status.state,
                taskId: su.taskId,
                contextId: su.contextId
              })
            } else if (event.kind === 'artifact-update') {
              const au = event as { contextId: string; taskId?: string }
              if (au.contextId) latestContextId = au.contextId
            } else if (event.kind === 'task') {
              const t = event as { id: string; contextId: string; status?: { state: string } }
              latestContextId = t.contextId
              latestTaskId = t.id
              if (t.status?.state) latestTaskState = t.status.state
            } else if (event.kind === 'message') {
              const m = event as { contextId?: string; taskId?: string }
              if (m.contextId) latestContextId = m.contextId
              if (m.taskId) latestTaskId = m.taskId
            }
          }
        }

        if (fullText) {
          messageRepo.saveAssistant({ chatId, content: fullText })
        }
      } else {
        const params = buildSendParams(userContent, sessionContextId, sessionTaskId)
        const result = await client.sendMessage(params)
        const responseJson = result as unknown as Record<string, unknown>

        const rpcResult = (responseJson.result ?? responseJson) as Record<string, unknown>
        let fullText = ''

        if (rpcResult.task) {
          const task = rpcResult.task as {
            id?: string
            contextId?: string
            status?: { state: string }
          }
          if (task.contextId) latestContextId = task.contextId
          if (task.id) latestTaskId = task.id
          if (task.status?.state) latestTaskState = task.status.state
          fullText = extractTextFromResult({ kind: 'task', ...(rpcResult.task as object) } as never)
        } else if (rpcResult.message) {
          const msg = rpcResult.message as { contextId?: string; taskId?: string }
          if (msg.contextId) latestContextId = msg.contextId
          if (msg.taskId) latestTaskId = msg.taskId
          fullText = extractTextFromResult({
            kind: 'message',
            ...(rpcResult.message as object)
          } as never)
        } else {
          const top = rpcResult as {
            id?: string
            contextId?: string
            taskId?: string
            status?: { state: string }
          }
          if (top.contextId) latestContextId = top.contextId
          if (top.id && rpcResult.kind === 'task') latestTaskId = top.id
          if (top.taskId) latestTaskId = top.taskId
          if (top.status?.state) latestTaskState = top.status.state
          fullText = extractTextFromResult(rpcResult as never)
        }

        if (fullText) {
          port.postMessage({ type: 'delta', text: fullText })
          messageRepo.saveAssistant({ chatId, content: fullText })
        }
      }

      a2aSessionRepo.upsert({
        chatId,
        agentId,
        contextId: latestContextId ?? session?.contextId ?? null,
        taskId: latestTaskId ?? session?.taskId ?? null,
        taskState: latestTaskState ?? session?.taskState ?? null
      })
      logger.debug('Session saved', {
        contextId: latestContextId,
        taskId: latestTaskId,
        state: latestTaskState
      })

      messageRepo.touchChat(chatId)

      port.postMessage({ type: 'done' })
    } catch (err) {
      if (!abortController.signal.aborted) {
        const errorStr = String(err)
        logger.error('send-message failed', {
          agentId,
          chatId,
          error: errorStr,
          stack: err instanceof Error ? err.stack : undefined
        })
        port.postMessage({ type: 'error', error: errorStr })
        messageRepo.saveError({ chatId, short: errorStr })
      }
    } finally {
      port.close()
      activeAbortControllers.delete(requestId)
    }
  })

  ipcHandle('agent:cancel-message', async (_event, requestId: string) => {
    const controller = activeAbortControllers.get(requestId)
    if (controller) {
      controller.abort()
      activeAbortControllers.delete(requestId)
    }
    return { success: true }
  })
}
