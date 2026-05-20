import { nanoid } from 'nanoid'
import { messageRepo } from '../db/messages'
import { a2aSessionRepo } from '../db/agents'
import {
  createA2AClient,
  buildSendParams,
  humanizeA2AError,
  type TaskStatusUpdateEvent,
  type TaskArtifactUpdateEvent,
  type Message,
  type Task
} from '../agents/a2a-client'
import type { A2AClient } from '@a2a-js/sdk/client'
import {
  StreamPartsAccumulator,
  type MessageLike,
  type ArtifactLike
} from '../agents/streamPartsAccumulator'
import { jobService } from './jobService'
import { createLogger } from '../logger/logger'

const logger = createLogger('A2A')

export interface StreamPort {
  postMessage(msg: unknown): void
  close(): void
}

interface ActiveRequest {
  controller: AbortController
  client?: A2AClient
  taskId?: string
}

const activeRequests = new Map<string, ActiveRequest>()

export interface StreamToAgentInput {
  chatId: string
  agentId: string
  agentName: string
  endpointUrl: string
  cardUrl: string
  accessToken?: string
  wireContent: string
  /**
   * Cinna file IDs (UUIDs) to attach to this turn — forwarded as
   * `metadata.cinna_file_ids` on the A2A message. The cinna-backend reads
   * this and transfers the uploaded files into the agent environment under
   * `./uploads/` before the agent receives the message.
   */
  fileIds?: string[]
  port: StreamPort
}

/**
 * Drive a single A2A turn end-to-end: create the client, run the streaming
 * (or non-streaming) RPC, accumulate parts via {@link StreamPartsAccumulator},
 * persist the assistant message + updated session, post events to the port.
 *
 * The user message is NOT persisted here — that already happened in
 * `messageRoutingService.prepareAgentSend` before this call.
 */
