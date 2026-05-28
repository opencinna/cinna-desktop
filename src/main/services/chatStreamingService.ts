import { nanoid } from 'nanoid'
import { chatRepo } from '../db/chats'
import { chatMcpRepo } from '../db/chatMcp'
import { chatOnDemandMcpRepo } from '../db/chatOnDemandMcp'
import { chatOnDemandAgentRepo } from '../db/chatOnDemandAgent'
import { mcpProviderRepo } from '../db/mcpProviders'
import { messageRepo } from '../db/messages'
import { getSettingsScopeUserId } from '../auth/scope'
import { getAdapter } from '../llm/registry'
import { mcpManager } from '../mcp/manager'
import { McpToolProvider, type ToolProvider } from '../llm/toolProvider'
import { A2AAsMcpProvider, buildAgentToolProviders } from './a2aAsMcpProvider'
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
import type { MessagePart } from '../../shared/messageParts'
import type { AgentStreamEvent } from '../../shared/agentStreamEvents'
import type { LlmStreamEvent } from '../../shared/llmStreamEvents'

const logger = createLogger('LLM')
const MAX_TOOL_ROUNDS = 10

/**
 * Typed stream port. Every event sent to the renderer over this channel
 * must conform to `LlmStreamEvent` — symmetric to the A2A pipeline's
 * `StreamPort`, but with a distinct event union (LLM tool calls flow via
 * `tool_use` / `tool_result` / `tool_error`, not `tool` / `tool_result`
 * content-kind parts).
 */
export interface StreamPort {
  postMessage(msg: LlmStreamEvent): void
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

interface ResolvedAnnounce {
  /** MCP provider ids whose pending flag to clear after the prefix is consumed. */
  mcpIds: string[]
  /** Agent ids whose pending flag to clear after the prefix is consumed. */
  agentIds: string[]
  prefix: string
}

/**
 * Resolve the on-demand MCPs **and** on-demand agents that still owe an
 * announcement for this chat, along with the silent "user just enabled X, Y,
 * Z" prefix prepended to the wire content. Flags are NOT flipped here — that
 * happens after the adapter actually consumes the prefix, so a pre-flight
 * failure does not silently burn the one-shot announcement.
 *
 * Agent names come from the providers already built for this turn, so an
 * attached-but-unresolvable agent (no card URL) is never announced.
 */
function resolvePendingAnnounce(
  chatId: string,
  agentProviders: A2AAsMcpProvider[]
): ResolvedAnnounce {
  const settingsUserId = getSettingsScopeUserId()

  const mcpResolvedIds: string[] = []
  const mcpNames: string[] = []
  for (const id of chatOnDemandMcpRepo.peekPending(chatId)) {
    const row = mcpProviderRepo.getOwned(settingsUserId, id)
    if (row) {
      mcpResolvedIds.push(id)
      mcpNames.push(row.name)
    }
  }

  const agentProviderById = new Map(agentProviders.map((p) => [p.agentId, p]))
  const agentResolvedIds: string[] = []
  const agentNames: string[] = []
  for (const id of chatOnDemandAgentRepo.peekPending(chatId)) {
    const p = agentProviderById.get(id)
    if (p) {
      agentResolvedIds.push(id)
      agentNames.push(p.displayName)
    }
  }

  if (mcpNames.length === 0 && agentNames.length === 0) {
    return { mcpIds: [], agentIds: [], prefix: '' }
  }

  const clauses: string[] = []
  if (mcpNames.length > 0) {
    const formatted = mcpNames.map((n) => `"${n}"`).join(', ')
    clauses.push(`MCP server${mcpNames.length > 1 ? 's' : ''} ${formatted}`)
  }
  if (agentNames.length > 0) {
    const formatted = agentNames.map((n) => `"${n}"`).join(', ')
    clauses.push(`agent${agentNames.length > 1 ? 's' : ''} ${formatted}`)
  }
  const prefix =
    `[System note: For this message the user specifically enabled the ${clauses.join(' and the ')}. ` +
    `Use the corresponding tools when appropriate to fulfil the request below.]\n\n`
  return { mcpIds: mcpResolvedIds, agentIds: agentResolvedIds, prefix }
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
    // appears in both lists is only contributed once. One `McpToolProvider`
    // per connected provider.
    const baseMcpIds = chatMcpRepo.listProviderIds(chatId)
    const onDemandMcpIds = chatOnDemandMcpRepo.listProviderIds(chatId)
    const mcpProviderIds = Array.from(new Set([...baseMcpIds, ...onDemandMcpIds]))

    const providers: ToolProvider[] = []
    for (const id of mcpProviderIds) {
      const conn = mcpManager.getConnection(id)
      if (conn && conn.status === 'connected') {
        providers.push(new McpToolProvider(id, conn.config.name))
      }
    }

    // Agent tools (orchestrated mode): one emulated MCP tool per on-demand
    // agent, unioned with the real MCP tools. Agent slugs avoid any name an
    // MCP tool already took.
    const reservedNames = new Set<string>()
    for (const p of providers) for (const t of p.getTools()) reservedNames.add(t.name)
    const agentProviders = buildAgentToolProviders(
      chatId,
      getSettingsScopeUserId(),
      userId,
      reservedNames
    )
    providers.push(...agentProviders)

    // Union all providers' tools + build the name→provider routing map,
    // de-duping by LLM-facing name (first wins).
    const tools: ToolDefinition[] = []
    const toolRouting = new Map<string, ToolProvider>()
    for (const p of providers) {
      for (const t of p.getTools()) {
        if (toolRouting.has(t.name)) {
          logger.warn('duplicate tool name dropped from union', { name: t.name })
          continue
        }
        toolRouting.set(t.name, p)
        tools.push(t)
      }
    }

    // Resolve any owed on-demand announcements: builds a one-line
    // system-style prefix letting the LLM know which MCPs / agents the user
    // just engaged for this turn. The flag flip is deferred to
    // `_runStreamLoop` so a pre-flight failure (auth error, network down)
    // does not silently burn the one-shot announcement — the user can retry
    // and the LLM will still see the prefix.
    const announce = resolvePendingAnnounce(chatId, agentProviders)
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
      agentToolCount: agentProviders.length,
      announceMcpCount: announce.mcpIds.length,
      announceAgentCount: announce.agentIds.length
    }

