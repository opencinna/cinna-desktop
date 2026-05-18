import { GoogleGenerativeAI } from '@google/generative-ai'
import { nanoid } from 'nanoid'
import { LLMAdapter, LLMError, ModelInfo, StreamParams, StreamResult, ChatMessage, ToolDefinition, ToolCallInfo } from './types'
import type {
  Content,
  Part,
  FunctionCallPart,
  FunctionResponsePart,
  FunctionDeclaration,
  FunctionDeclarationSchema
} from '@google/generative-ai'

// The `@google/generative-ai` SDK doesn't expose a list-models call, so we
// hit the public REST endpoint directly. Returns models filtered to those
// that support `generateContent` (i.e. usable for text chat).
interface GeminiRestModel {
  name: string // "models/<id>"
  displayName?: string
  supportedGenerationMethods?: string[]
}

interface GeminiListModelsResponse {
  models?: GeminiRestModel[]
  nextPageToken?: string
}

async function fetchGeminiModels(apiKey: string): Promise<GeminiRestModel[]> {
  const base = 'https://generativelanguage.googleapis.com/v1beta/models'
  const collected: GeminiRestModel[] = []
  let pageToken: string | undefined
  for (let i = 0; i < 5; i++) {
    const url = new URL(base)
    url.searchParams.set('key', apiKey)
    url.searchParams.set('pageSize', '100')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const res = await fetch(url.toString())
    if (!res.ok) {
      // Use the bracketed status format that parseError() recognizes so the
      // listModels error path produces the same friendly messages as the
      // streaming path (401 → "Invalid API key", 429 → "Rate limit exceeded", etc.)
      throw new Error(`Gemini list-models failed [${res.status} ${res.statusText}]`)
    }
    const data = (await res.json()) as GeminiListModelsResponse
    if (data.models) collected.push(...data.models)
    if (!data.nextPageToken) break
    pageToken = data.nextPageToken
  }
  return collected
}

export class GeminiAdapter implements LLMAdapter {
  readonly providerType = 'gemini'
  private genAI: GoogleGenerativeAI
  private apiKey: string
  private providerId: string

  constructor(apiKey: string, providerId: string) {
    this.genAI = new GoogleGenerativeAI(apiKey)
    this.apiKey = apiKey
    this.providerId = providerId
  }

  async listModels(): Promise<ModelInfo[]> {
    let raw: GeminiRestModel[]
    try {
      raw = await fetchGeminiModels(this.apiKey)
    } catch (err) {
      // Route through parseError so the user sees the same friendly copy as
      // the chat-stream path ("Invalid API key" instead of "401 Unauthorized").
      const mapped = this.parseError(err instanceof Error ? err : new Error(String(err)))
      throw new Error(mapped.short)
    }
    return raw
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => ({
        id: m.name.replace(/^models\//, ''),
        name: m.displayName ?? m.name.replace(/^models\//, ''),
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
            id: `gemini-${nanoid(10)}`,
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

  private convertTools(tools: ToolDefinition[]): FunctionDeclaration[] {
    // MCP tool inputSchemas are JSON Schema objects (`{ type: 'object', properties: {...} }`)
    // which match Gemini's FunctionDeclarationSchema shape at runtime; we cast to satisfy
    // the stricter compile-time interface.
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as unknown as FunctionDeclarationSchema
    }))
  }
}
