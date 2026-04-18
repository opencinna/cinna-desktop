import { ipcMain } from 'electron'
import { nanoid } from 'nanoid'
import { eq, and } from 'drizzle-orm'
import { getDb } from '../db/client'
import { agents, a2aSessions } from '../db/schema'
import { messageRepo } from '../db/messages'
import { chatRepo } from '../db/chats'
import { decryptApiKey } from '../security/keystore'
import {
  fetchAgentCard,
  createA2AClient,
  buildSendParams,
  extractTextFromResult,
  type ProtocolResolution
} from '../agents/a2a-client'
import { userActivation } from '../auth/activation'
import { getCurrentUserId } from '../auth/session'
import { getCinnaAccessToken } from '../auth/cinna-tokens'
import { createLogger } from '../logger/logger'

const logger = createLogger('A2A')

const activeAbortControllers = new Map<string, AbortController>()

/**
 * Resolve the access token for an agent.
 * Remote agents use the user's Cinna JWT; local agents use their stored token.
 */
async function resolveAgentAccessToken(
  agent: { source: string; accessTokenEncrypted: Buffer | null }
): Promise<string | undefined> {
  if (agent.source === 'remote') {
    const userId = getCurrentUserId()
    try {
      return await getCinnaAccessToken(userId)
    } catch {
      throw new Error('Cinna session expired — please re-authenticate')
    }
  }
  return agent.accessTokenEncrypted ? decryptApiKey(agent.accessTokenEncrypted) : undefined
}

