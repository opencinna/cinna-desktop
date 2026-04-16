import { ipcMain } from 'electron'
import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { agents, chats } from '../db/schema'
import { messageRepo } from '../db/messages'
import { decryptApiKey } from '../security/keystore'
import {
  fetchAgentCard,
  createA2AClient,
  buildSendParams,
  extractTextFromResult,
  type ProtocolResolution
} from '../agents/a2a-client'

const activeAbortControllers = new Map<string, AbortController>()

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
      try {
        const { card, protocol } = await fetchAgentCard(data.cardUrl, data.accessToken)
        return { success: true, card: card as unknown as Record<string, unknown>, protocol }
      } catch (err) {
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
      const db = getDb()
      const agent = db.select().from(agents).where(eq(agents.id, agentId)).get()
      if (!agent) {
        return { success: false, error: 'Agent not found' }
      }

      if (agent.protocol === 'a2a') {
        if (!agent.cardUrl) {
          return { success: false, error: 'No card URL configured' }
        }
        try {
          const accessToken = agent.accessTokenEncrypted
            ? decryptApiKey(agent.accessTokenEncrypted)
            : undefined
          const { card, protocol } = await fetchAgentCard(agent.cardUrl, accessToken)
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
            .where(eq(agents.id, agentId))
            .run()
          return { success: true, card: card as unknown as Record<string, unknown> }
        } catch (err) {
          return { success: false, error: String(err) }
        }
      }

      return { success: false, error: `Unsupported protocol: ${agent.protocol}` }
    }
  )

  // Stream a message to an A2A agent via MessagePort
  ipcMain.on('agent:send-message', async (event, message: [string, string, string]) => {
    const [agentId, chatId, userContent] = message
    const port = event.ports?.[0]
    if (!port) return
    port.start()

    const db = getDb()
    const agent = db.select().from(agents).where(eq(agents.id, agentId)).get()
    if (!agent || !agent.cardUrl) {
      const err = 'Agent not found or not configured'
      port.postMessage({ type: 'error', error: err })
      messageRepo.saveError({ chatId, short: err })
      port.close()
      return
    }

    const endpointUrl = agent.protocolInterfaceUrl ?? agent.endpointUrl
    if (!endpointUrl) {
      const err = 'No compatible protocol endpoint resolved. Test the agent connection first.'
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
      const accessToken = agent.accessTokenEncrypted
        ? decryptApiKey(agent.accessTokenEncrypted)
        : undefined

      const client = await createA2AClient(endpointUrl, agent.cardUrl, accessToken)
      const card = await client.getAgentCard()
      const supportsStreaming = card.capabilities?.streaming === true

      // Get existing context/task for this chat from card data
      // We store contextId on the chat row to maintain conversation continuity
      const chat = db.select().from(chats).where(eq(chats.id, chatId)).get()

      if (supportsStreaming) {
        const params = buildSendParams(userContent)
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

          // Forward status updates
          if ('kind' in event && event.kind === 'status-update') {
            const su = event as { status: { state: string }; taskId?: string; contextId?: string }
            port.postMessage({
              type: 'status',
              state: su.status.state,
              taskId: su.taskId,
              contextId: su.contextId
            })
          }
        }

        // Save assistant message
        if (fullText) {
          messageRepo.saveAssistant({ chatId, content: fullText })
        }
      } else {
        // Non-streaming fallback
        const params = buildSendParams(userContent)
        const result = await client.sendMessage(params)
        const responseJson = result as unknown as Record<string, unknown>

        // Extract result from JSON-RPC response
        const rpcResult = (responseJson.result ?? responseJson) as Record<string, unknown>
        let fullText = ''

        if (rpcResult.task) {
          fullText = extractTextFromResult({ kind: 'task', ...(rpcResult.task as object) } as never)
        } else if (rpcResult.message) {
          fullText = extractTextFromResult({
            kind: 'message',
            ...(rpcResult.message as object)
          } as never)
        } else {
          fullText = extractTextFromResult(rpcResult as never)
        }

        if (fullText) {
          port.postMessage({ type: 'delta', text: fullText })
          messageRepo.saveAssistant({ chatId, content: fullText })
        }
      }

      messageRepo.touchChat(chatId)

      port.postMessage({ type: 'done' })
    } catch (err) {
      if (!abortController.signal.aborted) {
        const errorStr = String(err)
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
