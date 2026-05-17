/**
 * Accumulates A2A streaming text parts into a structured list, computing
 * per-part deltas and routing each delta to the renderer with its content kind.
 *
 * Each text Part may carry `metadata['cinna.content_kind']` ∈ {text, thinking, tool}
 * and, for `tool` kind, `metadata['cinna.tool_name']`. These metadata keys are
 * the contract with the Cinna backend (see `a2a_event_mapper.py`).
 *
 * Consecutive parts merge into a single accumulated entry only when both kind
 * and toolName match, so narration about tool A and tool B stay as separate
 * persisted parts.
 *
 * `answerText()` returns concat of `text`-kind parts only — used as the message
 * preview/fallback content (`messages.content`).
 */
import type { ContentKind, MessagePart } from '../../shared/messageParts'

export const KIND_METADATA_KEY = 'cinna.content_kind'
export const TOOL_NAME_METADATA_KEY = 'cinna.tool_name'
export const TOOL_INPUT_METADATA_KEY = 'cinna.tool_input'

const VALID_KINDS: readonly ContentKind[] = ['text', 'thinking', 'tool'] as const

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
      const toolName = kind === 'tool' ? partToolNameOf(part) : undefined
      const toolInput = kind === 'tool' ? partToolInputOf(part) : undefined
      this.appendToList(kind, delta, toolName, toolInput)
      port.postMessage({ type: 'delta', kind, text: delta, toolName, toolInput })

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
    toolInput?: Record<string, unknown>
  ): void {
    const last = this.parts[this.parts.length - 1]
    if (last && last.kind === kind && last.toolName === toolName) {
      last.text += delta
      // Backend may attach `tool_input` only on the first frame of a part —
      // preserve it once captured rather than overwriting with undefined later.
      if (toolInput && !last.toolInput) last.toolInput = toolInput
    } else {
      const next: MessagePart = { kind, text: delta }
      if (toolName) next.toolName = toolName
      if (toolInput) next.toolInput = toolInput
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
