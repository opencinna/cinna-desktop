import { GoogleGenerativeAI } from '@google/generative-ai'
import { LLMAdapter, LLMError, ModelInfo, StreamParams, StreamResult, ChatMessage, ToolDefinition, ToolCallInfo } from './types'
import type { Content, Part, FunctionCallPart, FunctionResponsePart } from '@google/generative-ai'

export class GeminiAdapter implements LLMAdapter {
  readonly providerType = 'gemini'
  private genAI: GoogleGenerativeAI
  private providerId: string

  constructor(apiKey: string, providerId: string) {
    this.genAI = new GoogleGenerativeAI(apiKey)
    this.providerId = providerId
  }

  async listModels(): Promise<ModelInfo[]> {
    const models = [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' }
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

    const genModel = this.genAI.getGenerativeModel({
      model,
      tools: tools ? [{ functionDeclarations: this.convertTools(tools) }] : undefined
    })

    const { history, lastMessage } = this.convertMessages(messages)
    const chat = genModel.startChat({ history })

    let content = ''
    const toolCalls: ToolCallInfo[] = []

    const result = await chat.sendMessageStream(lastMessage, { signal })

    for await (const chunk of result.stream) {
      const parts = chunk.candidates?.[0]?.content?.parts ?? []
      for (const part of parts) {
        if ('text' in part && part.text) {
          content += part.text
          onDelta(part.text)
        }
        if ('functionCall' in part && part.functionCall) {
          const fc = part.functionCall
          toolCalls.push({
            id: `gemini-${Date.now()}-${toolCalls.length}`,
            name: fc.name,
            input: (fc.args ?? {}) as Record<string, unknown>
          })
        }
      }
    }

    return { content, toolCalls }
  }

  parseError(error: Error): LLMError {
    const msg = error.message
    const statusMatch = msg.match(/\[(\d{3})\s+([^\]]+)\]/)
    if (statusMatch) {
      const code = parseInt(statusMatch[1])
      const retryMatch = msg.match(/retry in ([\d.]+)s/i)
      const retryHint = retryMatch ? ` — retry in ${Math.ceil(parseFloat(retryMatch[1]))}s` : ''
      switch (code) {
        case 429:
          return { short: `Rate limit exceeded${retryHint}`, detail: msg }
        case 401:
          return { short: 'Invalid API key', detail: msg }
        case 403:
          return { short: 'Access denied — check your Google AI plan', detail: msg }
        case 404:
          return { short: 'Model not found', detail: msg }
        case 500: case 502: case 503:
          return { short: 'Google AI server error — try again', detail: msg }
      }
    }
    if (msg.includes('GoogleGenerativeAIResponseError')) {
      const safetyMatch = msg.match(/SAFETY|RECITATION|BLOCKED/)
      if (safetyMatch) return { short: `Response blocked: ${safetyMatch[0].toLowerCase()}`, detail: msg }
    }
    return { short: msg.length > 120 ? msg.slice(0, 117) + '...' : msg, detail: msg }
  }

  private convertMessages(messages: ChatMessage[]): {
    history: Content[]
    lastMessage: string | Part[]
  } {
    const history: Content[] = []

    for (let i = 0; i < messages.length - 1; i++) {
      const msg = messages[i]
      if (msg.role === 'user') {
        history.push({ role: 'user', parts: [{ text: msg.content }] })
      } else if (msg.role === 'assistant') {
        const parts: Part[] = []
        if (msg.content) {
          parts.push({ text: msg.content })
        }
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            parts.push({
              functionCall: { name: tc.name, args: tc.input }
            } as FunctionCallPart)
          }
        }
        if (parts.length === 0) parts.push({ text: '' })
        history.push({ role: 'model', parts })
      } else if (msg.role === 'tool_call') {
        // Gemini requires functionResponse to have a plain object response
        let responseObj: Record<string, unknown>
        try {
          const parsed = JSON.parse(msg.content)
          if (Array.isArray(parsed)) {
            const text = parsed
              .map((block: { type?: string; text?: string }) =>
                block.type === 'text' ? block.text : JSON.stringify(block)
              )
              .join('\n')
            responseObj = { result: text }
          } else if (typeof parsed === 'object' && parsed !== null) {
            responseObj = parsed
          } else {
            responseObj = { result: msg.content }
          }
        } catch {
          responseObj = { result: msg.content }
        }
        history.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: msg.toolName ?? '',
              response: responseObj
            }
          } as FunctionResponsePart]
        })
      }
    }

    // Build lastMessage from the final message
    const last = messages[messages.length - 1]
    let lastMessage: string | Part[]
    if (!last) {
      lastMessage = ''
    } else if (last.role === 'tool_call') {
      let responseObj: Record<string, unknown>
      try {
        const parsed = JSON.parse(last.content)
        if (Array.isArray(parsed)) {
          const text = parsed
            .map((block: { type?: string; text?: string }) =>
              block.type === 'text' ? block.text : JSON.stringify(block)
            )
            .join('\n')
          responseObj = { result: text }
        } else if (typeof parsed === 'object' && parsed !== null) {
          responseObj = parsed
        } else {
          responseObj = { result: last.content }
        }
      } catch {
        responseObj = { result: last.content }
      }
      lastMessage = [{
        functionResponse: {
          name: last.toolName ?? '',
          response: responseObj
        }
      } as FunctionResponsePart]
    } else {
      lastMessage = last.content
    }

    return { history, lastMessage }
  }

  private convertTools(
    tools: ToolDefinition[]
  ): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema
    }))
  }
}