export function registerA2AHandlers(): void {
  // Fetch agent card from URL (for testing / adding a new agent)
  ipcMain.handle(
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
        const { card, protocol } = await fetchAgentCard(data.cardUrl, data.accessToken)
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
  ipcMain.handle(
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
      const db = getDb()
      const userId = getCurrentUserId()
      const agent = db
        .select()
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
        .get()
      if (!agent) {
        logger.warn(`Test failed: agent ${agentId} not found`)
        return { success: false, error: 'Agent not found' }
      }

      logger.info(`Testing agent "${agent.name}" (${agent.protocol})`)

      if (agent.protocol === 'a2a') {
        if (!agent.cardUrl) {
          logger.error(`Test failed: no card URL for agent "${agent.name}"`)
          return { success: false, error: 'No card URL configured' }
        }
        try {
          const accessToken = await resolveAgentAccessToken(agent)
          const { card, protocol } = await fetchAgentCard(agent.cardUrl, accessToken)
          logger.info(
            `Agent "${agent.name}" resolved protocol ${protocol.version} at ${protocol.url}`
          )
          // Update cached card data + resolved protocol interface
          db.update(agents)
            .set({
              cardData: card as unknown as Record<string, unknown>,
              endpointUrl: protocol.url,
              protocolInterfaceUrl: protocol.url,
              protocolInterfaceVersion: protocol.version,
              skills: card.skills?.map((s) => ({
                id: s.id,
                name: s.name,
                description: s.description
              })) ?? null
            })
            .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
            .run()
          return { success: true, card: card as unknown as Record<string, unknown> }
        } catch (err) {
          logger.error(`Test failed for agent "${agent.name}"`, {
            cardUrl: agent.cardUrl,
            error: String(err),
            stack: err instanceof Error ? err.stack : undefined
          })
          return { success: false, error: String(err) }
        }
      }

      logger.error(`Unsupported protocol: ${agent.protocol}`)
      return { success: false, error: `Unsupported protocol: ${agent.protocol}` }
    }
  )

  // Look up the A2A session for a chat (used by renderer to detect agent chats)
  ipcMain.handle('agent:get-session', async (_event, chatId: string) => {
    userActivation.requireActivated()
    const userId = getCurrentUserId()
    if (!chatRepo.getOwned(userId, chatId)) return null
    const db = getDb()
    return db.select().from(a2aSessions).where(eq(a2aSessions.chatId, chatId)).get() ?? null
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

    const db = getDb()
    const agent = db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
      .get()
    if (!agent || !agent.cardUrl) {
      const err = 'Agent not found or not configured'
      logger.error(err, { agentId, chatId, hasAgent: !!agent, cardUrl: agent?.cardUrl })
      port.postMessage({ type: 'error', error: err })
      messageRepo.saveError({ chatId, short: err })
      port.close()
      return
    }

    let endpointUrl = agent.protocolInterfaceUrl ?? agent.endpointUrl

    // Auto-resolve endpoint for remote agents that haven't been tested yet
    if (!endpointUrl && agent.cardUrl && agent.source === 'remote') {
      try {
        const accessToken = await resolveAgentAccessToken(agent)
        const { protocol } = await fetchAgentCard(agent.cardUrl, accessToken)
        endpointUrl = protocol.url
        // Cache resolved endpoint so subsequent messages skip this step
        db.update(agents)
          .set({
            endpointUrl: protocol.url,
            protocolInterfaceUrl: protocol.url,
            protocolInterfaceVersion: protocol.version
          })
          .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
          .run()
        logger.info(`Auto-resolved endpoint for "${agent.name}": ${protocol.url}`)
      } catch (err) {
        const errMsg = `Failed to resolve agent endpoint: ${String(err)}`
        logger.error(errMsg, { agentId, cardUrl: agent.cardUrl })
        port.postMessage({ type: 'error', error: errMsg })
        messageRepo.saveError({ chatId, short: errMsg })
        port.close()
        return
      }
    }

    if (!endpointUrl) {
      const err = 'No compatible protocol endpoint resolved. Test the agent connection first.'
      logger.error(err, {
        agentId,
        agentName: agent.name,
        source: agent.source,
        cardUrl: agent.cardUrl,
        protocolInterfaceUrl: agent.protocolInterfaceUrl,
        endpointUrl: agent.endpointUrl
      })
      port.postMessage({ type: 'error', error: err })
      messageRepo.saveError({ chatId, short: err })
      port.close()
      return
    }

    const abortController = new AbortController()
    const requestId = nanoid()
    activeAbortControllers.set(requestId, abortController)
    port.postMessage({ type: 'request-id', requestId })

    // Save user message
    messageRepo.saveUser({ chatId, content: userContent })

    try {
      const accessToken = await resolveAgentAccessToken(agent)

      const client = await createA2AClient(endpointUrl, agent.cardUrl, accessToken)
      const card = await client.getAgentCard()
      const supportsStreaming = card.capabilities?.streaming === true

      logger.info(`Agent "${agent.name}" | endpoint: ${endpointUrl}`, {
        streaming: supportsStreaming
      })

      // Load existing session for conversation continuity
      const session = db
        .select()
        .from(a2aSessions)
        .where(and(eq(a2aSessions.chatId, chatId), eq(a2aSessions.agentId, agentId)))
        .get()

      const sessionContextId = session?.contextId ?? undefined
      const sessionTaskId = session?.taskId ?? undefined

      logger.debug(
        session ? 'Resumed session' : 'New session',
        session ? { contextId: sessionContextId, taskId: sessionTaskId } : undefined
      )

      // Track the latest contextId/taskId from the response
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

          // Extract contextId/taskId from all event types
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

        // Save assistant message
        if (fullText) {
          messageRepo.saveAssistant({ chatId, content: fullText })
        }
      } else {
        // Non-streaming fallback
        const params = buildSendParams(userContent, sessionContextId, sessionTaskId)
        const result = await client.sendMessage(params)
        const responseJson = result as unknown as Record<string, unknown>

        // Extract result from JSON-RPC response
        const rpcResult = (responseJson.result ?? responseJson) as Record<string, unknown>
        let fullText = ''

        if (rpcResult.task) {
          const task = rpcResult.task as { id?: string; contextId?: string; status?: { state: string } }
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
          const top = rpcResult as { id?: string; contextId?: string; taskId?: string; status?: { state: string } }
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

      // Persist session state for conversation continuity
      const now = new Date()
      if (session) {
        db.update(a2aSessions)
          .set({
            contextId: latestContextId ?? session.contextId,
            taskId: latestTaskId ?? session.taskId,
            taskState: latestTaskState ?? session.taskState,
            updatedAt: now
          })
          .where(eq(a2aSessions.id, session.id))
          .run()
      } else {
        db.insert(a2aSessions)
          .values({
            id: nanoid(),
            chatId,
            agentId,
            contextId: latestContextId ?? null,
            taskId: latestTaskId ?? null,
            taskState: latestTaskState ?? null,
            createdAt: now,
            updatedAt: now
          })
          .run()
      }
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
        console.error('[A2A] Error:', errorStr)
        if (errorStr.includes('ID mismatch')) {
          console.error('[A2A] This is likely a type mismatch: SDK sends numeric id, server returns string id.')
          console.error('[A2A] See @a2a-js/sdk client/index.js _processSseEventData() uses !== (strict equality)')
        }
        port.postMessage({ type: 'error', error: errorStr })
        messageRepo.saveError({ chatId, short: errorStr })
      }
    } finally {
      port.close()
      activeAbortControllers.delete(requestId)
    }
  })

  ipcMain.handle('agent:cancel-message', async (_event, requestId: string) => {
    const controller = activeAbortControllers.get(requestId)
    if (controller) {
      controller.abort()
      activeAbortControllers.delete(requestId)
    }
    return { success: true }
  })
}