    if (announce.mcpIds.length > 0 || announce.agentIds.length > 0) {
      logger.debug('on-demand announce prefix queued', {
        requestId,
        chatId,
        mcpIds: announce.mcpIds,
        agentIds: announce.agentIds
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
      toolRouting,
      abortController,
      port,
      baseLog,
      augmentedWireContent,
      announce.mcpIds,
      announce.agentIds
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
    toolRouting: Map<string, ToolProvider>,
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
    pendingAnnounceMcpIds: string[],
    /** On-demand agent ids whose `pendingAnnounce` to clear — same timing. */
    pendingAnnounceAgentIds: string[]
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
        if (round === 0) {
          if (pendingAnnounceMcpIds.length > 0) {
            chatOnDemandMcpRepo.clearPending(chatId, pendingAnnounceMcpIds)
          }
          if (pendingAnnounceAgentIds.length > 0) {
            chatOnDemandAgentRepo.clearPending(chatId, pendingAnnounceAgentIds)
          }
          if (pendingAnnounceMcpIds.length > 0 || pendingAnnounceAgentIds.length > 0) {
            logger.debug('on-demand announce consumed', {
              ...baseLog,
              mcpIds: pendingAnnounceMcpIds,
              agentIds: pendingAnnounceAgentIds
            })
          }
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

          const provider = toolRouting.get(tc.name)
          const providerName = provider?.displayName ?? ''
          const isAgent = provider?.providerType === 'agent'
          const providerAgentId = provider?.agentId

          port.postMessage({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.input,
            provider: providerName,
            providerType: provider?.providerType,
            providerAgentId
          })

          let toolContent: string
          let toolError = false
          let toolParts: MessagePart[] | null = null
          const toolStarted = Date.now()
          try {
            if (!provider) throw new Error(`Unknown tool: ${tc.name}`)
            logger.info('tool call', {
              ...baseLog,
              tool: tc.name,
              provider: providerName,
              providerType: provider.providerType
            })

            // Agent tools forward each A2A stream event into the chat port as
            // a `tool_subevent` keyed by this tool-call id, so the renderer
            // can stream the agent's work into a nested sub-thread. MCP tools
            // ignore the sink. The orchestrator's `AbortController` is threaded
            // through so aborting cancels the in-flight agent sub-turn.
            const onEvent = isAgent
              ? (event: AgentStreamEvent): void => {
                  port.postMessage({ type: 'tool_subevent', toolCallId: tc.id, event })
                }
              : undefined

            const exec = await provider.callTool(tc.name, tc.input, {
              onEvent,
              signal: abortController.signal
            })
            if (exec.parts && exec.parts.length > 0) toolParts = exec.parts
            toolContent =
              typeof exec.content === 'string' ? exec.content : JSON.stringify(exec.content)

            if (exec.isError) {
              toolError = true
              logger.warn('tool returned error', {
                ...baseLog,
                tool: tc.name,
                provider: providerName,
                duration: Date.now() - toolStarted
              })
              port.postMessage({ type: 'tool_error', id: tc.id, error: toolContent })
            } else {
              logger.info('tool result', {
                ...baseLog,
                tool: tc.name,
                provider: providerName,
                duration: Date.now() - toolStarted
              })
              port.postMessage({ type: 'tool_result', id: tc.id, result: exec.content })
            }
          } catch (err) {
            toolContent = err instanceof Error ? err.message : String(err)
            toolError = true
            logger.error('tool failed', {
              ...baseLog,
              tool: tc.name,
              provider: providerName,
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
            toolProvider: providerName || undefined,
            toolAgentId: providerAgentId,
            parts: toolParts
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
