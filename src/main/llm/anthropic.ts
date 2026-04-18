import Anthropic from '@anthropic-ai/sdk'
import { LLMAdapter, LLMError, ModelInfo, StreamParams, StreamResult, ChatMessage, ToolDefinition, ToolCallInfo } from './types'
import { createLogger } from '../logger/logger'

const logger = createLogger('Anthropic')

export class AnthropicAdapter implements LLMAdapter {
  readonly providerType = 'anthropic'
  private client: Anthropic
  private providerId: string

  constructor(apiKey: string, providerId: string) {
    this.client = new Anthropic({ apiKey })
    this.providerId = providerId
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const models: ModelInfo[] = []
      for await (const model of this.client.beta.models.list()) {
        models.push({
          id: model.id,
          name: model.display_name,
          providerId: this.providerId,
          providerType: this.providerType
        })
      }
      return models
    } catch (err) {
      // Fallback if the beta models endpoint is unavailable — log so the user
      // can see the real reason in the logger overlay.
      logger.warn('listModels via beta endpoint failed; using hardcoded fallback', {
        providerId: this.providerId,
        error: err instanceof Error ? err.message : String(err)
      })
      return [
        { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
        { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' }
      ].map((m) => ({
        id: m.id,
        name: m.name,
        providerId: this.providerId,
        providerType: this.providerType
      }))
    }
  }

  async stream(params: StreamParams): Promise<StreamResult> {
    const { model, messages, tools, signal, onDelta } = params

    const currentMessages = this.convertMessages(messages)
    const anthropicTools = tools ? this.convertTools(tools) : undefined

    let content = ''
    const toolCalls: ToolCallInfo[] = []

    const stream = this.client.messages.stream({
      model,
      max_tokens: 8192,
      messages: currentMessages,
      tools: anthropicTools
    }, { signal })

    stream.on('text', (text) => {
      content += text
      onDelta(text)
    })

    stream.on('contentBlock', (block) => {
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>
        })
      }
    })

    await stream.finalMessage()

    return { content, toolCalls }
  }

  parseError(error: Error): LLMError {
    const msg = error.message
    // Anthropic SDK throws APIError with status property
    const err = error as Error & { status?: number }
    const code = err.status
    if (code) {
      switch (code) {
        case 429:
          return { short: 'Rate limit exceeded — try again shortly', detail: msg }
        case 401:
          return { short: 'Invalid Anthropic API key', detail: msg }
        case 403:
          return { short: 'Access denied — check your Anthropic plan', detail: msg }
        case 404:
          return { short: 'Model not found', detail: msg }
        case 529:
          return { short: 'Anthropic API overloaded — try again', detail: msg }
        case 500: case 502: case 503:
          return { short: 'Anthropic server error — try again', detail: msg }
      }
    }
    if (msg.includes('credit') || msg.includes('billing')) {
      return { short: 'Billing issue — check your Anthropic account', detail: msg }
    }
    return { short: msg.length > 120 ? msg.slice(0, 117) + '...' : msg, detail: msg }
  }

  private convertMessages(messages: ChatMessage[]): Anthropic.Messages.MessageParam[] {
    const result: Anthropic.Messages.MessageParam[] = []

    for (const msg of messages) {
      if (msg.role === 'user') {
        result.push({ role: 'user', content: msg.content })
      } else if (msg.role === 'assistant') {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          const content: Anthropic.Messages.ContentBlockParam[] = []
          if (msg.content) {
            content.push({ type: 'text', text: msg.content })
          }
          for (const tc of msg.toolCalls) {
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.input
            })
          }
          result.push({ role: 'assistant', content })
        } else {
          result.push({ role: 'assistant', content: msg.content })
        }
      } else if (msg.role === 'tool_call') {
        result.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.toolCallId ?? '',
              content: msg.content,
              is_error: msg.toolError
            }
          ]
        })
      }
    }

    return result
  }

  private convertTools(tools: ToolDefinition[]): Anthropic.Messages.Tool[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Messages.Tool.InputSchema
    }))
  }
}
