import OpenAI from 'openai'
import { LLMAdapter, LLMError, ModelCapability, MediaPart, ModelInfo, StreamParams, StreamResult, ChatMessage, ToolDefinition, ToolCallInfo, renderTextPartsPrefix } from './types'
import { TEXT_EXTRACTABLE_MIMES } from './capabilityMimes'

// OpenAI Chat Completions accepts images natively. PDFs and office formats
// have no native input block here (the Responses API does, but we use
// Chat Completions), so they route through the text extractor and arrive
// as inlined `<file>` blocks on the user message.
const OPENAI_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const OPENAI_MAX_FILE = 20 * 1024 * 1024
const OPENAI_MAX_FILES = 10

/**
 * Which OpenAI model families accept images. We err on the side of "yes" for
 * `gpt-4*` and `o*` (modern multimodal lineup) and "no" for everything else
 * — older `gpt-3.5*` and the embedding/audio side-channels return the empty
 * capability so the UI hides the attach button.
 */
function openaiHasVision(modelId: string): boolean {
  const id = modelId.toLowerCase()
  if (/^gpt-4/.test(id)) return true
  if (/^o\d/.test(id)) return true
  if (/^chatgpt-4/.test(id)) return true
  return false
}

// Modality / capability flags that disqualify a model from text chat.
// Substring match (case-insensitive) on the model id.
const NON_CHAT_TOKENS = [
  'embedding',
  'whisper',
  'tts',
  'dall-e',
  'image',
  'moderation',
  'audio',
  'realtime',
  'transcribe',
  'search',
  'computer-use',
  'omni-moderation'
]

function isChatCapableId(id: string): boolean {
  if (id.startsWith('ft:')) return false
  if (id.startsWith('text-') || id.startsWith('davinci-') || id.startsWith('babbage-')) return false
  if (/-instruct(\b|-)/i.test(id)) return false
  const lower = id.toLowerCase()
  if (NON_CHAT_TOKENS.some((t) => lower.includes(t))) return false
  // Keep the gpt-*, o<digit>-*, and chatgpt-* families.
  return /^gpt-/i.test(id) || /^o\d/i.test(id) || /^chatgpt-/i.test(id)
}

// Best-effort humanization of an OpenAI model id — the SDK doesn't return a
// display name, so we tokenize the id into something readable. New model
// families fall through cleanly because we don't enumerate versions.
function humanizeOpenAIName(id: string): string {
  const parts = id.split('-').map((p) => {
    const lower = p.toLowerCase()
    if (lower === 'gpt') return 'GPT'
    if (lower === 'chatgpt') return 'ChatGPT'
    if (/^o\d+$/i.test(p)) return p
    if (/^\d/.test(p)) return p
    return p.charAt(0).toUpperCase() + p.slice(1)
  })
  if (parts.length <= 2) return parts.join('-')
  // First two segments stay glued (e.g. "GPT-4o"), the rest become spaced
  // descriptors (e.g. "Mini", "Turbo").
  return parts[0] + '-' + parts[1] + ' ' + parts.slice(2).join(' ')
}

export class OpenAIAdapter implements LLMAdapter {
  readonly providerType = 'openai'
  private client: OpenAI
  private providerId: string

  constructor(apiKey: string, providerId: string) {
    this.client = new OpenAI({ apiKey })
    this.providerId = providerId
  }

  async listModels(): Promise<ModelInfo[]> {
    const collected: { id: string; created: number }[] = []
    for await (const m of this.client.models.list()) {
      if (isChatCapableId(m.id)) {
        collected.push({ id: m.id, created: m.created ?? 0 })
      }
    }
    // Newest first so the picker surfaces current models without us
    // hardcoding a "preferred" order that goes stale.
    collected.sort((a, b) => b.created - a.created)
    return collected.map((m) => ({
      id: m.id,
      name: humanizeOpenAIName(m.id),
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

  modelCapability(modelId: string): ModelCapability {
    // Even non-vision models benefit from text-extracted attachments —
    // CSV, code, office docs can be inlined into the prompt regardless of
    // multimodal support. Only vision-capable models additionally accept
    // image MIMEs natively.
    const vision = openaiHasVision(modelId)
    const accepted = vision
      ? [...OPENAI_IMAGE_MIMES, ...TEXT_EXTRACTABLE_MIMES]
      : [...TEXT_EXTRACTABLE_MIMES]
    const native = vision ? [...OPENAI_IMAGE_MIMES] : []
    return {
      acceptedMimeTypes: accepted,
      nativeMimeTypes: native,
      maxFileSizeBytes: OPENAI_MAX_FILE,
      maxFilesPerMessage: OPENAI_MAX_FILES
    }
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
      if (msg.role === 'system') {
        result.push({ role: 'system', content: msg.content })
      } else if (msg.role === 'user') {
        const imageParts = this.buildImageParts(msg.media)
        const textPrefix = renderTextPartsPrefix(msg.media)
        const userText = `${textPrefix}${msg.content}`
        if (imageParts.length > 0) {
          const parts: OpenAI.Chat.ChatCompletionContentPart[] = [...imageParts]
          if (userText) parts.unshift({ type: 'text', text: userText })
          result.push({ role: 'user', content: parts })
        } else {
          result.push({ role: 'user', content: userText })
        }
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

  private buildImageParts(
    media: MediaPart[] | undefined
  ): OpenAI.Chat.ChatCompletionContentPartImage[] {
    if (!media || media.length === 0) return []
    const parts: OpenAI.Chat.ChatCompletionContentPartImage[] = []
    for (const part of media) {
      if (part.kind !== 'image') continue
      if (!OPENAI_IMAGE_MIMES.includes(part.mimeType)) continue
      parts.push({
        type: 'image_url',
        image_url: {
          url: `data:${part.mimeType};base64,${part.bytes.toString('base64')}`
        }
      })
    }
    return parts
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
