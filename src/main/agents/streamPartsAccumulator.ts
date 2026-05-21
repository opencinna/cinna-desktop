/**
 * Accumulates A2A streaming text parts into a structured list, computing
 * per-part deltas and routing each delta to the renderer with its content kind.
 *
 * Each text Part may carry `metadata['cinna.content_kind']` ∈
 * {text, thinking, tool, tool_result}.
 *
 * - `tool` parts also carry `cinna.tool_name`, optional `cinna.tool_input`,
 *   and `cinna.tool_id` (pairing key).
 * - `tool_result` parts carry `cinna.tool_id` (matching the originating tool
 *   part) and `cinna.tool_stream` ∈ {stdout, stderr}.
 *
 * Merge rules:
 * - Consecutive `text` / `thinking` parts merge into one entry.
 * - Consecutive `tool` parts merge only when `toolName` matches.
 * - Consecutive `tool_result` parts merge only when `toolId` AND `toolStream`
 *   match — preserves interleaved stdout/stderr chronology as separate parts.
 *
 * `answerText()` returns concat of `text`-kind parts only — used as the
 * message preview/fallback content (`messages.content`).
 */
import type { ContentKind, MessagePart, ToolStream } from '../../shared/messageParts'

export const KIND_METADATA_KEY = 'cinna.content_kind'
export const TOOL_NAME_METADATA_KEY = 'cinna.tool_name'
export const TOOL_INPUT_METADATA_KEY = 'cinna.tool_input'
export const TOOL_ID_METADATA_KEY = 'cinna.tool_id'
export const TOOL_STREAM_METADATA_KEY = 'cinna.tool_stream'

const VALID_KINDS: readonly ContentKind[] = ['text', 'thinking', 'tool', 'tool_result'] as const
const VALID_STREAMS: readonly ToolStream[] = ['stdout', 'stderr'] as const

export interface PartLike {
  kind: string
  text?: string
  metadata?: Record<string, unknown> | null
}

export interface MessageLike {
  messageId: string
  parts: PartLike[]
}

export interface ArtifactLike {
  artifactId: string
  parts: PartLike[]
}

export interface DeltaPort {
  postMessage: (msg: unknown) => void
}

export function partKindOf(part: PartLike): ContentKind {
  const k = part.metadata?.[KIND_METADATA_KEY]
  if (typeof k === 'string' && (VALID_KINDS as readonly string[]).includes(k)) {
    return k as ContentKind
  }
  return 'text'
}

export function partToolNameOf(part: PartLike): string | undefined {
  const n = part.metadata?.[TOOL_NAME_METADATA_KEY]
  return typeof n === 'string' ? n : undefined
}

export function partToolInputOf(part: PartLike): Record<string, unknown> | undefined {
  const v = part.metadata?.[TOOL_INPUT_METADATA_KEY]
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>
  }
  return undefined
}

export function partToolIdOf(part: PartLike): string | undefined {
  const v = part.metadata?.[TOOL_ID_METADATA_KEY]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

export function partToolStreamOf(part: PartLike): ToolStream | undefined {
  const v = part.metadata?.[TOOL_STREAM_METADATA_KEY]
  if (typeof v === 'string' && (VALID_STREAMS as readonly string[]).includes(v)) {
    return v as ToolStream
  }
  return undefined
}

export interface StreamPartsAccumulatorOptions {
  /**
   * Called once per (part, name+input) pair the first time a tool part is
   * received with structured input metadata. Lets the host (IPC handler) log
   * a friendly tool-call summary alongside the raw event dump.
   */
  onToolCall?: (call: { partKey: string; name: string; input: Record<string, unknown> }) => void
}

export class StreamPartsAccumulator {
  private seenPartText = new Map<string, string>()
  private loggedToolCalls = new Set<string>()
  private parts: MessagePart[] = []
  private answer = ''
  private readonly opts: StreamPartsAccumulatorOptions

  constructor(opts: StreamPartsAccumulatorOptions = {}) {
    this.opts = opts
  }

  ingestMessage(message: MessageLike, port: DeltaPort): void {
    this.ingest(`msg:${message.messageId}`, message.parts, port)
  }

  ingestArtifact(artifact: ArtifactLike, port: DeltaPort): void {
    this.ingest(`art:${artifact.artifactId}`, artifact.parts, port)
  }

  private ingest(idPrefix: string, parts: PartLike[] | undefined, port: DeltaPort): void {
    if (!Array.isArray(parts)) return
    parts.forEach((part, idx) => {
      if (part.kind !== 'text' || typeof part.text !== 'string' || !part.text) return
      const key = `${idPrefix}:${idx}`
      const prior = this.seenPartText.get(key) ?? ''
      const text = part.text
      const delta = text.startsWith(prior) ? text.slice(prior.length) : text
      if (!delta) return
      this.seenPartText.set(key, text)
      const kind = partKindOf(part)
      const isTool = kind === 'tool'
      const isToolResult = kind === 'tool_result'
      const toolName = isTool ? partToolNameOf(part) : undefined
      const toolInput = isTool ? partToolInputOf(part) : undefined
      const toolId = isTool || isToolResult ? partToolIdOf(part) : undefined
      // Backend coerces unknown values to 'stdout' server-side; default here
      // covers the absent-metadata case so the renderer always has a stream label.
      const toolStream: ToolStream | undefined = isToolResult
        ? partToolStreamOf(part) ?? 'stdout'
        : undefined
      this.appendToList(kind, delta, toolName, toolInput, toolId, toolStream)
      port.postMessage({
        type: 'delta',
        kind,
        text: delta,
        toolName,
        toolInput,
        toolId,
        toolStream
      })

      if (toolName && toolInput && !this.loggedToolCalls.has(key)) {
        this.loggedToolCalls.add(key)
        this.opts.onToolCall?.({ partKey: key, name: toolName, input: toolInput })
      }
    })
  }

  private appendToList(
    kind: ContentKind,
    delta: string,
    toolName?: string,
    toolInput?: Record<string, unknown>,
    toolId?: string,
    toolStream?: ToolStream
  ): void {
    const last = this.parts[this.parts.length - 1]
    const sameKind = last && last.kind === kind
    const mergeable =
      sameKind &&
      (kind === 'tool_result'
        ? last.toolId === toolId && last.toolStream === toolStream
        : last.toolName === toolName)
    if (last && mergeable) {
      last.text += delta
      // Backend may attach `tool_input` / `tool_id` only on the first frame of
      // a part — preserve once captured rather than overwriting with undefined.
      if (toolInput && !last.toolInput) last.toolInput = toolInput
      if (toolId && !last.toolId) last.toolId = toolId
    } else {
      const next: MessagePart = { kind, text: delta }
      if (toolName) next.toolName = toolName
      if (toolInput) next.toolInput = toolInput
      if (toolId) next.toolId = toolId
      if (toolStream) next.toolStream = toolStream
      this.parts.push(next)
    }
    if (kind === 'text') this.answer += delta
  }

  snapshotParts(): MessagePart[] {
    return this.parts.slice()
  }

  answerText(): string {
    return this.answer
  }
}
