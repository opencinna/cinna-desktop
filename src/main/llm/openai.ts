import OpenAI from 'openai'
import { LLMAdapter, LLMError, ModelInfo, StreamParams, StreamResult, ChatMessage, ToolDefinition, ToolCallInfo } from './types'

export class OpenAIAdapter implements LLMAdapter {
  readonly providerType = 'openai'
  private client: OpenAI
  private providerId: string

  constructor(apiKey: string, providerId: string) {
    this.client = new OpenAI({ apiKey })
    this.providerId = providerId
  }

  async listModels(): Promise<ModelInfo[]> {
    const models = [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
      { id: 'o3', name: 'o3' },
      { id: 'o4-mini', name: 'o4 Mini' }
    ]

    return models.map((m) => ({
      id: m.id,
      name: m.name,
      providerId: this.providerId,
      providerType: this.providerType
    }))
  }

  async stream(params: StreamParams): Promise<StreamResult> {
    const { model, messages, tools, signal, onDelta } = params

    const currentMessages = this.convertMessages(messages)
    const openaiTools = tools ? this.convertTools(tools) : undefined

    let content = ''
    const toolCalls: ToolCallInfo[] = []
    const partialToolCalls = new Map<number, { id: string; name: string; args: string }>()

    const stream = await this.client.chat.completions.create({
      model,
      messages: currentMessages,
      tools: openaiTools,
      stream: true
    }, { signal })

    for await (const chunk of stream) {
      const choice = chunk.choices[0]
      if (!choice) continue

      const delta = choice.delta
      if (!delta) continue

      if (delta.content) {
        content += delta.content
        onDelta(delta.content)
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          let partial = partialToolCalls.get(tc.index)
          if (!partial) {
            partial = { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' }
            partialToolCalls.set(tc.index, partial)
          }
          if (tc.id) partial.id = tc.id
          if (tc.function?.name) partial.name = tc.function.name
          if (tc.function?.arguments) partial.args += tc.function.arguments
        }
      }
    }

    for (const partial of partialToolCalls.values()) {
      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(partial.args)
      } catch {
        // ignore
      }
      toolCalls.push({ id: partial.id, name: partial.name, input })
    }

    return { content, toolCalls }
  }

  parseError(error: Error): LLMError {
    const msg = error.message
    const err = error as Error & { status?: number; code?: string }
    const code = err.status
    if (code) {
      switch (code) {
        case 429:
          return { short: 'Rate limit exceeded — try again shortly', detail: msg }
        case 401:
          return { short: 'Invalid OpenAI API key', detail: msg }
        case 403:
          return { short: 'Access denied — check your OpenAI plan', detail: msg }
        case 404:
          return { short: 'Model not found', detail: msg }
        case 500: case 502: case 503:
          return { short: 'OpenAI server error — try again', detail: msg }
      }
    }
    if (err.code === 'insufficient_quota') {
      return { short: 'OpenAI quota exceeded — check billing', detail: msg }
    }
    return { short: msg.length > 120 ? msg.slice(0, 117) + '...' : msg, detail: msg }
  }

  private convertMessages(messages: ChatMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
    const result: OpenAI.Chat.ChatCompletionMessageParam[] = []

    for (const msg of messages) {
      if (msg.role === 'user') {
        result.push({ role: 'user', content: msg.content })
      } else if (msg.role === 'assistant') {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          result.push({
            role: 'assistant',
            content: msg.content || null,
            tool_calls: msg.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.input)
              }
            }))
          })
        } else {
          result.push({ role: 'assistant', content: msg.content })
        }
      } else if (msg.role === 'tool_call') {
        result.push({
          role: 'tool',
          tool_call_id: msg.toolCallId ?? '',
          content: msg.content
        })
      }
    }

    return result
  }

  private convertTools(tools: ToolDefinition[]): OpenAI.Chat.ChatCompletionTool[] {
    return tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema
      }
    }))
  }
}
