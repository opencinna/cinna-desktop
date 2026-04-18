import { nanoid } from 'nanoid'
import { chatRepo } from '../db/chats'
import { chatMcpRepo } from '../db/chatMcp'
import { messageRepo } from '../db/messages'
import { getAdapter } from '../llm/registry'
import { mcpManager } from '../mcp/manager'
import {
  ChatMessage,
  LLMAdapter,
  ToolCallInfo,
  ToolDefinition
} from '../llm/types'
import { ChatError } from '../errors'
import { createLogger } from '../logger/logger'

const logger = createLogger('LLM')
const MAX_TOOL_ROUNDS = 10

export interface StreamPort {
  postMessage(msg: unknown): void
  close(): void
}

export interface StreamInput {
  userId: string
  chatId: string
  userContent: string
  port: StreamPort
}

export interface StreamHandle {
  requestId: string
  abort(): void
}

const activeAbortControllers = new Map<string, AbortController>()

export const chatStreamingService = {
  cancel(requestId: string): boolean {
    const ctl = activeAbortControllers.get(requestId)
    if (!ctl) return false
    ctl.abort()
    activeAbortControllers.delete(requestId)
    return true
  },

  /**
   * Stream an LLM response for the given chat. Returns the StreamHandle once
   * setup completes; the caller should not await the stream finish — the port
   * is closed when streaming completes or errors out.
   */
  async stream(input: StreamInput): Promise<StreamHandle> {
    const { userId, chatId, userContent, port } = input

    const chat = chatRepo.getOwned(userId, chatId)
    if (!chat) {
      const err = 'Chat not found'
      port.postMessage({ type: 'error', error: err })
      messageRepo.saveError({ chatId, short: err })
      port.close()
      throw new ChatError('not_found', err)
    }
    if (!chat.providerId || !chat.modelId) {
      const err = 'Chat has no model/provider configured'
      port.postMessage({ type: 'error', error: err })
      messageRepo.saveError({ chatId, short: err })
      port.close()
      throw new ChatError('not_configured', err)
    }

    const adapter = getAdapter(chat.providerId)
    if (!adapter) {
      const err = 'Provider adapter not available'
      port.postMessage({ type: 'error', error: err })
      messageRepo.saveError({ chatId, short: err })
      port.close()
      throw new ChatError('adapter_unavailable', err)
    }

    messageRepo.saveUser({ chatId, content: userContent })

    const mcpProviderIds = chatMcpRepo.listProviderIds(chatId)
    const tools: ToolDefinition[] = mcpManager.getToolsForProviders(mcpProviderIds)

    const toolProviderMap = new Map<string, string>()
    const toolProviderNameMap = new Map<string, string>()
    for (const t of tools) {
      toolProviderMap.set(t.name, t.mcpProviderId)
      const conn = mcpManager.getConnection(t.mcpProviderId)
      if (conn) toolProviderNameMap.set(t.name, conn.config.name)
    }

    const abortController = new AbortController()
    const requestId = nanoid()
    activeAbortControllers.set(requestId, abortController)

    port.postMessage({ type: 'request-id', requestId })

    const baseLog = {
      requestId,
      chatId,
      providerId: chat.providerId,
      model: chat.modelId,
      providerType: adapter.providerType,
      toolCount: tools.length
    }

    // Fire-and-forget the actual streaming work so the caller can release
    // the IPC listener while we drive the tool-call loop.
    this._runStreamLoop(
      chat.providerId,
      chat.modelId,
      chatId,
      adapter,
      tools,
      toolProviderMap,
      toolProviderNameMap,
      abortController,
      port,
      baseLog
    ).finally(() => {
      port.close()
      activeAbortControllers.delete(requestId)
    })

    return {
      requestId,
      abort: () => abortController.abort()
    }
  },

  async _runStreamLoop(
    _providerId: string,
    modelId: string,
    chatId: string,
    adapter: LLMAdapter,
    tools: ToolDefinition[],
    toolProviderMap: Map<string, string>,
    toolProviderNameMap: Map<string, string>,
    abortController: AbortController,
    port: StreamPort,
    baseLog: Record<string, unknown>
  ): Promise<void> {
    try {
      const dbMessages = chatRepo.listMessages(chatId)
      const currentMessages: ChatMessage[] = dbMessages
        .filter((m) => m.role !== 'error')
        .map((m) => ({
          role: m.role as ChatMessage['role'],
          content: m.content,
          toolCalls: (m.toolCalls as ToolCallInfo[] | null) ?? undefined,
          toolCallId: m.toolCallId ?? undefined,
          toolName: m.toolName ?? undefined,
          toolInput: (m.toolInput as Record<string, unknown>) ?? undefined,
          toolError: m.toolError ?? undefined
        }))

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (abortController.signal.aborted) break

        logger.info('stream request', { ...baseLog, round, messages: currentMessages.length })
        const started = Date.now()

        const result = await adapter.stream({
          model: modelId,
          messages: currentMessages,
          tools: tools.length > 0 ? tools : undefined,
          signal: abortController.signal,
          onDelta: (text) => {
            port.postMessage({ type: 'delta', text })
          }
        })

        logger.info('stream response', {
          ...baseLog,
          round,
          duration: Date.now() - started,
          contentLen: result.content.length,
          toolCalls: result.toolCalls.length
        })

        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: result.content,
          toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined
        }

        messageRepo.saveAssistant({
          chatId,
          content: result.content,
          toolCalls: result.toolCalls.length > 0 ? result.toolCalls : null
        })
        currentMessages.push(assistantMsg)

        if (result.toolCalls.length === 0) break

        for (const tc of result.toolCalls) {
          if (abortController.signal.aborted) break

          const mcpProviderId = toolProviderMap.get(tc.name) ?? ''
          const mcpProviderName = toolProviderNameMap.get(tc.name) ?? ''

          port.postMessage({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.input,
            provider: mcpProviderName
          })

          let toolContent: string
          let toolError = false
          const toolStarted = Date.now()
          try {
            logger.info('tool call', { ...baseLog, tool: tc.name, mcpProviderId })
            const toolResult = await mcpManager.callTool(mcpProviderId, tc.name, tc.input)
            toolContent = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult)
            logger.info('tool result', {
              ...baseLog,
              tool: tc.name,
              mcpProviderId,
              duration: Date.now() - toolStarted
            })
            port.postMessage({ type: 'tool_result', id: tc.id, result: toolResult })
          } catch (err) {
            toolContent = err instanceof Error ? err.message : String(err)
            toolError = true
            logger.error('tool failed', {
              ...baseLog,
              tool: tc.name,
              mcpProviderId,
              duration: Date.now() - toolStarted,
              error: toolContent
            })
            port.postMessage({ type: 'tool_error', id: tc.id, error: toolContent })
          }

          const toolMsg: ChatMessage = {
            role: 'tool_call',
            content: toolContent,
            toolCallId: tc.id,
            toolName: tc.name,
            toolInput: tc.input,
            toolError
          }

          messageRepo.saveToolCall({
            chatId,
            content: toolContent,
            toolCallId: tc.id,
            toolName: tc.name,
            toolInput: tc.input,
            toolError,
            toolProvider: mcpProviderName || undefined
          })

          currentMessages.push(toolMsg)
        }

        if (abortController.signal.aborted) break
      }

      messageRepo.touchChat(chatId)
      port.postMessage({ type: 'done' })
    } catch (err) {
      if (abortController.signal.aborted) return
      const error = err instanceof Error ? err : new Error(String(err))
      const parsed = adapter.parseError(error)
      logger.error('stream failed', {
        ...baseLog,
        error: parsed.short,
        detail: parsed.detail
      })
      port.postMessage({ type: 'error', error: parsed.short, errorDetail: parsed.detail })
      messageRepo.saveError({ chatId, short: parsed.short, detail: parsed.detail })
    }
  }
}
