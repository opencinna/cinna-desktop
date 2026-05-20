export interface ModelInfo {
  id: string
  name: string
  providerId: string
  providerType: string
}

export interface ToolCallInfo {
  id: string
  name: string
  input: Record<string, unknown>
}

/**
 * Resolved attachment ready for an adapter to translate into a
 * provider-native content block. Three flavors:
 *
 *  - `image` — raster image bytes (PNG/JPEG/GIF/WebP). Goes to the provider's
 *    image content block.
 *  - `document` — bytes that the provider accepts natively as a document
 *    block (today: PDF for Anthropic and Gemini). Adapters whose model
 *    *doesn't* natively accept the document MIME never see this variant —
 *    the resolver converts those to a `text` part via the extractor.
 *  - `text` — UTF-8 text content. May be the raw file (`.csv`, `.json`,
 *    `.md`, …) or text extracted from a binary document (`.docx`, `.xlsx`,
 *    or a PDF on a provider without native PDF support). Adapters render
 *    these as a labeled prefix on the user message.
 *
 * Adapters never know where bytes came from — the FileStore + extractor
 * layer hides the source/format complexity behind these three variants.
 */
export type MediaPart =
  | { kind: 'image'; mimeType: string; bytes: Buffer; filename?: string }
  | { kind: 'document'; mimeType: string; bytes: Buffer; filename?: string }
  | { kind: 'text'; mimeType: string; text: string; filename?: string }

/**
 * Per-(provider, model) declaration of what file types the model accepts.
 * Pure function — no I/O — so it can be called freely from IPC handlers
 * for UI gating and from `convertMessages` for send-time filtering.
 *
 * `acceptedMimeTypes` is the union of types the model can take after
 * upstream transformation (e.g. office files always go through text
 * extraction). `nativeMimeTypes` is the subset of `acceptedMimeTypes`
 * whose bytes pass through unchanged — anything not in this subset is
 * routed through the text extractor before reaching the adapter.
 */
export interface ModelCapability {
  acceptedMimeTypes: string[]
  nativeMimeTypes: string[]
  maxFileSizeBytes: number
  maxFilesPerMessage: number
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool_call' | 'system'
  content: string
  /**
   * Resolved media for user turns. Adapters that don't support media just
   * ignore this field; adapters that do route it through the model's native
   * content-block API. Pre-filtered to the active model's accepted MIME
   * types so the adapter never has to make that decision.
   */
  media?: MediaPart[]
  toolCalls?: ToolCallInfo[]
  toolCallId?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolError?: boolean
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  mcpProviderId: string
}

export interface ToolUseEvent {
  id: string
  name: string
  input: Record<string, unknown>
  mcpProviderId: string
}

export interface StreamResult {
  content: string
  toolCalls: ToolCallInfo[]
}

export interface StreamParams {
  model: string
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  signal?: AbortSignal
  onDelta: (text: string) => void
}

export interface LLMError {
  short: string
  detail: string
}

export interface LLMAdapter {
  readonly providerType: string
  listModels(): Promise<ModelInfo[]>
  stream(params: StreamParams): Promise<StreamResult>
  parseError(error: Error): LLMError
  /**
   * Declares which MIME types and file-size envelope the given model
   * accepts, and which subset is consumed as raw bytes vs text-extracted.
   * Empty `acceptedMimeTypes` ⇒ no file support; UI hides the attach
   * button. Implementations are pure — safe to call from IPC handlers.
   */
  modelCapability(modelId: string): ModelCapability
}

/** Empty capability — used by adapters as the "no file support" default. */
export const NO_FILE_SUPPORT: ModelCapability = {
  acceptedMimeTypes: [],
  nativeMimeTypes: [],
  maxFileSizeBytes: 0,
  maxFilesPerMessage: 0
}

/**
 * Render a user message's text-kind media as an inlined preface. Shared
 * across adapters so the wire format users see is consistent — XML-style
 * `<file>` blocks with a filename + mime hint, separated from the user's
 * actual message by a blank line.
 *
 * Adapters call this when building the user content, then concatenate the
 * user's own text. `image` and `document` parts are handled separately via
 * provider-native blocks and are *not* rendered here.
 */
export function renderTextPartsPrefix(media: MediaPart[] | undefined): string {
  if (!media || media.length === 0) return ''
  const blocks: string[] = []
  for (const part of media) {
    if (part.kind !== 'text') continue
    const name = part.filename ?? 'attached'
    blocks.push(
      `<file name="${name}" type="${part.mimeType}">\n${part.text}\n</file>`
    )
  }
  if (blocks.length === 0) return ''
  return blocks.join('\n\n') + '\n\n'
}
