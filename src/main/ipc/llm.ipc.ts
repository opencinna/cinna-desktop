import { ipcMain } from 'electron'
import { nanoid } from 'nanoid'
import { eq, desc } from 'drizzle-orm'
import { getDb } from '../db/client'
import { chats, messages, chatMcpProviders } from '../db/schema'
import { getAdapter } from '../llm/registry'
import { mcpManager } from '../mcp/manager'
import { LLMAdapter, ChatMessage, ToolDefinition, ToolCallInfo } from '../llm/types'
import { AnthropicAdapter } from '../llm/anthropic'
import { OpenAIAdapter } from '../llm/openai'
import { GeminiAdapter } from '../llm/gemini'

const MAX_TOOL_ROUNDS = 10

export function createAdapter(
  type: string,
  apiKey: string,
  providerId: string
): LLMAdapter | null {
  switch (type) {
    case 'anthropic':
      return new AnthropicAdapter(apiKey, providerId)
    case 'openai':
      return new OpenAIAdapter(apiKey, providerId)
    case 'gemini':
      return new GeminiAdapter(apiKey, providerId)
    default:
      return null
  }
}

const activeAbortControllers = new Map<string, AbortController>()

function getNextSortOrder(chatId: string): number {
  const db = getDb()
  const last = db
    .select({ sortOrder: messages.sortOrder })
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(desc(messages.sortOrder))
    .limit(1)
    .get()
  return last ? last.sortOrder + 1 : 0
}

export function registerLlmHandlers(): void {
  // Handle streaming message via MessagePort
  // ipcRenderer.postMessage passes message as 2nd arg, ports on event.ports
  ipcMain.on('llm:send-message', async (event, message: [string, string]) => {
    const [chatId, userContent] = message
    const port = event.ports?.[0]
    if (!port) {
      console.error('No MessagePort received for llm:send-message')
      return
    }

    port.start()

    const db = getDb()
    const chat = db.select().from(chats).where(eq(chats.id, chatId)).get()
    if (!chat || !chat.providerId || !chat.modelId) {
      port.postMessage({ type: 'error', error: 'Chat has no model/provider configured' })
      port.close()
      return
    }

    const adapter = getAdapter(chat.providerId)
    if (!adapter) {
      port.postMessage({ type: 'error', error: 'Provider adapter not available' })
      port.close()
      return
    }

    // Save user message to DB
    db.insert(messages)
      .values({
        id: nanoid(),
        chatId,
        role: 'user',
        content: userContent,
        sortOrder: getNextSortOrder(chatId),
        createdAt: new Date()
      })
      .run()

    // Get active MCP tools for this chat
    const activeMcpLinks = db
      .select()
      .from(chatMcpProviders)
      .where(eq(chatMcpProviders.chatId, chatId))
      .all()

    const mcpProviderIds = activeMcpLinks.map((l) => l.mcpProviderId)
    const tools: ToolDefinition[] = mcpManager.getToolsForProviders(mcpProviderIds)

    // Build tool provider maps: tool name -> mcpProviderId, and tool name -> display name
    const toolProviderMap = new Map<string, string>()
    const toolProviderNameMap = new Map<string, string>()
    for (const t of tools) {
      toolProviderMap.set(t.name, t.mcpProviderId)
      const conn = mcpManager.getConnection(t.mcpProviderId)
      if (conn) {
        toolProviderNameMap.set(t.name, conn.config.name)
      }
    }

    // Stream the response
    const abortController = new AbortController()
    const requestId = nanoid()
    activeAbortControllers.set(requestId, abortController)

    port.postMessage({ type: 'request-id', requestId })

    try {
      // Build message history from DB
      const dbMessages = db
        .select()
        .from(messages)
        .where(eq(messages.chatId, chatId))
        .orderBy(messages.sortOrder)
        .all()

      const currentMessages: ChatMessage[] = dbMessages.map((m) => ({
        role: m.role as ChatMessage['role'],
        content: m.content,
        toolCalls: (m.toolCalls as ToolCallInfo[] | null) ?? undefined,
        toolCallId: m.toolCallId ?? undefined,
        toolName: m.toolName ?? undefined,
        toolInput: (m.toolInput as Record<string, unknown>) ?? undefined,
        toolError: m.toolError ?? undefined
      }))

      // Tool-call loop
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (abortController.signal.aborted) break

        const result = await adapter.stream({
          model: chat.modelId,
          messages: currentMessages,
          tools: tools.length > 0 ? tools : undefined,
          signal: abortController.signal,
          onDelta: (text) => {
            port.postMessage({ type: 'delta', text })
          }
        })

        // Save assistant message to DB (with toolCalls if any)
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: result.content,
          toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined
        }

        db.insert(messages)
          .values({
            id: nanoid(),
            chatId,
            role: 'assistant',
            content: result.content,
            toolCalls: result.toolCalls.length > 0 ? result.toolCalls : null,
            sortOrder: getNextSortOrder(chatId),
            createdAt: new Date()
          })
          .run()

        currentMessages.push(assistantMsg)

        // No tool calls — we're done
        if (result.toolCalls.length === 0) {
          break
        }

        // Execute each tool call
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

          try {
            const toolResult = await mcpManager.callTool(mcpProviderId, tc.name, tc.input)
            toolContent = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult)
            port.postMessage({ type: 'tool_result', id: tc.id, result: toolResult })
          } catch (err) {
            toolContent = String(err)
            toolError = true
            port.postMessage({ type: 'tool_error', id: tc.id, error: toolContent })
          }

          // Save tool_call message to DB
          const toolMsg: ChatMessage = {
            role: 'tool_call',
            content: toolContent,
            toolCallId: tc.id,
            toolName: tc.name,
            toolInput: tc.input,
            toolError
          }

          db.insert(messages)
            .values({
              id: nanoid(),
              chatId,
              role: 'tool_call',
              content: toolContent,
              toolCallId: tc.id,
              toolName: tc.name,
              toolInput: tc.input,
              toolError,
              toolProvider: mcpProviderName || null,
              sortOrder: getNextSortOrder(chatId),
              createdAt: new Date()
            })
            .run()

          currentMessages.push(toolMsg)
        }

        // If aborted during tool execution, stop the loop
        if (abortController.signal.aborted) break
      }

      db.update(chats)
        .set({ updatedAt: new Date() })
        .where(eq(chats.id, chatId))
        .run()

      port.postMessage({ type: 'done' })
    } catch (err) {
      if (!abortController.signal.aborted) {
        const error = err instanceof Error ? err : new Error(String(err))
        const parsed = adapter.parseError(error)
        port.postMessage({ type: 'error', error: parsed.short, errorDetail: parsed.detail })
      }
    } finally {
      port.close()
      activeAbortControllers.delete(requestId)
    }
  })

  ipcMain.handle('llm:cancel', async (_event, requestId: string) => {
    const controller = activeAbortControllers.get(requestId)
    if (controller) {
      controller.abort()
      activeAbortControllers.delete(requestId)
    }
    return { success: true }
  })
}
