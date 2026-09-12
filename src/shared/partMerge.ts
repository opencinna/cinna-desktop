/**
 * When a streamed fragment continues the last part instead of starting one.
 *
 * One rule, three callers: the main-process `StreamPartsAccumulator` (what is
 * persisted), and the renderer store's live blocks and live agent sub-threads.
 * They were three hand-kept copies, and a transcript that streams one way and
 * reloads another is exactly the drift three copies produce.
 *
 * Pure function, no runtime imports: shared by both Electron processes.
 */
import type { ContentKind, ToolStream } from './messageParts'

export interface PartMergeKey {
  kind: ContentKind
  toolName?: string
  toolId?: string
  toolStream?: ToolStream
}

/**
 * - Different kinds never merge.
 * - `file` never merges: two attachments are two badges.
 * - `tool_result` merges on `toolId` **and** `toolStream`, so interleaved
 *   stdout/stderr keep their chronology as separate parts.
 * - Everything else merges on `toolName` — and a `tool` part also refuses to
 *   merge when both sides name **different** `toolId`s. Two calls to one tool
 *   are two calls. Before this, two back-to-back permission asks (same reserved
 *   name, different `per_` ids) folded into one block, and the second ask's id —
 *   the address its answer is posted to — never reached the renderer, leaving
 *   that ask parked until its timeout. A fragment with no id still continues
 *   the part before it: an A2A backend may send `cinna.tool_id` on the first
 *   frame of a part only.
 */
export function continuesPart(last: PartMergeKey, next: PartMergeKey): boolean {
  if (last.kind !== next.kind || next.kind === 'file') return false
  if (next.kind === 'tool_result') {
    return last.toolId === next.toolId && last.toolStream === next.toolStream
  }
  if (last.toolName !== next.toolName) return false
  if (next.kind === 'tool' && last.toolId && next.toolId) return last.toolId === next.toolId
  return true
}

/** Stable tool identity survives intervening permission and decision blocks.
 * Results retain their append order so stdout/stderr chronology is preserved.
 */
export function continuingPartIndex(parts: readonly (PartMergeKey | undefined)[], next: PartMergeKey): number {
  if (next.kind === 'tool' && next.toolId) {
    const index = parts.findIndex((part) => part?.kind === 'tool' && part.toolId === next.toolId && continuesPart(part, next))
    if (index >= 0) return index
  }
  const index = parts.length - 1
  return parts[index] && continuesPart(parts[index]!, next) ? index : -1
}