export const a2aStreamingService = {
  async streamToAgent(input: StreamToAgentInput): Promise<void> {
    const {
      chatId,
      agentId,
      agentName,
      endpointUrl,
      cardUrl,
      accessToken,
      wireContent,
      fileIds,
      port
    } = input
    const metadata =
      fileIds && fileIds.length > 0 ? { cinna_file_ids: fileIds } : undefined

    const abortController = new AbortController()
    const requestId = nanoid()
    const activeRequest: ActiveRequest = { controller: abortController }
    activeRequests.set(requestId, activeRequest)
    port.postMessage({ type: 'request-id', requestId })

    try {
      const client = await createA2AClient(endpointUrl, cardUrl, accessToken)
      activeRequest.client = client
      const card = await client.getAgentCard()
      const supportsStreaming = card.capabilities?.streaming === true

      logger.info(`Agent "${agentName}" | endpoint: ${endpointUrl}`, {
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

      const setTaskId = (id: string | undefined): void => {
        if (!id) return
        latestTaskId = id
        activeRequest.taskId = id
      }
      if (sessionTaskId) activeRequest.taskId = sessionTaskId

      if (supportsStreaming) {
        const params = buildSendParams(wireContent, sessionContextId, sessionTaskId, metadata)
        logger.debug('→ sendMessageStream', params)
        let eventIndex = 0
        const accumulator = new StreamPartsAccumulator({
          onToolCall: ({ name, input: toolInput }) => {
            logger.info(`tool call → ${name}`, { input: toolInput })
          }
        })

        for await (const event of client.sendMessageStream(params)) {
          logger.debug(`← stream event #${eventIndex++}`, event)
          if (abortController.signal.aborted) {
            logger.debug('Stream aborted by client', { eventsReceived: eventIndex })
            break
          }

          if ('kind' in event) {
            if (event.kind === 'status-update') {
              const su = event as TaskStatusUpdateEvent
              if (su.status?.message) {
                accumulator.ingestMessage(su.status.message, port)
              }
              latestContextId = su.contextId
              setTaskId(su.taskId)
              latestTaskState = su.status.state
              port.postMessage({
                type: 'status',
                state: su.status.state,
                taskId: su.taskId,
                contextId: su.contextId
              })
            } else if (event.kind === 'artifact-update') {
              const au = event as TaskArtifactUpdateEvent
              if (au.artifact) {
                accumulator.ingestArtifact(au.artifact, port)
              }
              if (au.contextId) latestContextId = au.contextId
            } else if (event.kind === 'message') {
              const m = event as Message
              accumulator.ingestMessage(m, port)
              if (m.contextId) latestContextId = m.contextId
              if (m.taskId) setTaskId(m.taskId)
            } else if (event.kind === 'task') {
              const t = event as Task
              latestContextId = t.contextId
              setTaskId(t.id)
              if (t.status?.state) latestTaskState = t.status.state
              if (t.status?.message) {
                accumulator.ingestMessage(t.status.message, port)
              }
              t.artifacts?.forEach((a) => accumulator.ingestArtifact(a, port))
            }
          }
        }

        const parts = accumulator.snapshotParts()
        const answerText = accumulator.answerText()
        logger.debug('Stream complete', {
          eventsReceived: eventIndex,
          parts: parts.map((p) => ({ kind: p.kind, len: p.text.length })),
          answerLength: answerText.length
        })

        if (parts.length > 0) {
          messageRepo.saveAssistant({
            chatId,
            content: answerText || parts.map((p) => p.text).join(''),
            parts,
            sourceAgentId: agentId
          })
        }
      } else {
        const params = buildSendParams(wireContent, sessionContextId, sessionTaskId, metadata)
        logger.debug('→ sendMessage', params)
        const result = await client.sendMessage(params)
        logger.debug('← response', result)
        const responseJson = result as unknown as Record<string, unknown>

        const rpcResult = (responseJson.result ?? responseJson) as Record<string, unknown>
        const accumulator = new StreamPartsAccumulator({
          onToolCall: ({ name, input: toolInput }) => {
            logger.info(`tool call → ${name}`, { input: toolInput })
          }
        })

        const ingestTaskShape = (task: {
          id?: string
          contextId?: string
          status?: { state?: string; message?: MessageLike }
          artifacts?: ArtifactLike[]
        }): void => {
          if (task.contextId) latestContextId = task.contextId
          if (task.id) setTaskId(task.id)
          if (task.status?.state) latestTaskState = task.status.state
          if (task.status?.message) accumulator.ingestMessage(task.status.message, port)
          task.artifacts?.forEach((a) => accumulator.ingestArtifact(a, port))
        }

        if (rpcResult.task) {
          ingestTaskShape(rpcResult.task as Parameters<typeof ingestTaskShape>[0])
        } else if (rpcResult.message) {
          const msg = rpcResult.message as MessageLike & { contextId?: string; taskId?: string }
          if (msg.contextId) latestContextId = msg.contextId
          if (msg.taskId) setTaskId(msg.taskId)
          accumulator.ingestMessage(msg, port)
        } else if (rpcResult.kind === 'task') {
          ingestTaskShape(rpcResult as Parameters<typeof ingestTaskShape>[0])
        } else if (rpcResult.kind === 'message') {
          const msg = rpcResult as unknown as MessageLike & { contextId?: string; taskId?: string }
          if (msg.contextId) latestContextId = msg.contextId
          if (msg.taskId) setTaskId(msg.taskId)
          accumulator.ingestMessage(msg, port)
        }

        const parts = accumulator.snapshotParts()
        const answerText = accumulator.answerText()
        logger.debug('Non-streaming complete', {
          parts: parts.map((p) => ({ kind: p.kind, len: p.text.length })),
          answerLength: answerText.length
        })

        if (parts.length > 0) {
          messageRepo.saveAssistant({
            chatId,
            content: answerText || parts.map((p) => p.text).join(''),
            parts,
            sourceAgentId: agentId
          })
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
      jobService.reportRunCompletion(chatId, 'succeeded')
    } catch (err) {
      if (!abortController.signal.aborted) {
        const rawError = String(err)
        const humanized = humanizeA2AError(err)
        logger.error('send-message failed', {
          agentId,
          chatId,
          error: rawError,
          humanized,
          stack: err instanceof Error ? err.stack : undefined
        })
        port.postMessage({ type: 'error', error: humanized })
        messageRepo.saveError({ chatId, short: humanized, detail: rawError })
        jobService.reportRunCompletion(chatId, 'failed', humanized)
      }
    } finally {
      port.close()
      activeRequests.delete(requestId)
    }
  },

  cancel(requestId: string): boolean {
    const request = activeRequests.get(requestId)
    if (!request) return false

    request.controller.abort()
    activeRequests.delete(requestId)

    if (request.client && request.taskId) {
      const taskId = request.taskId
      logger.info('Sending cancelTask to agent', { taskId })
      request.client.cancelTask({ id: taskId }).catch((err) =>
        logger.warn('cancelTask failed', { taskId, error: String(err) })
      )
    }
    return true
  }
}
