import { GoogleGenerativeAI } from '@google/generative-ai'
import { nanoid } from 'nanoid'
import { LLMAdapter, LLMError, ModelCapability, MediaPart, ModelInfo, StreamParams, StreamResult, ChatMessage, ToolDefinition, ToolCallInfo, renderTextPartsPrefix } from './types'
import type {
  Content,
  Part,
  InlineDataPart,
  FunctionCallPart,
  FunctionResponsePart,
  FunctionDeclaration,
  FunctionDeclarationSchema
} from '@google/generative-ai'
import { TEXT_EXTRACTABLE_MIMES } from './capabilityMimes'
import { createLogger } from '../logger/logger'

// Gemini accepts images and PDFs natively via `inlineData`. Office formats
// / CSV / code files go through the shared text extractor and land as a
// `<file>` prefix on the user message — same envelope as the other
// adapters use.
const GEMINI_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp']
const GEMINI_NATIVE_MIMES = [...GEMINI_IMAGE_MIMES, 'application/pdf']
const GEMINI_MAX_FILE = 20 * 1024 * 1024
const GEMINI_MAX_FILES = 16

/**
 * Gemini's 1.5 / 2.x families are multimodal. We assume "yes" for anything
 * matching `gemini-1.5*`, `gemini-2.*`, `gemini-pro-vision`, and the new
 * naming on `*-flash` / `*-pro`. Older `gemini-pro` (text-only) and any
 * non-Gemini id falls through to the empty capability.
 */
function geminiHasVision(modelId: string): boolean {
  const id = modelId.toLowerCase()
  if (id === 'gemini-pro') return false
  if (id.startsWith('gemini-1.5')) return true
  if (/^gemini-\d/.test(id)) return true
  if (id.includes('vision')) return true
  return false
}

const logger = createLogger('gemini')

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

    // Gemini accepts `systemInstruction` on model creation, not in history.
    const systemPrompt = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n')
    const nonSystem = messages.filter((m) => m.role !== 'system')

    const genModel = this.genAI.getGenerativeModel({
      model,
      tools: tools ? [{ functionDeclarations: this.convertTools(tools) }] : undefined,
      ...(systemPrompt ? { systemInstruction: systemPrompt } : {})
    })

    const { history, lastMessage } = this.convertMessages(nonSystem)
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

  modelCapability(modelId: string): ModelCapability {
    // Text-extracted attachments work on any Gemini model — the model only
    // needs to read text. Multimodal models additionally accept images and
    // PDFs as native `inlineData` parts.
    const vision = geminiHasVision(modelId)
    const accepted = vision
      ? [...GEMINI_NATIVE_MIMES, ...TEXT_EXTRACTABLE_MIMES]
      : [...TEXT_EXTRACTABLE_MIMES]
    const native = vision ? [...GEMINI_NATIVE_MIMES] : []
    return {
      acceptedMimeTypes: accepted,
      nativeMimeTypes: native,
      maxFileSizeBytes: GEMINI_MAX_FILE,
      maxFilesPerMessage: GEMINI_MAX_FILES
    }
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
        const parts: Part[] = []
        const mediaParts = this.buildInlineDataParts(msg.media)
        parts.push(...mediaParts)
        const textPrefix = renderTextPartsPrefix(msg.media)
        const userText = `${textPrefix}${msg.content}`
        if (userText || parts.length === 0) parts.push({ text: userText })
        history.push({ role: 'user', parts })
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
          role: 'function',
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
    } else if (last.role === 'user') {
      // The most recent user turn is where freshly-attached media lives.
      // Gemini's `sendMessageStream` accepts either a string or a Part[],
      // so we promote to Part[] only when native media is present; text
      // attachments fold into the user's string content via the shared
      // prefix renderer.
      const mediaParts = this.buildInlineDataParts(last.media)
      const textPrefix = renderTextPartsPrefix(last.media)
      const userText = `${textPrefix}${last.content}`
      if (mediaParts.length > 0) {
        const parts: Part[] = [...mediaParts]
        if (userText) parts.push({ text: userText })
        lastMessage = parts
      } else {
        lastMessage = userText
      }
    } else {
      lastMessage = last.content
    }

    return { history, lastMessage }
  }

  private buildInlineDataParts(media: MediaPart[] | undefined): InlineDataPart[] {
    if (!media || media.length === 0) return []
    const parts: InlineDataPart[] = []
    for (const part of media) {
      // Both images and PDFs ship as `inlineData` parts. Text-kind parts
      // never reach this branch — they fold into the user's string content
      // via the shared text-prefix renderer.
      if (part.kind === 'image' && GEMINI_IMAGE_MIMES.includes(part.mimeType)) {
        parts.push({
          inlineData: {
            mimeType: part.mimeType,
            data: part.bytes.toString('base64')
          }
        })
      } else if (part.kind === 'document' && part.mimeType === 'application/pdf') {
        parts.push({
          inlineData: {
            mimeType: part.mimeType,
            data: part.bytes.toString('base64')
          }
        })
      }
    }
    return parts
  }

  private convertTools(tools: ToolDefinition[]): FunctionDeclaration[] {
    return tools.map((t) => {
      const dropped: string[] = []
      const parameters = sanitizeForGemini(t.inputSchema, dropped)
      if (dropped.length > 0) {
        logger.debug('schema sanitized', { tool: t.name, dropped })
      }
      return {
        name: t.name,
        description: t.description,
        parameters: parameters as unknown as FunctionDeclarationSchema
      }
    })
  }
}

// Gemini's `function_declarations.parameters` accepts only a narrow OpenAPI-3
// subset and rejects standard JSON-Schema keywords that MCP servers commonly
// emit. Anthropic and OpenAI tolerate them; Gemini hard-fails the whole
// request ("Unknown name … Cannot find field"). Walk the schema and drop
// the unsupported keys.
//
// `exclusiveMinimum` / `exclusiveMaximum` deserve special note: in JSON
// Schema 2020-12 they're numeric (`exclusiveMinimum: 0`), but Gemini's
// schema follows OpenAPI 3.0 where they're booleans alongside
// `minimum`/`maximum`. Different shapes => safest fix is to drop them.
const GEMINI_DROP_KEYS = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'definitions',
  'additionalProperties',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'patternProperties',
  'examples',
  '$comment'
])

function sanitizeForGemini(schema: unknown, dropped: string[] = []): unknown {
  if (Array.isArray(schema)) return schema.map((s) => sanitizeForGemini(s, dropped))
  if (!schema || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (GEMINI_DROP_KEYS.has(k)) {
      if (!dropped.includes(k)) dropped.push(k)
      continue
    }
    out[k] = sanitizeForGemini(v, dropped)
  }
  return out
}
