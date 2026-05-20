import { nanoid } from 'nanoid'
import { chatRepo } from '../db/chats'
import { chatMcpRepo } from '../db/chatMcp'
import { chatOnDemandMcpRepo } from '../db/chatOnDemandMcp'
import { mcpProviderRepo } from '../db/mcpProviders'
import { messageRepo } from '../db/messages'
import { getSettingsScopeUserId } from '../auth/scope'
import { getAdapter } from '../llm/registry'
import { mcpManager } from '../mcp/manager'
import {
  ChatMessage,
  LLMAdapter,
  ToolCallInfo,
  ToolDefinition
} from '../llm/types'
import { ChatError } from '../errors'
import { jobService } from './jobService'
import { attachmentToMediaPart } from './fileStore'
import { createLogger } from '../logger/logger'
import type { MessageAttachment } from '../../shared/attachments'
import type { MediaPart } from '../llm/types'

const logger = createLogger('LLM')
const MAX_TOOL_ROUNDS = 10

export interface StreamPort {
  postMessage(msg: unknown): void
  close(): void
}

export interface StreamInput {
  userId: string
  chatId: string
  /**
   * Wire-level content for the latest user message. The user message itself
   * is already persisted by `messageRoutingService.prepareLlmSend`; this
   * value is what the LLM sees (catch-up packet prepended when applicable).
   */
  wireContent: string
  port: StreamPort
}

export interface StreamHandle {
  requestId: string
  abort(): void
}

const activeAbortControllers = new Map<string, AbortController>()

/**
 * Resolve the on-demand MCPs that still owe an announcement for this chat,
 * along with the silent "user just enabled MCP X, Y, Z" prefix that should
 * be prepended to the wire content. The flag is NOT flipped here — that
 * happens after the adapter actually consumes the prefix, so a pre-flight
 * failure does not silently burn the one-shot announcement.
 */
function resolvePendingAnnounce(chatId: string): { ids: string[]; names: string[]; prefix: string } {
  const ids = chatOnDemandMcpRepo.peekPending(chatId)
  if (ids.length === 0) return { ids: [], names: [], prefix: '' }
  const settingsUserId = getSettingsScopeUserId()
  const resolvedIds: string[] = []
  const names: string[] = []
  for (const id of ids) {
    const row = mcpProviderRepo.getOwned(settingsUserId, id)
    if (row) {
      resolvedIds.push(id)
      names.push(row.name)
    }
  }
  if (names.length === 0) return { ids: [], names: [], prefix: '' }
  const formatted = names.map((n) => `"${n}"`).join(', ')
  const prefix =
    `[System note: For this message the user specifically enabled the MCP server${names.length > 1 ? 's' : ''} ${formatted}. ` +
    `Use ${names.length > 1 ? 'them' : 'it'} when appropriate to fulfil the request below.]\n\n`
  return { ids: resolvedIds, names, prefix }
}

