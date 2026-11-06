import { ApiError, GoogleGenAI } from '@google/genai'
import type { Content, Part, FunctionDeclaration, Schema } from '@google/genai'
import { nanoid } from 'nanoid'
import { LLMAdapter, LLMError, ModelCapability, MediaPart, ModelInfo, StreamParams, StreamResult, ChatMessage, ToolDefinition, ToolCallInfo, renderTextPartsPrefix } from './types'
import { TEXT_EXTRACTABLE_MIMES } from './capabilityMimes'
import { createReport, toGeminiParameters } from './geminiSchema'
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

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com'
const GEMINI_API_VERSION = 'v1beta'

// Listing goes to the public REST endpoint directly (it predates the Gen AI
// SDK's `models.list()`, and its pages and filter are what the picker expects). Returns models filtered to those
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
  private genAI: GoogleGenAI
  private apiKey: string
  private providerId: string

  constructor(apiKey: string, providerId: string) {
    // The Gen AI client fills what the caller leaves unset from the process
    // environment: GOOGLE_GENAI_USE_VERTEXAI / _ENTERPRISE would send the turn
    // to a Google Cloud project, GOOGLE_GEMINI_BASE_URL to another host, and
    // GOOGLE_GENAI_API_VERSION changes the API. The credential row is the only
    // thing that decides what is sent and where, so every one is explicit —
    // the values the legacy SDK used, which read no environment at all.
    this.genAI = new GoogleGenAI({
      apiKey,
      vertexai: false,
      apiVersion: GEMINI_API_VERSION,
      httpOptions: { baseUrl: GEMINI_BASE_URL }
    })
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

    // Gemini takes the system prompt as `systemInstruction`, not in history.
    const systemPrompt = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n')
    const nonSystem = messages.filter((m) => m.role !== 'system')

    const { history, lastMessage } = this.convertMessages(nonSystem)

    let content = ''
    const toolCalls: ToolCallInfo[] = []

    // `models.generateContentStream`, not `chats`: a chat session validates
    // history to `user` / `model` roles and curates it, while this adapter
    // rebuilds the whole conversation every turn and sends tool results as
    // `function` turns — the same request the legacy SDK's chat sent.
    const stream = await this.genAI.models.generateContentStream({
      model,
      contents: [...history, lastMessage],
      config: {
        ...(tools ? { tools: [{ functionDeclarations: this.convertTools(tools) }] } : {}),
        ...(systemPrompt ? { systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] } } : {}),
        ...(signal ? { abortSignal: signal } : {})
      }
    })

    for await (const chunk of stream) {
      const parts = chunk.candidates?.[0]?.content?.parts ?? []
      for (const part of parts) {
        if (part.text) {
          content += part.text
          onDelta(part.text)
        }
        if (part.functionCall) {
          const fc = part.functionCall
          toolCalls.push({
            id: `gemini-${nanoid(10)}`,
            name: fc.name ?? '',
            input: (fc.args ?? {}) as Record<string, unknown>
          })
        }
      }
    }

    // The SDK hands the signal to fetch, whose body then errors on abort. Should
    // a version end the iteration quietly instead (as the OpenAI SDK does), a
    // cancelled turn must still reject rather than resolve with partial text.
    signal?.throwIfAborted()

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
    const msg = error instanceof ApiError ? describeApiError(error) : error.message
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
    lastMessage: Content
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
            parts.push({ functionCall: { name: tc.name, args: tc.input } })
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
          }]
        })
      }
    }

    // The newest message is sent as its own content. A tool result goes as a
    // `function` turn and anything else as a `user` turn — the roles the
    // legacy SDK's `sendMessageStream` assigned.
    const last = messages[messages.length - 1]
    let lastMessage: Content
    if (!last) {
      lastMessage = { role: 'user', parts: [{ text: '' }] }
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
      lastMessage = {
        role: 'function',
        parts: [{
          functionResponse: {
            name: last.toolName ?? '',
            response: responseObj
          }
        }]
      }
    } else if (last.role === 'user') {
      // The most recent user turn is where freshly-attached media lives:
      // native media first, then the text, with text attachments folded
      // into it via the shared prefix renderer.
      const mediaParts = this.buildInlineDataParts(last.media)
      const textPrefix = renderTextPartsPrefix(last.media)
      const userText = `${textPrefix}${last.content}`
      const parts: Part[] = [...mediaParts]
      if (userText || parts.length === 0) parts.push({ text: userText })
      lastMessage = { role: 'user', parts }
    } else {
      lastMessage = { role: 'user', parts: [{ text: last.content }] }
    }

    return { history, lastMessage }
  }

  private buildInlineDataParts(media: MediaPart[] | undefined): Part[] {
    if (!media || media.length === 0) return []
    const parts: Part[] = []
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
      const report = createReport()
      // `undefined` for a no-argument tool — Gemini rejects an object schema
      // with an empty `properties` map, so the field must be absent entirely.
      const parameters = toGeminiParameters(t.inputSchema, report)
      if (report.translated.length > 0 || report.dropped.length > 0) {
        logger.debug('schema sanitized', {
          tool: t.name,
          translated: report.translated,
          dropped: report.dropped
        })
      }
      return {
        name: t.name,
        description: t.description,
        ...(parameters ? { parameters: parameters as Schema } : {})
      }
    })
  }
}

/**
 * The legacy SDK's error text — `[429 Too Many Requests] <message> <details>`
 * — rebuilt from the Gen AI SDK's `ApiError`, whose message is the response
 * body as JSON. `parseError` reads the bracketed status and the "retry in Ns"
 * hint out of exactly that shape, and the user sees the API's own sentence
 * instead of a JSON blob when the status is not one it names.
 */
function describeApiError(error: ApiError): string {
  let message = error.message
  let status = ''
  try {
    // A mid-stream error frame arrives as `got status: <STATUS>. <body JSON>`.
    const body = JSON.parse(error.message.replace(/^got status: [^.]*\. /, '')) as { error?: { message?: unknown; status?: unknown; details?: unknown } }
    if (body.error && typeof body.error.message === 'string') {
      message = body.error.message
      if (body.error.details) message += ` ${JSON.stringify(body.error.details)}`
    }
    if (body.error && typeof body.error.status === 'string') status = body.error.status
  } catch {
    // Not JSON: keep the message whole.
  }
  return `[${error.status} ${status || 'Error'}] ${message}`
}
