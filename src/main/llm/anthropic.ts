import Anthropic from '@anthropic-ai/sdk'
import { LLMAdapter, LLMError, ModelCapability, MediaPart, ModelInfo, NO_FILE_SUPPORT, StreamParams, StreamResult, ChatMessage, ToolDefinition, ToolCallInfo, renderTextPartsPrefix } from './types'
import { TEXT_EXTRACTABLE_MIMES } from './capabilityMimes'

// All Claude 3+ models accept image inputs natively and PDFs as native
// `document` blocks. Office formats / CSV / code files go through the
// text extractor; the model sees an inlined `<file>` block in the user
// message. 32MB is Anthropic's published per-document limit; we allow up
// to that for PDFs and 8MB for images / text-source attachments.
const ANTHROPIC_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const ANTHROPIC_NATIVE_MIMES = [...ANTHROPIC_IMAGE_MIMES, 'application/pdf']
const ANTHROPIC_MAX_FILE = 32 * 1024 * 1024
const ANTHROPIC_MAX_FILES = 20

function anthropicMediaType(
  mime: string
): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  switch (mime) {
    case 'image/png':
    case 'image/jpeg':
    case 'image/gif':
    case 'image/webp':
      return mime
    default:
      return null
  }
}

export class AnthropicAdapter implements LLMAdapter {
  readonly providerType = 'anthropic'
  private client: Anthropic
  private providerId: string

  constructor(apiKey: string, providerId: string) {
    this.client = new Anthropic({ apiKey })
    this.providerId = providerId
  }

  async listModels(): Promise<ModelInfo[]> {
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
  }

  async stream(params: StreamParams): Promise<StreamResult> {
    const { model, messages, tools, signal, onDelta } = params

    // Anthropic accepts `system` as a top-level field, not as a message.
    // Concatenate all `role: 'system'` entries; the remainder becomes history.
    const systemPrompt = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n')
    const nonSystem = messages.filter((m) => m.role !== 'system')
    const currentMessages = this.convertMessages(nonSystem)
    const anthropicTools = tools ? this.convertTools(tools) : undefined

    let content = ''
    const toolCalls: ToolCallInfo[] = []

    const stream = this.client.messages.stream({
      model,
      max_tokens: 8192,
      messages: currentMessages,
      tools: anthropicTools,
      ...(systemPrompt ? { system: systemPrompt } : {})
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

  modelCapability(modelId: string): ModelCapability {
    // Claude 3+ models accept images + PDFs natively. Older `claude-2` /
    // `claude-instant` families predate the multimodal API, but they still
    // benefit from text-extracted attachments (CSV, code, office), so we
    // return a text-only capability for them rather than NO_FILE_SUPPORT.
    const id = modelId.toLowerCase()
    const isLegacy = id.startsWith('claude-2') || id.startsWith('claude-instant')
    if (isLegacy) {
      return {
        acceptedMimeTypes: [...TEXT_EXTRACTABLE_MIMES],
        nativeMimeTypes: [],
        maxFileSizeBytes: ANTHROPIC_MAX_FILE,
        maxFilesPerMessage: ANTHROPIC_MAX_FILES
      }
    }
    return {
      acceptedMimeTypes: [...ANTHROPIC_NATIVE_MIMES, ...TEXT_EXTRACTABLE_MIMES],
      nativeMimeTypes: [...ANTHROPIC_NATIVE_MIMES],
      maxFileSizeBytes: ANTHROPIC_MAX_FILE,
      maxFilesPerMessage: ANTHROPIC_MAX_FILES
    }
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
        const mediaBlocks = this.buildMediaBlocks(msg.media)
        // Extracted-text attachments become a labeled prefix on the user's
        // own message — shared format across providers so the LLM sees a
        // consistent `<file>…</file>` envelope regardless of source.
        const textPrefix = renderTextPartsPrefix(msg.media)
        const userText = `${textPrefix}${msg.content}`
        if (mediaBlocks.length > 0) {
          const content: Anthropic.Messages.ContentBlockParam[] = [...mediaBlocks]
          if (userText) content.push({ type: 'text', text: userText })
          result.push({ role: 'user', content })
        } else {
          result.push({ role: 'user', content: userText })
        }
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

  private buildMediaBlocks(media: MediaPart[] | undefined): Anthropic.Messages.ContentBlockParam[] {
    if (!media || media.length === 0) return []
    const blocks: Anthropic.Messages.ContentBlockParam[] = []
    for (const part of media) {
      if (part.kind === 'image') {
        const mediaType = anthropicMediaType(part.mimeType)
        if (!mediaType) continue
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: part.bytes.toString('base64')
          }
        })
      } else if (part.kind === 'document' && part.mimeType === 'application/pdf') {
        // Anthropic's native PDF support: `document` content block with
        // base64-encoded bytes. The model receives both text + visual
        // content per page — the right path for layout-sensitive PDFs.
        blocks.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: part.bytes.toString('base64')
          }
        })
      }
    }
    return blocks
  }

  private convertTools(tools: ToolDefinition[]): Anthropic.Messages.Tool[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Messages.Tool.InputSchema
    }))
  }
}