export const chatStreamingService = {
  cancel(requestId: string): boolean {
    const ctl = activeAbortControllers.get(requestId)
    if (!ctl) return false
    ctl.abort()
    activeAbortControllers.delete(requestId)
    return true
  },

  /**
   * Stream an LLM response for the given chat. The user message must already
   * be persisted by the caller (via `messageRoutingService.prepareLlmSend`).
   * Returns the StreamHandle once setup completes; the caller should not
   * await the stream finish — the port is closed when streaming completes or
   * errors out.
   */
  async stream(input: StreamInput): Promise<StreamHandle> {
    const { userId, chatId, wireContent, port } = input

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

    // Union of the chat-mode-driven MCP set and any on-demand MCPs the user
    // has `@-mention`ed into this chat. De-duplicate so a provider that
    // appears in both lists is only contributed once.
    const baseMcpIds = chatMcpRepo.listProviderIds(chatId)
    const onDemandMcpIds = chatOnDemandMcpRepo.listProviderIds(chatId)
    const mcpProviderIds = Array.from(new Set([...baseMcpIds, ...onDemandMcpIds]))
    const tools: ToolDefinition[] = mcpManager.getToolsForProviders(mcpProviderIds)

    const toolProviderMap = new Map<string, string>()
    const toolProviderNameMap = new Map<string, string>()
    for (const t of tools) {
      toolProviderMap.set(t.name, t.mcpProviderId)
      const conn = mcpManager.getConnection(t.mcpProviderId)
      if (conn) toolProviderNameMap.set(t.name, conn.config.name)
    }

    // Resolve any owed on-demand announcements: builds a one-line
    // system-style prefix letting the LLM know which MCPs the user just
    // engaged for this turn. The flag flip is deferred to `_runStreamLoop`
    // so a pre-flight failure (auth error, network down) does not silently
    // burn the one-shot announcement — the user can retry and the LLM will
    // still see the prefix.
    const announce = resolvePendingAnnounce(chatId)
    const augmentedWireContent = announce.prefix
      ? `${announce.prefix}${wireContent}`
      : wireContent

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
      toolCount: tools.length,
      onDemandMcpCount: onDemandMcpIds.length,
      announceMcpCount: announce.names.length
    }

    if (announce.names.length > 0) {
      logger.debug('on-demand mcp prefix queued', {
        requestId,
        chatId,
        mcpNames: announce.names
      })
    }

    // Fire-and-forget the actual streaming work so the caller can release
    // the IPC listener while we drive the tool-call loop.
    this._runStreamLoop(
      chat.providerId,
      chat.modelId,
      userId,
      chatId,
      adapter,
      tools,
      toolProviderMap,
      toolProviderNameMap,
      abortController,
      port,
      baseLog,
      augmentedWireContent,
      announce.ids
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
    userId: string,
    chatId: string,
    adapter: LLMAdapter,
    tools: ToolDefinition[],
    toolProviderMap: Map<string, string>,
    toolProviderNameMap: Map<string, string>,
    abortController: AbortController,
    port: StreamPort,
    baseLog: Record<string, unknown>,
    /** Wire-level content for the latest user message (catch-up packet prepended when applicable). */
    wireContent: string,
    /**
     * On-demand MCP provider ids whose `pendingAnnounce` flag should be
     * cleared *only* once the LLM has actually consumed the announce prefix
     * (i.e. the first adapter response completes). Empty when no announce was
     * owed for this turn.
     */
    pendingAnnounceMcpIds: string[]
  ): Promise<void> {
    try {
      const dbMessages = chatRepo.listMessages(chatId)
      // Capability acts as a filter for the per-turn `media[]` so adapters
      // never have to reject attachments at convert time — by the time the
      // ChatMessage reaches `adapter.stream`, it carries only media that
      // the active model has declared support for.
      const capability = adapter.modelCapability(modelId)
      const supportsMedia = capability.acceptedMimeTypes.length > 0

      const currentMessages: ChatMessage[] = []
      let resolvedMediaCount = 0
      let droppedMediaCount = 0
      for (const m of dbMessages) {
        if (m.role === 'error' || m.role === 'agent_transition') continue
        let media: MediaPart[] | undefined
        if (supportsMedia && m.role === 'user' && m.attachments) {
          const resolved: MediaPart[] = []
          for (const att of m.attachments as MessageAttachment[]) {
            const part = await attachmentToMediaPart(att, {
              userId,
              acceptedMimeTypes: capability.acceptedMimeTypes,
              nativeMimeTypes: capability.nativeMimeTypes,
              maxFileSizeBytes: capability.maxFileSizeBytes
            })
            if (part) resolved.push(part)
            else droppedMediaCount++
          }
          if (resolved.length > 0) {
            media = resolved.slice(0, capability.maxFilesPerMessage)
            resolvedMediaCount += media.length
          }
        }
        currentMessages.push({
          role: m.role as ChatMessage['role'],
          content: m.content,
          media,
          toolCalls: (m.toolCalls as ToolCallInfo[] | null) ?? undefined,
          toolCallId: m.toolCallId ?? undefined,
          toolName: m.toolName ?? undefined,
          toolInput: (m.toolInput as Record<string, unknown>) ?? undefined,
          toolError: m.toolError ?? undefined
        })
      }
      if (resolvedMediaCount > 0 || droppedMediaCount > 0) {
        logger.debug('media resolution', {
          ...baseLog,
          resolved: resolvedMediaCount,
          dropped: droppedMediaCount
        })
      }

      // The user message is already persisted (with its plain `userContent`);
      // patch the rebuilt history's most recent user turn so the wire-level
      // content (catch-up prepended) is what the LLM sees, without polluting
      // the persisted row.
      for (let i = currentMessages.length - 1; i >= 0; i--) {
        if (currentMessages[i].role === 'user') {
          currentMessages[i] = { ...currentMessages[i], content: wireContent }
          break
        }
      }

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

        // Clear the one-shot announce flag the moment the first adapter
        // response resolves successfully — at this point the LLM has seen
        // the prefix, so a later failure (mid-tool-loop, abort) doesn't
        // re-announce on retry. Guard so we only fire on the first round.
        if (round === 0 && pendingAnnounceMcpIds.length > 0) {
          chatOnDemandMcpRepo.clearPending(chatId, pendingAnnounceMcpIds)
          logger.debug('on-demand mcp announce consumed', {
            ...baseLog,
            mcpIds: pendingAnnounceMcpIds
          })
        }

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
      jobService.reportRunCompletion(chatId, 'succeeded')
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
      jobService.reportRunCompletion(chatId, 'failed', parsed.short)
    }
  }
}
