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

export class StreamPartsAccumulator {
  private seenPartText = new Map<string, string>()
  private parts: MessagePart[] = []
  private answer = ''

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
      this.appendToList(kind, delta, toolName)
      port.postMessage({ type: 'delta', kind, text: delta, toolName })
    })
  }

  private appendToList(kind: ContentKind, delta: string, toolName?: string): void {
    const last = this.parts[this.parts.length - 1]
    if (last && last.kind === kind && last.toolName === toolName) {
      last.text += delta
    } else {
      this.parts.push(toolName ? { kind, text: delta, toolName } : { kind, text: delta })
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
